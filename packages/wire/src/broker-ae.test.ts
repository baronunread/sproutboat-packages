import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AE_MAX_AGE_MS, AE_MAX_ROWS, createBroker, type Broker } from "./broker";
import { jsonObject, type JsonObject, type JsonValue } from "./json";

// Analytics Engine in the broker: the (dataset, ts) index, the per-dataset counter and retention.
// runtime/src/ae-embedded.test.js holds the embedded transport's copy to the same rules.
const DAY = 86_400_000;
const obj = (value: JsonValue | undefined): JsonObject => jsonObject(value ?? null) ?? {};
const arr = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : []);

const roots: string[] = [];
const dbs: Database[] = [];
const brokers: Broker[] = [];
afterEach(() => {
  for (const b of brokers.splice(0)) b.close();
  for (const d of dbs.splice(0)) d.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "sb-ae-"));
  roots.push(root);
  const path = join(root, "state.sqlite");
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000");
  dbs.push(db);
  return { path, db };
}
const open = (path: string): Broker => {
  const b = createBroker({ db: path, bindings: { analytics: ["M", "OTHER"] } });
  brokers.push(b);
  return b;
};
const write = (b: Broker, dataset = "M") => b.dispatch({ op: "ae.write", dataset, blobs: ["b"], doubles: [1] });
const count = (db: Database, dataset: string): number =>
  db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM ae WHERE dataset = ?").get(dataset)?.n ?? -1;
const counter = (db: Database, dataset: string): number | undefined =>
  db.query<{ n: number }, [string]>("SELECT n FROM ae_count WHERE dataset = ?").get(dataset)?.n;
/** n points of a dataset in one statement, the newest at `newest`, one second apart going back. */
const fill = (db: Database, dataset: string, n: number, newest: number): void => {
  db.query(
    `WITH RECURSIVE s(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM s WHERE i + 1 < ?2)
     INSERT INTO ae SELECT ?1, ?3 - i * 1000, '[]', '["x"]', '[1]' FROM s`,
  ).run(dataset, n, newest);
};
const OLD_SCHEMA =
  "CREATE TABLE ae (dataset TEXT NOT NULL, ts INTEGER NOT NULL, indexes_json TEXT NOT NULL, blobs_json TEXT NOT NULL, doubles_json TEXT NOT NULL)";

test("a store from before the index gets the index and an exact counter on open", async () => {
  const { path, db } = setup();
  db.exec(OLD_SCHEMA);
  fill(db, "M", 5, Date.now());
  fill(db, "OTHER", 2, Date.now());
  expect(db.query("PRAGMA index_list(ae)").all()).toEqual([]);

  const b = open(path);
  expect(
    db
      .query<{ name: string }, []>("PRAGMA index_list(ae)")
      .all()
      .map((i) => i.name),
  ).toEqual(["ae_dataset_ts"]);
  expect((await b.dispatch({ op: "ae.query", dataset: "M", limit: 2 })).count).toBe(5);
  expect(counter(db, "OTHER")).toBe(2);
  // a writer without the counter code (an older broker, a rollback) is still counted: the triggers live in the file
  db.query("INSERT INTO ae VALUES ('M', ?, '[]', '[]', '[]')").run(Date.now());
  expect((await b.dispatch({ op: "ae.query", dataset: "M", limit: 1 })).count).toBe(6);
  // opened again, nothing is rebuilt or recounted
  expect((await open(path).dispatch({ op: "ae.query", dataset: "M", limit: 1 })).count).toBe(6);
});

test("query() keeps its result shape and reads the newest point from the index", async () => {
  const { path, db } = setup();
  const b = open(path);
  expect(await b.dispatch({ op: "ae.query", dataset: "M", limit: 3 })).toEqual({ ok: true, count: 0, rows: [] });
  await b.dispatch({ op: "ae.write", dataset: "M", blobs: ["first"], indexes: ["i"] });
  await b.dispatch({ op: "ae.write", dataset: "M", blobs: ["second"] });
  const q = await b.dispatch({ op: "ae.query", dataset: "M", limit: 5 });
  expect(Object.keys(q)).toEqual(["ok", "count", "rows"]);
  expect(q.count).toBe(2);
  expect(arr(q.rows).map((r) => arr(obj(r).blobs)[0])).toEqual(["second", "first"]);
  expect(Object.keys(obj(arr(q.rows)[0]))).toEqual(["timestamp", "indexes", "blobs", "doubles"]);
  const plan = db
    .query<{ detail: string }, [string, number]>(
      "EXPLAIN QUERY PLAN SELECT ts FROM ae WHERE dataset = ? ORDER BY ts DESC, rowid DESC LIMIT ?",
    )
    .all("M", 1)
    .map((r) => r.detail)
    .join(" | ");
  expect(plan).toContain("ae_dataset_ts");
  expect(plan).not.toContain("TEMP B-TREE");
});

test("a write removes points older than 92 days, at most 1,000 at a time, and the count stays exact", async () => {
  expect(AE_MAX_AGE_MS).toBe(92 * DAY);
  const { path, db } = setup();
  await write(open(path)); // creates the tables
  const now = Date.now();
  fill(db, "M", 2500, now - 93 * DAY); // all older than 92 days
  fill(db, "M", 10, now - 91 * DAY); // all younger
  fill(db, "OTHER", 5, now - 200 * DAY); // another dataset's old points are left to its own writes
  expect(counter(db, "M")).toBe(2511);

  const worker = open(path);
  await write(worker);
  expect(count(db, "M")).toBe(2511 + 1 - 1000);
  expect(counter(db, "M")).toBe(count(db, "M"));
  // within the same 10 s the broker does not prune again: a write stays one insert
  await write(worker);
  expect(count(db, "M")).toBe(2511 + 2 - 1000);
  // a broker that starts later works the backlog off, batch by batch, and keeps every point under 92 days
  await write(open(path));
  await write(open(path));
  expect(
    db.query<{ n: number }, [number]>("SELECT count(*) AS n FROM ae WHERE dataset = 'M' AND ts < ?").get(now - 92 * DAY)
      ?.n,
  ).toBe(0);
  expect(count(db, "M")).toBe(10 + 1 + 4);
  expect(counter(db, "M")).toBe(15);
  expect(count(db, "OTHER")).toBe(5);
  expect(counter(db, "OTHER")).toBe(5);
  expect((await open(path).dispatch({ op: "ae.query", dataset: "M", limit: 1 })).count).toBe(15);
});

test("a dataset holds at most 1,000,000 points: the oldest go first", async () => {
  expect(AE_MAX_ROWS).toBe(1_000_000);
  const { path, db } = setup();
  await write(open(path));
  const now = Date.now();
  fill(db, "M", 1_000_500, now - 60_000); // younger than 92 days, 500 over the cap with the one written above
  expect(counter(db, "M")).toBe(1_000_501);
  await write(open(path));
  expect(counter(db, "M")).toBe(1_000_000);
  expect(count(db, "M")).toBe(1_000_000);
  const oldest = db.query<{ t: number }, []>("SELECT min(ts) AS t FROM ae WHERE dataset = 'M'").get()?.t ?? 0;
  expect(oldest).toBeGreaterThan(now - 60_000 - 1_000_500 * 1000 + 500 * 1000 - 1);
});

test("100,000 points: query({limit:1}) stays fast", async () => {
  const { path, db } = setup();
  const b = open(path);
  await write(b);
  fill(db, "M", 100_000, Date.now() - 1000);
  await b.dispatch({ op: "ae.query", dataset: "M", limit: 1 });
  const t0 = performance.now();
  for (let i = 0; i < 20; i++)
    expect((await b.dispatch({ op: "ae.query", dataset: "M", limit: 1 })).count).toBe(100_001);
  // the full scan took about 8 ms here; the index and the counter take well under 1 ms
  expect((performance.now() - t0) / 20).toBeLessThan(5);
});

test("the age rule and the cap share one run's 1,000-point budget", async () => {
  const { path, db } = setup();
  await write(open(path));
  const now = Date.now();
  fill(db, "M", 1000, now - 93 * DAY); // expired
  fill(db, "M", 1_001_000, now - 60_000); // young, over the cap
  expect(counter(db, "M")).toBe(1_002_001);
  await write(open(path));
  expect(counter(db, "M")).toBe(1_002_002 - 1000); // not 2,000 gone
  expect(count(db, "M")).toBe(counter(db, "M"));
});
