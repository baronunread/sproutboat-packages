import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restore } from "./ltx-restore.ts";

// Design 029 stage S1b on a COMPILED standalone binary: group commit (SB_LTX_GROUP=1) through the prelude's promise barrier, and the
// capture's new write path, under concurrent HTTP load.
//   correctness  N clients put rows through D1; every 200 is an acknowledged row; none is missing afterwards, and the spool restores to
//                the database. Then a SIGKILL under load: every row that got a 200 survives the restart.
//   throughput   one table: capture off, capture on without and with group commit, by number of concurrent clients (printed; JSON
//                to SB_S1B_BENCH_JSON). Run it on the machine whose disk you mean to measure.
// Needs SB_CLI (a sproutboat-cli checkout linked to this one, which builds the sprout) or SB_APP_BINARY (a binary built earlier, from
// test/fixtures/storage-s1-app.js with the config below, for the same CPU and OS as this machine).
const cli = process.env.SB_CLI;
const prebuilt = process.env.SB_APP_BINARY;
if (!cli && !prebuilt) {
  console.log(
    "skipped: set SB_CLI to a sproutboat-cli checkout linked to this checkout, or SB_APP_BINARY to a built sprout",
  );
  process.exit(0);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const workdir = mkdtempSync(join(tmpdir(), "sb-native-s1b-app-"));
const procs: ReturnType<typeof Bun.spawn>[] = [];
const fixture = new URL("./fixtures/storage-s1-app.js", import.meta.url).pathname;
const only = (process.env.SB_S1B_ONLY ?? "").split(",").filter(Boolean);
const wants = (name: string) => !only.length || only.includes(name);

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}
function build(): string {
  if (prebuilt) return prebuilt;
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
  const built = Bun.spawnSync(
    ["bun", join(cli!, "src/main.ts"), "build", "--standalone", "--target", process.env.SB_APP_TARGET ?? "host"],
    {
      cwd: project,
      stdout: "ignore",
      stderr: "inherit",
    },
  );
  assert.equal(built.exitCode, 0, "the CLI could not build the sprout");
  return join(project, "dist/s1-app");
}
interface Server {
  port: number;
  get(path: string): Promise<{ status: number; body: any }>;
  kill(): Promise<void>;
}
async function start(
  binary: string,
  data: string,
  spool: string,
  extra: Record<string, string> = {},
  capture = true,
): Promise<Server> {
  const port = freePort();
  const captureEnv = { SB_LTX_ENABLE: "1", SB_LTX_SCOPE: "d1,store,do-sql", SB_LTX_ROOT: spool, SB_OWNER_LOCK: "1" };
  const env = { ...process.env, SB_DATA_DIR: data, PORT: String(port), ...(capture ? captureEnv : extra), ...extra };
  const proc = Bun.spawn([binary], { cwd: workdir, env, stdout: "ignore", stderr: "inherit" });
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
  assert(up, "the compiled handler did not start");
  return {
    port,
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
function dbRows(file: string): string[] {
  const copy = file + ".read";
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(file + suffix)) copyFileSync(file + suffix, copy + suffix);
  const db = new Database(copy);
  try {
    assert.equal(db.query("PRAGMA integrity_check").values()[0][0], "ok");
    return db
      .query("SELECT v FROM t ORDER BY rowid")
      .values()
      .map((r) => String(r[0]));
  } finally {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(copy + suffix, { force: true });
  }
}
async function chainRows(spool: string): Promise<string[]> {
  const position = (await Bun.file(join(spool, "position")).text()).split("\n");
  const out = spool + ".restored";
  await restore(join(spool, position[1]), out);
  try {
    return dbRows(out);
  } finally {
    rmSync(out, { force: true });
  }
}
// N clients, each putting `per` rows one after another over its own connection; returns the rows that got a 200 and the wall time.
async function load(
  server: Server,
  clients: number,
  per: number,
  tag: string,
  until = 0,
): Promise<{ acked: string[]; ms: number; lat: number[] }> {
  const acked: string[] = [];
  const lat: number[] = [];
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: clients }, async (_, c) => {
      for (let i = 0; i < per; i++) {
        if (until && performance.now() > until) return;
        const v = `${tag}-c${c}-${i}`;
        const s = performance.now();
        try {
          const r = await fetch(`http://127.0.0.1:${server.port}/d1/put?v=${v}`);
          await r.text();
          if (r.status === 200) {
            acked.push(v);
            lat.push(performance.now() - s);
          }
        } catch {
          return; // the server was killed under it
        }
      }
    }),
  );
  return { acked, ms: performance.now() - t0, lat };
}
const pct = (xs: number[], p: number) =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : 0;

try {
  const binary = build();
  if (wants("correct")) {
    for (const group of ["0", "1"]) {
      const data = join(workdir, `data-${group}`),
        spool = join(workdir, `spool-${group}`);
      const a = await start(binary, data, spool, { SB_LTX_GROUP: group });
      assert.equal((await a.get("/d1/put?v=first")).status, 200);
      const { acked } = await load(a, 32, 15, "x");
      assert.equal(acked.length, 480, "every request was answered 200");
      const all: string[] = (await a.get("/d1/all")).body.rows;
      for (const v of acked) assert(all.includes(v), `group ${group}: row ${v} is missing`);
      assert.equal(all.length, 481);
      // a read after a write sees it (the barrier must not reorder a call behind its own write)
      for (let i = 0; i < 20; i++) {
        assert.equal((await a.get(`/d1/put?v=ryw-${i}`)).status, 200);
        assert((await a.get("/d1/all")).body.rows.includes(`ryw-${i}`));
      }
      // a mixed concurrent run: puts on D1 together with KV, Durable Object and rate-limiter calls on the same worker
      await Promise.all([
        load(a, 8, 10, "mix"),
        ...Array.from({ length: 8 }, (_, i) => a.get(`/kv/put?k=k${i}&v=kv-${i}`)),
        ...Array.from({ length: 6 }, (_, i) => a.get(`/do/o${i % 2}/put?v=do-${i}`)),
        a.get("/rl"),
      ]);
      await a.kill();
      const live = dbRows(join(data, "d1/DB.sqlite"));
      assert.equal(live.length, 481 + 20 + 80);
      assert.deepEqual(
        [...(await chainRows(join(spool, "d1/DB")))].sort(),
        [...live].sort(),
        `group ${group}: the chain restores to the database`,
      );
      console.log(
        `PASS compiled app, SB_LTX_GROUP=${group}: 32 concurrent clients, ${live.length} rows acknowledged and present, read-your-write, mixed bindings, chain restores to the database`,
      );
    }
  }

  if (wants("kill")) {
    // SIGKILL under load with group commit: every 200 survives, the chain follows, and the worker comes back and serves.
    let total = 0;
    const data = join(workdir, "data-kill"),
      spool = join(workdir, "spool-kill");
    const must: string[] = [];
    const rounds = Number(process.env.SB_S1B_KILL_ROUNDS ?? 6);
    for (let round = 0; round < rounds; round++) {
      const s = await start(binary, data, spool, { SB_LTX_GROUP: round % 3 === 2 ? "0" : "1" });
      if (round > 0) {
        const present: string[] = (await s.get("/d1/all")).body.rows;
        for (const v of must) assert(present.includes(v), `round ${round}: acknowledged row ${v} was lost by the kill`);
      }
      const run = load(s, 24, 1000, `k${round}`, performance.now() + 150 + round * 60);
      await sleep(120 + round * 55);
      const done = run.then((r) => r);
      await s.kill();
      const r = await done;
      must.push(...r.acked);
      total += r.acked.length;
    }
    const last = await start(binary, data, spool, { SB_LTX_GROUP: "1" });
    const present: string[] = (await last.get("/d1/all")).body.rows;
    for (const v of must) assert(present.includes(v), `acknowledged row ${v} was lost`);
    assert.equal((await last.get("/d1/put?v=final")).status, 200);
    await last.kill();
    const live = dbRows(join(data, "d1/DB.sqlite"));
    assert.deepEqual(
      [...(await chainRows(join(spool, "d1/DB")))].sort(),
      [...live].sort(),
      "the chain restores to the database after the kills",
    );
    console.log(
      `PASS compiled app, ${rounds} SIGKILLs under 24 concurrent writers (group commit on for ${Math.ceil((rounds * 2) / 3)} of them): ${total} acknowledged rows, none lost, chain restores to the database`,
    );
  }

  if (wants("bench")) {
    const cap = (process.env.SB_S1B_BENCH_CLIENTS ?? "1,4,16,64").split(",").map(Number);
    const per = Number(process.env.SB_S1B_BENCH_PER ?? 60);
    // SB_S1B_LABEL names the build ("S1" when the binary is stage S1's); SB_S1B_MODES picks from off, plain, group.
    const label = process.env.SB_S1B_LABEL ?? "S1b";
    const picked = (process.env.SB_S1B_MODES ?? "off,plain,group").split(",");
    const modes = [
      { key: "off", name: "capture off", capture: false, extra: {} },
      { key: "plain", name: label, capture: true, extra: { SB_LTX_GROUP: "0" } },
      { key: "group", name: label + " + group", capture: true, extra: { SB_LTX_GROUP: "1" } },
    ].filter((m) => picked.includes(m.key));
    const rows: any[] = [];
    console.log(
      `bench on ${process.platform}/${process.arch}, ${per} puts per client, one D1 insert per request over HTTP`,
    );
    console.log("mode         clients   req/s   p50 ms   p99 ms");
    for (const m of modes)
      for (const clients of cap) {
        const data = join(workdir, `data-b-${rows.length}`),
          spool = join(workdir, `spool-b-${rows.length}`);
        const s = await start(binary, data, spool, m.extra, m.capture);
        await s.get("/d1/put?v=warm");
        const r = await load(s, clients, per, "b");
        assert.equal(r.acked.length, clients * per);
        const rps = (r.acked.length / r.ms) * 1000;
        const row = {
          mode: m.name,
          clients,
          requests: r.acked.length,
          reqPerSec: Math.round(rps),
          p50Ms: +pct(r.lat, 0.5).toFixed(2),
          p99Ms: +pct(r.lat, 0.99).toFixed(2),
        };
        rows.push(row);
        console.log(
          `${m.name.padEnd(12)} ${String(clients).padStart(7)} ${String(row.reqPerSec).padStart(7)} ${String(row.p50Ms).padStart(8)} ${String(row.p99Ms).padStart(8)}`,
        );
        await s.kill();
      }
    if (process.env.SB_S1B_BENCH_JSON)
      writeFileSync(
        process.env.SB_S1B_BENCH_JSON,
        JSON.stringify(
          { platform: `${process.platform}/${process.arch}`, at: new Date().toISOString(), per, rows },
          null,
          2,
        ) + "\n",
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
