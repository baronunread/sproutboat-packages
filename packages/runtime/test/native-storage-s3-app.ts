import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Design 029 stage S3, worker side, on a COMPILED standalone binary: the acknowledgement gate's counters and the waits that only
// the worker can make. (The host holds replies and WebSocket messages; sproutd's test/storage-s3-smoke.ts covers that half.
// Here there is no host, so SB_GATE_TEST_CONFIRM_MS stands in for it: the commits seen so far count as confirmed that many
// milliseconds after somebody first waited for them.)
//   position        every captured commit (D1, KV, Durable Object storage) moves the commit counter by one; reads do not
//   allowUnconfirmed  a storage call that passes it does not move the counter
//   outgoing calls  fetch() after an unconfirmed commit waits for the confirmation, and goes out as soon as it came; a call with
//                   nothing unconfirmed is not delayed
//   sync()          resolves when what was committed has been confirmed
//   off             without SB_LTX_GATE, and on a compatibility date before the gate's (2026-11-20), nothing is counted and
//                   nothing waits
// Needs SB_CLI (a sproutboat-cli checkout linked to this one, which builds the sprout) or SB_APP_BINARY and SB_APP_BINARY_OLD
// (sprouts built earlier from test/fixtures/storage-s3-app.js, with compatibility dates 2026-11-21 and 2026-11-19).
const cli = process.env.SB_CLI;
const prebuilt = process.env.SB_APP_BINARY;
const prebuiltOld = process.env.SB_APP_BINARY_OLD;
if (!cli && !(prebuilt && prebuiltOld)) {
  console.log(
    "skipped: set SB_CLI to a sproutboat-cli checkout linked to this checkout, or SB_APP_BINARY and SB_APP_BINARY_OLD",
  );
  process.exit(0);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const workdir = mkdtempSync(join(tmpdir(), "sb-native-s3-app-"));
const procs: ReturnType<typeof Bun.spawn>[] = [];
const fixture = new URL("./fixtures/storage-s3-app.js", import.meta.url).pathname;

function freePort(): number {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
}
function build(label: string, date: string): string {
  const project = join(workdir, label);
  mkdirSync(join(project, "src"), { recursive: true });
  copyFileSync(fixture, join(project, "src/index.js"));
  writeFileSync(
    join(project, "sproutboat.jsonc"),
    JSON.stringify({
      name: "s3-app",
      main: "src/index.js",
      compatibility_date: date,
      kv_namespaces: ["KV"],
      d1_databases: ["DB"],
      durable_objects: { OBJ: "Obj" },
    }),
  );
  const built = Bun.spawnSync(
    ["bun", join(cli!, "src/main.ts"), "build", "--standalone", "--target", process.env.SB_APP_TARGET ?? "host"],
    { cwd: project, stdout: "ignore", stderr: "inherit" },
  );
  assert.equal(built.exitCode, 0, `${label}: the CLI could not build the sprout`);
  const binary = join(project, "dist/s3-app");
  // SB_S3_KEEP=DIR keeps the builds for later runs (SB_APP_BINARY=DIR/new SB_APP_BINARY_OLD=DIR/old)
  if (process.env.SB_S3_KEEP) {
    mkdirSync(process.env.SB_S3_KEEP, { recursive: true });
    copyFileSync(binary, join(process.env.SB_S3_KEEP, label));
  }
  return binary;
}
interface Server {
  port: number;
  get(path: string): Promise<any>;
  kill(): Promise<void>;
}
let runs = 0;
async function start(binary: string, extra: Record<string, string>): Promise<Server> {
  const port = freePort();
  const n = ++runs;
  const spool = join(workdir, `spool-${n}`);
  mkdirSync(spool, { recursive: true });
  const env = {
    ...process.env,
    SB_DATA_DIR: join(workdir, `data-${n}`),
    PORT: String(port),
    SB_LTX_ENABLE: "1",
    SB_LTX_SCOPE: "d1,store,do-sql",
    SB_LTX_ROOT: spool,
    SB_OWNER_LOCK: "1",
    SB_EGRESS_ALLOW: "127.0.0.1", // the app calls a server on this machine
    ...extra,
  };
  const proc = Bun.spawn([binary], {
    cwd: workdir,
    env,
    stdout: "ignore",
    stderr: "inherit",
  });
  procs.push(proc);
  let up = false;
  for (let attempt = 0; attempt < 100 && !up; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/state`, {
        signal: AbortSignal.timeout(1000),
      });
      up = true;
    } catch {
      if (proc.exitCode !== null) break;
      await sleep(100);
    }
  }
  assert(up, "the compiled handler did not start");
  return {
    port,
    get: async (path) => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      const text = await r.text();
      assert.equal(r.status, 200, `${path}: ${text}`);
      return JSON.parse(text);
    },
    kill: async () => {
      proc.kill(9);
      await proc.exited;
    },
  };
}
// A server the app calls out to.
function target() {
  const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  return { url: `http://127.0.0.1:${s.port}/`, stop: () => s.stop(true) };
}

try {
  const binary = prebuilt ?? build("new", "2026-11-21");
  const old = prebuiltOld ?? build("old", "2026-11-19");
  const gate = { SB_LTX_GATE: "1" };

  {
    // 1. the commit position: no host confirms anything here, so the counter only grows. A write moves it (by the commits it made:
    // the first use of a database also makes the commits that set it up, so the test compares, it does not count).
    const s = await start(binary, gate);
    assert.deepEqual(await s.get("/state"), { seq: 0, confirmed: 0 });
    let last = 0;
    const moved = async (path: string, what: string) => {
      const seq = (await s.get(path)).seq;
      assert(seq > last, `${what}: the counter was ${last} and is ${seq}`);
      last = seq;
    };
    const still = async (path: string, what: string) => {
      assert.equal((await s.get(path)).seq, last, what);
    };
    await moved("/d1?v=a", "a D1 write");
    await moved("/d1?v=b", "a second D1 write");
    await still("/state", "a read does not move it");
    await moved("/kv?v=a", "a KV write");
    await moved("/obj/put?v=a", "a Durable Object write");
    await still("/obj/get", "a Durable Object read does not move it");
    // 2. allowUnconfirmed: replicated, but not waited for
    await still("/obj/put-unconfirmed?v=b", "allowUnconfirmed does not move the counter");
    await still("/obj/delete-unconfirmed", "nor does a delete under it");
    await moved("/obj/put?v=c", "an ordinary write after them");
    assert.equal((await s.get("/state")).confirmed, 0, "nothing confirmed without a host");
    // S4: the store's barrier reads only the keys the dirty list names, so every commit the gate counted has its line, unthrottled
    // (the list is otherwise one line per key per second)
    const dirtyLines = readFileSync(join(workdir, "spool-1/dirty"), "utf8").split("\n").filter(Boolean).length;
    assert(dirtyLines >= last, `the gate counted ${last} commits and the dirty list has ${dirtyLines} lines`);
    await s.kill();
    console.log(
      "PASS compiled app: the commit position counts D1, KV and Durable Object commits, not reads, not allowUnconfirmed",
    );
  }

  {
    // 3. an outgoing call after an unconfirmed commit waits for the confirmation; sync() resolves at it
    const t = target();
    const s = await start(binary, { ...gate, SB_GATE_TEST_CONFIRM_MS: "400" });
    const ro = await s.get(`/outgoing-read-only?to=${encodeURIComponent(t.url)}`);
    assert(ro.waited < 200, `nothing unconfirmed, yet the call waited ${ro.waited} ms`);
    const w = await s.get(`/outgoing?to=${encodeURIComponent(t.url)}`);
    assert(w.before.seq > w.before.confirmed, "a commit was unconfirmed when the call was made");
    assert(w.waited >= 350 && w.waited < 3000, `the call waited ${w.waited} ms for a 400 ms confirmation`);
    assert.equal(w.after.confirmed, w.after.seq, "the call went out after the confirmation");
    assert.equal(w.status, 200);
    const again = await s.get(`/outgoing-read-only?to=${encodeURIComponent(t.url)}`);
    assert(again.waited < 200, "confirmed: the next call is not delayed");
    const sy = await s.get("/obj/sync");
    assert(sy.waited >= 350 && sy.waited < 3000, `sync() waited ${sy.waited} ms`);
    assert.equal(sy.confirmed, sy.seq, "sync() resolved at the confirmation");
    const sy2 = await s.get("/obj/sync-only");
    assert(sy2.waited < 200, "sync() with nothing unconfirmed resolves at once");
    await s.kill();
    t.stop();
    console.log(
      `PASS compiled app: an outgoing call waited ${w.waited} ms for a 400 ms confirmation, sync() ${sy.waited} ms, nothing unconfirmed waits 0`,
    );
  }

  {
    // 4. off: without the host's switch, and on an older compatibility date
    const t = target();
    for (const [label, bin, env] of [
      ["no SB_LTX_GATE", binary, {}],
      ["compatibility date 2026-11-19", old, gate],
    ] as const) {
      const s = await start(bin, { ...env, SB_GATE_TEST_CONFIRM_MS: "400" });
      for (let i = 0; i < 3; i++) await s.get(`/d1?v=${i}`);
      assert.equal((await s.get("/state")).seq, 0, `${label}: nothing is counted`);
      const w = await s.get(`/outgoing?to=${encodeURIComponent(t.url)}`);
      assert(w.waited < 200, `${label}: the call waited ${w.waited} ms`);
      await s.kill();
    }
    t.stop();
    console.log(
      "PASS compiled app: gate off without the host's switch and before the compatibility date: no counting, no waiting",
    );
  }
} finally {
  for (const p of procs) {
    try {
      p.kill(9);
    } catch {}
  }
  rmSync(workdir, { recursive: true, force: true });
}
