import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// SB_WORKERS with the embedded transport: SQLite-backed bindings across worker processes. Needs
// standalone binaries of the fixtures under test/fixtures/workers, which a standalone build makes
// (`sproutboat build --standalone`, from a CLI checkout whose @sproutboat packages are this repo's):
//
//   SB_WORKERS_BINARIES=<dir holding workers-app, workers-do and workers-queue> \
//     bun packages/runtime/test/native-workers-embedded.ts
//
// Without it this prints a skip, so the script is safe to list among the native tests.
//
// Covers: concurrent D1 writes from every worker lose and duplicate no rows and surface no SQLITE_BUSY
// (single statements and batches, a store created by several workers at once); KV from every worker;
// cron fires once per minute, not once per worker; an app with Durable Objects or a queue consumer, or
// SB_LTX_ENABLE=1, runs one worker; SB_WORKERS=1 is the plain single process.
const dir = process.env.SB_WORKERS_BINARIES;
if (!dir) {
  console.log("Native workers (embedded): skipped, SB_WORKERS_BINARIES is not set");
  process.exit(0);
}
const linux = process.platform === "linux";

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}
function children(pid: number): number[] {
  if (existsSync("/proc/self/stat")) {
    // Linux without procps: the parent pid is the fourth field of /proc/<pid>/stat, after the command in parentheses.
    const found: number[] = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) === pid) found.push(Number(entry));
      } catch {
        // the process ended
      }
    }
    return found.sort((a, b) => a - b);
  }
  const out = Bun.spawnSync(["pgrep", "-P", String(pid)])
    .stdout.toString()
    .trim();
  return out === ""
    ? []
    : out
        .split("\n")
        .map(Number)
        .sort((a, b) => a - b);
}
async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined | false> | T | undefined | false) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

const work = await mkdtemp(join(tmpdir(), "sb-native-workers-embedded-"));
const running: Array<ReturnType<typeof Bun.spawn>> = [];
async function start(binary: string, env: Record<string, string>) {
  const port = freePort();
  const data = await mkdtemp(join(work, "data-"));
  const server = Bun.spawn([join(dir!, binary)], {
    cwd: work,
    env: { ...process.env, PORT: String(port), SB_DATA_DIR: data, ...env },
    stdout: "ignore",
    stderr: "pipe",
  });
  running.push(server);
  const log = new Response(server.stderr).text();
  await until("the binary to answer", 20000, async () => {
    if (server.exitCode !== null) throw new Error(`${binary} exited with ${server.exitCode}: ${await log}`);
    return fetch(`http://127.0.0.1:${port}/who`, { signal: AbortSignal.timeout(500) }).then(
      () => true,
      () => false,
    );
  });
  return { server, port, log, base: `http://127.0.0.1:${port}` };
}
async function stop(server: ReturnType<typeof Bun.spawn>) {
  server.kill("SIGTERM");
  await server.exited;
}
async function storm(base: string, path: string, total: number, concurrency: number, prefix = path) {
  let next = 0;
  const failures: string[] = [];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const i = next++;
        if (i >= total) return;
        const r = await fetch(`${base}/${path}?id=${prefix}-${i}&k=${prefix}-${i}`, {
          headers: { connection: "close" },
        });
        const body = await r.text();
        if (r.status !== 200) failures.push(`${r.status} ${body.slice(0, 160)}`);
      }
    }),
  );
  return failures;
}
// SAFETY: the fixture app answers /count with exactly this JSON.
const count = async (base: string) =>
  (await (await fetch(`${base}/count`)).json()) as {
    n: number;
    d: number;
    crons: number;
    cronMinutes: number;
    per: { w: string; n: number }[];
  };

try {
  // Four workers writing at once to a database that does not exist yet.
  {
    const { server, base } = await start("workers-app", { SB_WORKERS: "4" });
    await until("four workers", 20000, () => children(server.pid).length === 4);
    assert.deepEqual(await storm(base, "write", 4000, 64), [], "no write failed (no SQLITE_BUSY surfaced)");
    const after = await count(base);
    assert.equal(after.n, 4000, "no row lost");
    assert.equal(after.d, 4000, "no row duplicated");
    if (linux) assert.equal(after.per.length, 4, "every worker took writes");
    assert.deepEqual(await storm(base, "batch", 1500, 64), [], "batches of a write then a read");
    assert.deepEqual(await storm(base, "kv", 1500, 64), [], "KV puts and gets from every worker");
    assert.equal((await count(base)).n, 5500);

    // The next cron minute fires once, not once per worker. The runtime checks every 15 s.
    const first = await until("a cron to fire", 100000, async () =>
      (await count(base)).crons > 0 ? await count(base) : false,
    );
    await Bun.sleep(5000);
    const fired = await count(base);
    assert.equal(fired.crons, fired.cronMinutes, "each cron minute ran once");
    assert.equal(first.crons >= 1, true);
    await stop(server);
  }

  // The store a first KV call creates, raced by every worker, eight times from nothing.
  for (let trial = 0; trial < 8; trial++) {
    const { server, base } = await start("workers-app", { SB_WORKERS: "4" });
    await until("four workers", 20000, () => children(server.pid).length === 4);
    assert.deepEqual(await storm(base, "kv", 600, 100, `race${trial}`), [], `fresh store, trial ${trial}`);
    await stop(server);
  }

  // SB_WORKERS=1: one process.
  {
    const { server, base } = await start("workers-app", { SB_WORKERS: "1" });
    assert.deepEqual(children(server.pid), []);
    assert.equal(await (await fetch(`${base}/who`)).text(), "solo");
    assert.deepEqual(await storm(base, "write", 1000, 32), []);
    assert.equal((await count(base)).d, 1000);
    await stop(server);
  }

  // One instance: Durable Objects, a queue consumer, and the SQLite backup.
  // (the first two start a worker, find out, and keep only worker 0; the backup never forks)
  for (const [binary, env, why, forked, who] of [
    ["workers-do", {}, "a Durable Object", 1, "0"],
    ["workers-queue", {}, "a queue consumer", 1, "0"],
    ["workers-app", { SB_LTX_ENABLE: "1" }, "SB_LTX_ENABLE=1", 0, "solo"],
  ] as const) {
    const { server, base } = await start(binary, { SB_WORKERS: "4", ...env });
    await Bun.sleep(1500);
    assert.equal(children(server.pid).length, forked, `${why} runs one worker`);
    assert.equal(await (await fetch(`${base}/who`)).text(), who);
    await stop(server);
  }

  console.log(
    "Native workers (embedded): concurrent D1/KV across workers lose nothing, cron fires once, DO/queue/LTX run one worker",
  );
} finally {
  for (const server of running) {
    server.kill(9);
    await server.exited;
  }
  await rm(work, { recursive: true, force: true });
}
