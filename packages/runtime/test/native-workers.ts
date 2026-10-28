import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// SB_WORKERS: a standalone binary forks worker processes, each with its own listener (SO_REUSEPORT),
// heap and event loop, under a supervisor. Covers: SB_WORKERS=1 is the plain single process, every
// worker takes connections (Linux: macOS does not spread SO_REUSEPORT), a killed worker is replaced,
// SIGTERM drains the requests in flight before the supervisor exits 0, and a crash loop ends in a
// non-zero exit. The transport is the broker one, so no SQLite or TLS needs linking; concurrent D1
// writes, cron and the single-instance fallback are in native-workers-embedded.ts.
const handler = `export default {async fetch(request) {
  const url = new URL(request.url);
  const who = __sbEnv("SB_WORKER_INDEX") || "solo";
  if (url.pathname === "/slow") {
    await new Promise((resolve) => setTimeout(resolve, Number(url.searchParams.get("ms") || 1000)));
    return new Response("slow-done:" + who);
  }
  return new Response(who);
}};`;

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

async function until<T>(
  what: string,
  ms: number,
  probe: () => Promise<T | undefined | false> | T | undefined | false,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-workers-"));
const running: Array<ReturnType<typeof Bun.spawn>> = [];
try {
  const porffor = await ensurePorffor();
  const node = Bun.which("node");
  if (!node) throw new Error("native workers test needs node on PATH");
  const [core, broker] = await Promise.all([readFile(preludePath, "utf8"), readFile(transportPath("broker"), "utf8")]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const generated = join(workdir, "workers.generated.js");
  const binary = join(workdir, "workers-native");
  await writeFile(
    generated,
    wrapNativeFetchHandler(
      handler,
      core.replace(TRANSPORT_MARKER, broker),
      undefined,
      undefined,
      undefined,
      "2026-10-01",
    ),
  );
  const compile = Bun.spawn(
    [node, resolve(porffor, "runtime/index.js"), "native", generated, "-o", binary, "-s", "-O0"],
    {
      cwd: workdir,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    compile.exited,
    new Response(compile.stdout).text(),
    new Response(compile.stderr).text(),
  ]);
  assert.equal(exitCode, 0, `Porffor native compile failed:\n${stderr}\n${stdout}`);

  async function start(env: Record<string, string>) {
    const port = freePort();
    const server = Bun.spawn([binary], {
      cwd: workdir,
      env: { ...process.env, PORT: String(port), SB_BROKER_TOKEN: "native-test-token", ...env },
      stdout: "ignore",
      stderr: "pipe",
    });
    running.push(server);
    const log = new Response(server.stderr).text();
    await until("the binary to answer", 15000, async () => {
      if (server.exitCode !== null) throw new Error(`the binary exited with ${server.exitCode}: ${await log}`);
      return fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }).then(
        () => true,
        () => false,
      );
    });
    return { server, port, log };
  }
  const who = async (port: number) =>
    (await (await fetch(`http://127.0.0.1:${port}/`, { headers: { connection: "close" } })).text()).trim();

  // SB_WORKERS=1: the plain single process, as before this existed: no children, no worker index.
  {
    const { server, port } = await start({ SB_WORKERS: "1" });
    assert.deepEqual(children(server.pid), [], "SB_WORKERS=1 forked");
    assert.equal(await who(port), "solo");
    server.kill("SIGTERM");
    await server.exited;
  }

  // Three workers: three children, each takes connections (Linux), and each knows its index.
  {
    const { server, port } = await start({ SB_WORKERS: "3" });
    const kids = await until("three workers", 15000, () => {
      const found = children(server.pid);
      return found.length === 3 && found;
    });
    if (process.platform === "linux") {
      const seen = new Set<string>();
      for (let i = 0; i < 300 && seen.size < 3; i++) seen.add(await who(port));
      assert.deepEqual([...seen].sort(), ["0", "1", "2"], "every worker takes connections");
    } else {
      assert.match(await who(port), /^[012]$/);
    }

    // A killed worker is replaced and the others keep serving.
    process.kill(kids[1]!, "SIGKILL");
    const after = await until("the replacement worker", 15000, () => {
      const found = children(server.pid);
      return found.length === 3 && !found.includes(kids[1]!) && found;
    });
    assert.equal(after.filter((pid) => kids.includes(pid)).length, 2, "only the killed worker changed");
    assert.match(await who(port), /^[012]$/);

    // SIGTERM drains: requests already in flight finish with their answers, the supervisor exits 0,
    // and the port stops accepting.
    const slow = Array.from({ length: 6 }, () =>
      fetch(`http://127.0.0.1:${port}/slow?ms=1500`, { headers: { connection: "close" } }).then(async (r) => ({
        status: r.status,
        body: await r.text(),
      })),
    );
    await Bun.sleep(500);
    server.kill("SIGTERM");
    for (const reply of await Promise.all(slow)) {
      assert.equal(reply.status, 200);
      assert.match(reply.body, /^slow-done:[012]$/);
    }
    assert.equal(
      await Promise.race([server.exited, Bun.sleep(15000).then(() => "timeout")]),
      0,
      "supervisor exits 0 after the drain",
    );
    await assert.rejects(
      fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }),
      "the port is closed",
    );
  }

  // Workers that keep dying: the supervisor gives up and exits non-zero.
  {
    const { server } = await start({ SB_WORKERS: "2" });
    const end = Date.now() + 40000;
    while (server.exitCode === null && Date.now() < end) {
      for (const pid of children(server.pid)) process.kill(pid, "SIGKILL");
      await Bun.sleep(200);
    }
    assert.notEqual(server.exitCode, null, "the supervisor never gave up");
    assert.equal(server.exitCode, 1, "crash loop exits non-zero");
  }

  console.log(
    "Native workers: SB_WORKERS=1 is one process, workers share the port, a killed worker is replaced, SIGTERM drains, a crash loop exits 1",
  );
} finally {
  for (const server of running) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
