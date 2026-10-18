import { expect, test } from "bun:test";
import { createBroker, type Frame } from "./broker";
import { D1Pool } from "./d1-pool";

const slowSql =
  "WITH RECURSIVE t(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM t WHERE x<8000000) SELECT sum(x) AS total FROM t";
test("shared SQL leaves sibling KV and control timers responsive, preserves D1 transactions and session isolation", async () => {
  const pool = new D1Pool(128, 16, 10_000, 10_000);
  const a = createBroker({ d1Pool: pool, bindings: { d1: ["DB"] } });
  const b = createBroker({ d1Pool: pool, bindings: { d1: ["DB"], kv: ["DATA"] } });
  try {
    expect(
      (await a.dispatch({ op: "d1.exec", db: "DB", sql: "CREATE TABLE t(v INTEGER); INSERT INTO t VALUES(7)" })).ok,
    ).toBe(true);
    expect(
      await b.dispatch({ op: "d1.query", db: "DB", sql: "SELECT * FROM t" }).then(
        () => "unexpected success",
        (e) => String(e),
      ),
    ).toContain("no such table");
    await b.dispatch({ op: "kv.put", ns: "DATA", key: "test", value: "B" });
    const heavy = a.dispatch({ op: "d1.query", db: "DB", sql: slowSql });
    const start = performance.now();
    await Bun.sleep(25);
    expect((await b.dispatch({ op: "kv.get", ns: "DATA", key: "test" })).value).toBe("B");
    expect(performance.now() - start).toBeLessThan(150);
    expect((await heavy).ok).toBe(true);
    expect(
      await a
        .dispatch({
          op: "d1.batch",
          db: "DB",
          statements: [{ sql: "INSERT INTO t VALUES(8)" }, { sql: "INSERT INTO absent VALUES(9)" }],
        })
        .then(
          () => "unexpected success",
          (e) => String(e),
        ),
    ).toContain("no such table");
    expect((await a.dispatch({ op: "d1.query", db: "DB", sql: "SELECT * FROM t" })).results).toEqual([{ v: 7 }]);
    a.close();
    expect((await b.dispatch({ op: "d1.exec", db: "DB", sql: "CREATE TABLE t(v); INSERT INTO t VALUES(11)" })).ok).toBe(
      true,
    );
    expect((await b.dispatch({ op: "d1.query", db: "DB", sql: "SELECT * FROM t" })).results).toEqual([{ v: 11 }]);
  } finally {
    b.close();
    pool.close();
  }
}, 15_000);

test("SQL admission is bounded and queued deadlines never execute expired mutations", async () => {
  const pool = new D1Pool(2, 2, 30, 10_000);
  const session = pool.session();
  const request = (sql: string) =>
    session.execute({ key: "one", path: ":memory:", name: "DB", msg: { op: "d1.query", sql } });
  try {
    const active = request(slowSql);
    const expired = request("CREATE TABLE must_not_exist(v)");
    const rejected = expect(request("SELECT 1")).rejects.toThrow("capacity exceeded");
    await expect(expired).rejects.toThrow("queue deadline exceeded");
    await rejected;
    await active;
    const result = await request("SELECT count(*) AS n FROM sqlite_master WHERE name='must_not_exist'");
    expect(result.results).toEqual([{ n: 0 }]);
  } finally {
    session.close();
    pool.close();
  }
}, 15_000);

test("SQL lanes rotate all waiting sessions instead of alternating only two noisy sessions", async () => {
  const pool = new D1Pool(128, 16, 10_000, 10_000);
  const sessions = [pool.session(), pool.session(), pool.session()];
  const order: string[] = [];
  const submit = (owner: number, sql: string, label: string) =>
    sessions[owner]!.execute({
      key: "same-lane",
      path: ":memory:",
      name: "DB",
      msg: { op: "d1.query", sql },
    }).then(() => {
      order.push(label);
    });
  try {
    const work = [submit(0, slowSql, "active")];
    for (let owner = 0; owner < 3; owner++) {
      work.push(submit(owner, "SELECT 1", `${owner}:1`), submit(owner, "SELECT 2", `${owner}:2`));
    }
    await Promise.all(work);
    expect(order).toEqual(["active", "0:1", "1:1", "2:1", "0:2", "1:2", "2:2"]);
  } finally {
    for (const session of sessions) session.close();
    pool.close();
  }
}, 15_000);

test("unexpected SQL thread loss fails closed and notifies broker supervision", async () => {
  const pool = new D1Pool(128, 16, 10_000, 10_000);
  const session = pool.session();
  const request = () =>
    session.execute({ key: "failure", path: ":memory:", name: "DB", msg: { op: "d1.query", sql: "SELECT 1" } });
  let signal!: () => void;
  const failed = new Promise<void>((resolve) => {
    signal = resolve;
  });
  pool.onFailure = signal;
  try {
    await request();
    // SAFETY: fault injection into this test's own private worker, never a shared process.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/no-known-value-widening -- Deliberate private-state fault injection avoids adding a production test API.
    const lanes = (pool as unknown as { lanes: Array<{ worker?: Worker }> }).lanes;
    lanes.find((lane) => lane.worker)!.worker!.terminate();
    await failed;
    expect(
      await request().then(
        () => "unexpected success",
        (e) => String(e),
      ),
    ).toContain("session closed");
  } finally {
    session.close();
    pool.close();
  }
}, 5000);

test("running SQL is interrupted, batch writes roll back, and the same lane recovers without replay", async () => {
  const pool = new D1Pool(128, 16, 10_000, 50);
  const session = pool.session();
  const peer = pool.session();
  const run = (msg: Frame) => session.execute({ key: "deadline", path: ":memory:", name: "DB", msg });
  try {
    await run({ op: "d1.exec", sql: "CREATE TABLE writes(v INTEGER)" });
    const started = performance.now();
    const interrupted = run({
      op: "d1.batch",
      statements: [{ sql: "INSERT INTO writes VALUES(1)" }, { sql: slowSql }, { sql: "INSERT INTO writes VALUES(2)" }],
    }).then(
      () => "unexpected success",
      (error) => String(error),
    );
    const queuedPeer = peer.execute({
      key: "deadline",
      path: ":memory:",
      name: "DB",
      msg: { op: "d1.query", sql: "SELECT 42 AS n" },
    });
    expect(await interrupted).toContain("execution deadline exceeded");
    expect((await queuedPeer).results).toEqual([{ n: 42 }]);
    expect(performance.now() - started).toBeLessThan(500);
    expect((await run({ op: "d1.query", sql: "SELECT * FROM writes" })).results).toEqual([]);
    await run({ op: "d1.query", sql: "INSERT INTO writes VALUES(3)" });
    expect((await run({ op: "d1.query", sql: "SELECT * FROM writes" })).results).toEqual([{ v: 3 }]);
    expect(
      await run({ op: "d1.query", sql: "SELECT sb_sql_budget(?, 30000)", params: ["0".repeat(64)] }).then(
        () => "unexpected success",
        (error) => String(error),
      ),
    ).toContain("invalid budget capability");
    expect(
      await run({ op: "d1.query", sql: "SELECT load_extension('untrusted')" }).then(
        () => "unexpected success",
        (error) => String(error),
      ),
    ).toContain("not authorized");
    expect(
      await run({ op: "d1.query", sql: slowSql }).then(
        () => "unexpected success",
        (error) => String(error),
      ),
    ).toContain("execution deadline exceeded");
  } finally {
    session.close();
    peer.close();
    pool.close();
  }
}, 5000);

test("watchdog revokes a broker stuck in SQLite lock wait and does not commit or replay its write", async () => {
  const { Database } = await import("bun:sqlite");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "sb-budget-lock-"));
  const path = join(dir, "locked.sqlite");
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE writes(v); BEGIN IMMEDIATE");
  const script = `import {D1Pool} from ${JSON.stringify(join(import.meta.dir, "d1-pool.ts"))};
    const pool=new D1Pool(128,16,10000,50);
    pool.onFailure=()=>process.exit(1);
    await pool.session().execute({key:${JSON.stringify(path)},path:${JSON.stringify(path)},name:"DB",msg:{op:"d1.exec",sql:"PRAGMA busy_timeout=600000; INSERT INTO writes VALUES(1)"}}).catch(()=>{});`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "pipe" });
  const started = performance.now();
  const timeout = setTimeout(() => child.kill(9), 4000);
  try {
    expect(await child.exited).toBe(1);
    expect(performance.now() - started).toBeLessThan(2500);
    db.exec("ROLLBACK");
    expect(db.query("SELECT * FROM writes").all()).toEqual([]);
    db.exec("INSERT INTO writes VALUES(2)");
    expect(db.query("SELECT * FROM writes").all()).toEqual([{ v: 2 }]);
  } finally {
    clearTimeout(timeout);
    child.kill(9);
    await child.exited;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 5000);
