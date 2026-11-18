import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Analytics Engine in the embedded transport: the (dataset, ts) index, the per-dataset counter and retention. The
// transport is the text a compiled app carries; here it runs as plain JS over bun:sqlite, with the C entry points
// (__sbSqlRaw, the environment) replaced by stand-ins. wire/src/broker-ae.test.ts holds the broker's copy to the same rules.
const DAY = 86400000;
const source = readFileSync(new URL("./transport-embedded.js", import.meta.url), "utf8");
const dirs = [];
const dbs = new Map();
afterEach(() => {
  for (const db of dbs.values()) db.close();
  dbs.clear();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function open(path) {
  let db = dbs.get(path);
  if (!db) {
    db = new Database(path, { create: true });
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000");
    dbs.set(path, db);
  }
  return db;
}
function sqlRaw(path, sql, paramsJson) {
  const db = open(path);
  try {
    const stmt = db.query(sql);
    const params = JSON.parse(paramsJson);
    if (stmt.columnNames.length) return JSON.stringify({ ok: true, rows: stmt.values(...params) });
    const r = stmt.run(...params);
    return JSON.stringify({ ok: true, rows: [], changes: r.changes, rowid: Number(r.lastInsertRowid) });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e.message) });
  }
}
// A fresh copy of the transport per app process: its module state (schema flag, prune clock) is per process.
function process(dir, compat = "2026-11-19") {
  const patched = source.replace("function __sbSqlRaw(", "function __sbSqlRawC(");
  // oxlint-disable-next-line no-function-constructor -- the transport is spliced in as text in production too
  const load = new Function(
    "Porffor",
    "__sbSqlRaw",
    "__sbEnv",
    "__sbDirBytesRaw",
    "__sbCompatDate",
    `${patched}\nreturn { dispatch: __sbEmbeddedDispatch };`,
  );
  const env = { SB_DATA_DIR: dir };
  const t = load(
    { c: () => "" },
    sqlRaw,
    (k) => env[k] || "",
    () => "0 0",
    () => compat,
  );
  return (msg) => t.dispatch(msg);
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "sb-ae-embedded-"));
  dirs.push(dir);
  return { dir, store: join(dir, "store.sqlite") };
}
const write = (call, dataset, extra = {}) => call({ op: "ae.write", dataset, blobs: ["b"], doubles: [1], ...extra });
const count = (store, dataset) =>
  open(store).query("SELECT count(*) FROM ae WHERE dataset = ?").get(dataset)["count(*)"];
const counter = (store, dataset) => open(store).query("SELECT n FROM ae_count WHERE dataset = ?").get(dataset)?.n;
const OLD_SCHEMA =
  "CREATE TABLE ae (dataset TEXT NOT NULL, ts INTEGER NOT NULL, indexes_json TEXT NOT NULL, blobs_json TEXT NOT NULL, doubles_json TEXT NOT NULL)";
// Fill with one statement: n points of a dataset, the newest at `newest`, one second apart going back.
const fill = (store, dataset, n, newest) =>
  open(store)
    .query(
      `WITH RECURSIVE s(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM s WHERE i + 1 < ?2)
       INSERT INTO ae SELECT ?1, ?3 - i * 1000, '[]', '["x"]', '[1]' FROM s`,
    )
    .run(dataset, n, newest);

test("a store from before the index gets the index and an exact counter on open", () => {
  const { dir, store } = setup();
  const db = open(store);
  db.exec(OLD_SCHEMA);
  fill(store, "A", 5, Date.now());
  fill(store, "B", 2, Date.now());
  expect(db.query("PRAGMA index_list(ae)").all()).toEqual([]);

  const call = process(dir);
  expect(call({ op: "ae.query", dataset: "A", limit: 2 }).count).toBe(5);
  expect(
    db
      .query("PRAGMA index_list(ae)")
      .all()
      .map((i) => i.name),
  ).toEqual(["ae_dataset_ts"]);
  expect(counter(store, "B")).toBe(2);
  // a writer without the counter code (an older runtime, a rollback) is still counted: the triggers live in the file
  db.query("INSERT INTO ae VALUES ('A', ?, '[]', '[]', '[]')").run(Date.now());
  expect(call({ op: "ae.query", dataset: "A", limit: 1 }).count).toBe(6);
  // opened again, nothing is rebuilt or recounted
  expect(process(dir)({ op: "ae.query", dataset: "A", limit: 1 }).count).toBe(6);
});

test("query() keeps its result shape and reads the newest point from the index", () => {
  const { dir, store } = setup();
  const call = process(dir);
  expect(call({ op: "ae.query", dataset: "M", limit: 3 })).toEqual({ ok: true, count: 0, rows: [] });
  write(call, "M", { blobs: ["first"], indexes: ["i"] });
  write(call, "M", { blobs: ["second"] });
  const q = call({ op: "ae.query", dataset: "M", limit: 5 });
  expect(Object.keys(q)).toEqual(["ok", "count", "rows"]);
  expect(q.count).toBe(2);
  expect(q.rows.map((r) => r.blobs[0])).toEqual(["second", "first"]);
  expect(Object.keys(q.rows[0])).toEqual(["timestamp", "indexes", "blobs", "doubles"]);
  const plan = open(store)
    .query("EXPLAIN QUERY PLAN SELECT ts FROM ae WHERE dataset = ? ORDER BY ts DESC, rowid DESC LIMIT ?")
    .all("M", 1)
    .map((r) => r.detail)
    .join(" | ");
  expect(plan).toContain("ae_dataset_ts");
  expect(plan).not.toContain("TEMP B-TREE");
});

test("a write removes points older than 92 days, at most 1,000 at a time, and the count stays exact", () => {
  const { dir, store } = setup();
  write(process(dir), "M"); // creates the tables
  const now = Date.now();
  fill(store, "M", 2500, now - 93 * DAY); // all older than 92 days
  fill(store, "M", 10, now - 91 * DAY); // all younger
  fill(store, "OTHER", 5, now - 200 * DAY); // another dataset's old points are left to its own writes
  expect(counter(store, "M")).toBe(2511);

  const worker = process(dir);
  write(worker, "M");
  expect(count(store, "M")).toBe(2511 + 1 - 1000);
  expect(counter(store, "M")).toBe(count(store, "M"));
  // within the same 10 s the process does not prune again: a write stays one insert
  write(worker, "M");
  expect(count(store, "M")).toBe(2511 + 2 - 1000);
  // a process that starts later works the backlog off, batch by batch, and keeps every point under 92 days
  write(process(dir), "M");
  write(process(dir), "M");
  expect(
    open(store)
      .query("SELECT count(*) AS n FROM ae WHERE dataset = 'M' AND ts < ?")
      .get(now - 92 * DAY).n,
  ).toBe(0);
  expect(count(store, "M")).toBe(10 + 1 + 4);
  expect(counter(store, "M")).toBe(15);
  expect(count(store, "OTHER")).toBe(5);
  expect(counter(store, "OTHER")).toBe(5);
  expect(process(dir)({ op: "ae.query", dataset: "M", limit: 1 }).count).toBe(15);
});

test("a dataset holds at most 1,000,000 points: the oldest go first", () => {
  const { dir, store } = setup();
  const call = process(dir);
  write(call, "M");
  const now = Date.now();
  fill(store, "M", 1000500, now - 60000); // younger than 92 days, 500 over the cap with the one written above
  expect(counter(store, "M")).toBe(1000501);
  write(process(dir), "M");
  expect(counter(store, "M")).toBe(1000000);
  expect(count(store, "M")).toBe(1000000);
  // the survivors are the newest
  const oldest = open(store).query("SELECT min(ts) AS t FROM ae WHERE dataset = 'M'").get().t;
  expect(oldest).toBeGreaterThan(now - 60000 - 1000500 * 1000 + 500 * 1000 - 1);
});

test("100,000 points: query({limit:1}) stays fast", () => {
  const { dir, store } = setup();
  const call = process(dir);
  write(call, "M");
  fill(store, "M", 100000, Date.now() - 1000);
  call({ op: "ae.query", dataset: "M", limit: 1 });
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) expect(call({ op: "ae.query", dataset: "M", limit: 1 }).count).toBe(100001);
  const each = (performance.now() - t0) / 20;
  // 85 ms with the full scan; well under 1 ms with the index and the counter
  expect(each).toBeLessThan(10);
});

test("an app older than compatibility date 2026-11-19 keeps every point; the index and the counter apply to it too", () => {
  const { dir, store } = setup();
  const call = process(dir, "2026-11-18");
  write(call, "M");
  fill(store, "M", 1500, Date.now() - 200 * DAY);
  write(process(dir, "2026-11-18"), "M");
  expect(count(store, "M")).toBe(1502);
  expect(counter(store, "M")).toBe(1502);
  expect(call({ op: "ae.query", dataset: "M", limit: 1 }).count).toBe(1502);
  expect(open(store).query("PRAGMA index_list(ae)").all().length).toBe(1);
  // the same store, opened by an app from the date on, starts pruning
  write(process(dir, "2026-11-19"), "M");
  expect(count(store, "M")).toBe(1503 - 1000);
});

test("the age rule and the cap share one run's 1,000-point budget", () => {
  const { dir, store } = setup();
  write(process(dir), "M");
  const now = Date.now();
  fill(store, "M", 1000, now - 93 * DAY); // expired
  fill(store, "M", 1001000, now - 60000); // young, over the cap
  expect(counter(store, "M")).toBe(1002001);
  write(process(dir), "M");
  expect(counter(store, "M")).toBe(1002002 - 1000); // not 2,000 gone
  expect(count(store, "M")).toBe(counter(store, "M"));
});
