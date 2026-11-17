import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restore } from "./ltx-restore.ts";

// Storage stage S1 on a COMPILED standalone binary (the same inline C as in sproutd's workers, built by the CLI): the owner lock and
// capture of D1, store.sqlite and Durable Object SQL through idle eviction and SIGKILL, restored from the spool and compared with the
// databases, and a second process on the same data refused and then served once the first is gone. native-storage-s1.ts runs the
// same C without the compiler; this one proves the compiled program keeps to it. Needs SB_CLI, a sproutboat-cli checkout linked to
// this one (it builds the sprout), as native-do-evict.ts does.
const cli = process.env.SB_CLI;
if (!cli) {
  console.log("skipped: set SB_CLI to a sproutboat-cli checkout linked to this checkout (it builds the sprout)");
  process.exit(0);
}
const IDLE = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const workdir = mkdtempSync(join(tmpdir(), "sb-native-s1-app-"));
const procs: ReturnType<typeof Bun.spawn>[] = [];
const fixture = new URL("./fixtures/storage-s1-app.js", import.meta.url).pathname;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}
function build(): string {
  const project = join(workdir, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  copyFileSync(fixture, join(project, "src/index.js"));
  writeFileSync(
    join(project, "sproutboat.jsonc"),
    JSON.stringify({
      name: "s1-app",
      main: "src/index.js",
      compatibility_date: "2026-11-21",
      kv_namespaces: ["KV"],
      d1_databases: ["DB"],
      durable_objects: { OBJ: "Obj" },
      ratelimiters: [{ binding: "LIMITER", limit: 100, period: 60 }],
      analytics_engine_datasets: ["METRICS"],
    }),
  );
  const built = Bun.spawnSync(["bun", join(cli!, "src/main.ts"), "build", "--standalone", "--target", "host"], {
    cwd: project,
    stdout: "ignore",
    stderr: "inherit",
  });
  assert.equal(built.exitCode, 0, "the CLI could not build the sprout");
  return join(project, "dist/s1-app");
}
interface Server {
  port: number;
  pid: number;
  get(path: string): Promise<{ status: number; body: any }>;
  kill(): Promise<void>;
}
async function start(
  binary: string,
  label: string,
  data: string,
  spool: string,
  extra: Record<string, string> = {},
): Promise<Server> {
  const port = freePort();
  const proc = Bun.spawn([binary], {
    cwd: workdir,
    env: {
      ...process.env,
      SB_DATA_DIR: data,
      PORT: String(port),
      SB_DO_IDLE_MS: String(IDLE),
      SB_LTX_ENABLE: "1",
      SB_LTX_SCOPE: "d1,store,do-sql",
      SB_LTX_ROOT: spool,
      SB_OWNER_LOCK: "1",
      ...extra,
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  procs.push(proc);
  let up = false;
  for (let attempt = 0; attempt < 100 && !up; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
      up = true;
    } catch {
      if (proc.exitCode !== null) break;
      await sleep(100);
    }
  }
  assert(up, `${label}: the compiled handler did not start`);
  return {
    port,
    pid: proc.pid,
    get: async (path) => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      const text = await r.text();
      let body: any = text;
      try {
        body = JSON.parse(text);
      } catch {}
      return { status: r.status, body };
    },
    kill: async () => {
      proc.kill(9);
      await proc.exited;
    },
  };
}
function rows(file: string, sql: string): unknown[][] {
  const copy = file + ".read";
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(file + suffix)) copyFileSync(file + suffix, copy + suffix);
  const db = new Database(copy);
  try {
    return db.query(sql).values();
  } finally {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(copy + suffix, { force: true });
  }
}
async function restored(spool: string, sql: string): Promise<unknown[][]> {
  const position = (await Bun.file(join(spool, "position")).text()).split("\n");
  const out = spool + ".restored";
  await restore(join(spool, position[1]), out);
  try {
    return rows(out, sql);
  } finally {
    rmSync(out, { force: true });
  }
}

try {
  const binary = build();
  const data = join(workdir, "data"),
    spool = join(workdir, "spool");
  const a = await start(binary, "first", data, spool);
  // every kind of file, from the compiled program
  for (let i = 0; i < 6; i++) {
    assert.equal((await a.get(`/kv/put?k=k${i}&v=kv-${i}`)).status, 200);
    assert.equal((await a.get(`/d1/put?v=d1-${i}`)).status, 200);
  }
  for (const id of ["x", "y"])
    for (let i = 0; i < 4; i++) assert.equal((await a.get(`/do/${id}/put?v=${id}-${i}`)).status, 200);
  assert.equal((await a.get("/rl")).body.success, true);
  assert.equal((await a.get("/ae")).status, 200);
  // idle eviction closes the object's SQL handle (the settle path); the next call wakes it from its file
  await sleep(IDLE * 4);
  assert.deepEqual(
    (await a.get("/do/x/all")).body.rows,
    ["x-0", "x-1", "x-2", "x-3"],
    "a woken object reads what it wrote",
  );
  assert.equal((await a.get("/do/x/put?v=x-4")).status, 200);
  assert.equal((await a.get("/")).body, "plain");

  const keys = readdirSync(join(spool, "do-sql/Obj"));
  assert.equal(keys.length, 2, "one spool per object");
  assert(existsSync(join(spool, "d1/DB/position")) && existsSync(join(spool, "store/position")));
  assert(!existsSync(join(data, "d1/DB.sqlite.ltx")), "no spool beside the database when the root is set");
  assert(
    existsSync(join(data, "volatile.sqlite")),
    "rate limits and Analytics Engine datapoints moved to volatile.sqlite",
  );
  const storeTables = rows(join(data, "store.sqlite"), "SELECT name FROM sqlite_master WHERE type='table'").map(
    (r) => r[0],
  );
  assert(
    !storeTables.includes("ratelimit") && !storeTables.includes("ae") && !storeTables.includes("cache"),
    "store.sqlite holds none of the disposable tables: " + storeTables,
  );
  assert(storeTables.includes("kv"));
  assert(!existsSync(join(spool, "volatile")), "volatile.sqlite has no spool");

  // a second process on the same data: refused while the first lives, served the moment it is gone, with no restart
  const b = await start(binary, "second", data, spool, { SB_OWNER_WAIT_MS: "300" });
  assert.equal((await b.get("/")).body, "plain", "a request that touches no storage is served");
  const refused = await b.get("/kv/get?k=k0");
  assert.equal(refused.status, 500);
  assert.match(refused.body.error, /owned by another worker|cannot open|sqlite/i, JSON.stringify(refused.body));
  const refusedDo = await b.get("/do/x/all");
  assert.equal(refusedDo.status, 500);
  assert.match(refusedDo.body.error, /owned by another worker/, JSON.stringify(refusedDo.body));
  await a.kill();
  const served = await b.get("/kv/get?k=k0");
  assert.deepEqual(
    served.body,
    { v: "kv-0" },
    "the second worker serves once the owner is gone: " + JSON.stringify(served),
  );
  assert.deepEqual((await b.get("/do/x/all")).body.rows, ["x-0", "x-1", "x-2", "x-3", "x-4"]);
  assert.equal((await b.get("/d1/put?v=d1-6")).status, 200);
  assert.equal((await b.get("/do/y/put?v=y-4")).status, 200);
  await b.kill();

  // restore every spool and compare with the databases the killed process left: nothing acknowledged is missing
  const d1 = await restored(join(spool, "d1/DB"), "SELECT v FROM t ORDER BY rowid");
  assert.deepEqual(d1, rows(join(data, "d1/DB.sqlite"), "SELECT v FROM t ORDER BY rowid"));
  assert.equal(d1.length, 7);
  const kv = await restored(join(spool, "store"), "SELECT key, value FROM kv ORDER BY key");
  assert.deepEqual(kv, rows(join(data, "store.sqlite"), "SELECT key, value FROM kv ORDER BY key"));
  assert.equal(kv.length, 6);
  const doStore = await restored(join(spool, "store"), "SELECT id, key, value FROM do_storage ORDER BY id, key");
  assert(doStore.length >= 2, "Durable Object storage is in the store chain");
  for (const key of keys) {
    const rowsRestored = await restored(join(spool, "do-sql/Obj", key), "SELECT v FROM t ORDER BY rowid");
    const live = rows(join(data, "do-sql/Obj", key + ".sqlite"), "SELECT v FROM t ORDER BY rowid");
    assert.deepEqual(rowsRestored, live, "object " + key);
    assert(rowsRestored.length >= 5);
  }
  console.log(
    "PASS compiled app: d1, store.sqlite and Durable Object SQL captured through eviction, a second process refused then served, SIGKILL, restores equal the databases",
  );
} finally {
  for (const p of procs) {
    try {
      p.kill(9);
    } catch {}
  }
  rmSync(workdir, { recursive: true, force: true });
}
