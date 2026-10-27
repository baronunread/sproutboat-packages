// The D1 shim (`env.DB`) over the broker's D1 store (the production platform's path),
// at a compatibility date before and after 2026-10-24. The embedded transport's half is
// test/native-d1.ts.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createD1Store } from "../../wire/src/d1";

const source = readFileSync(new URL("./native-fetch-prelude.js", import.meta.url), "utf8");
let store;
// oxlint-disable-next-line no-function-constructor -- the prelude is prepended as text in production too
const { makeD1 } = new Function(
  "Porffor",
  "__testCall",
  `${source}\n__sbCall = __testCall; return { makeD1: __sbMakeD1 };`,
)({ c: () => "" }, (json) => {
  const msg = JSON.parse(json);
  try {
    return JSON.stringify(store.execute({ owner: "app", key: "app/DB", path: ":memory:", name: "DB", msg }));
  } catch (error) {
    return JSON.stringify({ ok: false, error: error.message });
  }
});
const fresh = (date) => {
  globalThis.__sbCompat = date;
  store?.close();
  store = createD1Store();
  return makeD1("DB");
};
const caught = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.message;
  }
  return "did not throw";
};
// The message a call fails with, synchronously or as a rejected Promise.
const failure = async (fn) => {
  try {
    await fn();
  } catch (error) {
    return error.message;
  }
  return "did not throw";
};
const NO_STATEMENTS = "D1_ERROR: No SQL statements detected.";
const WRONG_COUNT = "D1_ERROR: Wrong number of parameter bindings for SQL query.";

for (const date of ["2026-09-28", "2026-10-24"]) {
  test(`${date}: bytes bind as a BLOB, and the parameters after them are kept`, async () => {
    const DB = fresh(date);
    await DB.exec("CREATE TABLE t (a TEXT, b BLOB, c TEXT)");
    const insert = DB.prepare("INSERT INTO t VALUES (?, ?, ?)");
    await insert.bind("u8", new Uint8Array([0, 255, 7]), "after").run();
    await insert.bind("ab", new Uint8Array([1, 2]).buffer, "after").run();
    await insert.bind("view", new DataView(new Uint8Array([9, 8, 7]).buffer, 1, 2), "after").run();
    expect((await DB.prepare("SELECT a, hex(b) AS h, typeof(b) AS t, c FROM t ORDER BY rowid").all()).results).toEqual([
      { a: "u8", h: "00FF07", t: "blob", c: "after" },
      { a: "ab", h: "0102", t: "blob", c: "after" },
      { a: "view", h: "0807", t: "blob", c: "after" },
    ]);
  });

  test(`${date}: batch() is one transaction`, async () => {
    const DB = fresh(date);
    await DB.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    expect(await failure(() => DB.batch([DB.prepare("INSERT INTO t VALUES (1)"), DB.prepare("INSERT INTO t VALUES (1)")]))).toMatch(/UNIQUE/);
    expect(await DB.prepare("SELECT count(*) AS n FROM t").first("n")).toBe(0);
  });
}

test("before 2026-10-24: synchronous, lenient, no foreign keys, BLOBs as one char per byte", () => {
  const DB = fresh("2026-09-28");
  const result = DB.prepare("SELECT 1 AS a").all();
  expect(result.then).toBeUndefined();
  expect(result.results).toEqual([{ a: 1 }]);
  // (bun:sqlite has always refused a wrong parameter count here; the embedded transport has not.)
  expect(DB.prepare("SELECT ?1 AS a").bind(undefined).first()).toEqual({ a: null });
  expect(DB.exec("CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (p INTEGER REFERENCES p(id))").count).toBe(1);
  DB.prepare("INSERT INTO c VALUES (99)").run();
  expect(DB.prepare("SELECT x'00ff' AS b").first("b")).toBe("\u0000ÿ");
  expect(DB.prepare("SELECT 1 AS a").first("nope")).toBeUndefined();
  expect(caught(() => DB.prepare("SELEC 1").all())).toMatch(/^sproutboat d1\.query: /);
});

test("from 2026-10-24: D1's parameter rules", async () => {
  const DB = fresh("2026-10-24");
  expect(caught(() => DB.prepare("SELECT ?1").bind(undefined))).toBe("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
  expect(caught(() => DB.prepare("SELECT ?1").bind({ a: 1 }))).toBe("D1_TYPE_ERROR: Type 'object' not supported for value '[object Object]'");
  expect(caught(() => DB.prepare("SELECT ?1").bind(10n))).toBe("D1_TYPE_ERROR: Type 'bigint' not supported for value '10'");
  expect(await failure(() => DB.prepare("SELECT ?1, ?2").bind(1).all())).toBe(WRONG_COUNT);
  expect(await failure(() => DB.prepare("SELECT ?1").bind(1, 2).all())).toBe(WRONG_COUNT);
  expect(await failure(() => DB.prepare("SELECT ?1").all())).toBe(WRONG_COUNT);
  expect(await DB.prepare("SELECT ?1 AS a, ?1 AS b, ?2 AS c").bind("x", true).first()).toEqual({ a: "x", b: "x", c: 1 });
});

test("from 2026-10-24: foreign keys, BLOBs as byte arrays, D1's error text", async () => {
  const DB = fresh("2026-10-24");
  await DB.exec("CREATE TABLE p (id INTEGER PRIMARY KEY)\nCREATE TABLE c (p INTEGER REFERENCES p(id))");
  expect(await failure(() => DB.prepare("INSERT INTO c VALUES (99)").run())).toBe(
    "D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)",
  );
  await DB.prepare("INSERT INTO p VALUES (1)").run();
  expect(await failure(() => DB.prepare("INSERT INTO p VALUES (1)").run())).toBe(
    "D1_ERROR: UNIQUE constraint failed: p.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)",
  );
  expect(await failure(() => DB.prepare("SELECT * FROM nope").all())).toBe("D1_ERROR: no such table: nope: SQLITE_ERROR");
  expect(await DB.prepare("SELECT x'00ff' AS b").first("b")).toEqual([0, 255]);
});

test("from 2026-10-24: every query method returns a Promise", async () => {
  const DB = fresh("2026-10-24");
  const s = DB.prepare("SELECT 41 AS a");
  for (const p of [s.all(), s.run(), s.first(), s.raw(), DB.batch([s]), DB.exec("SELECT 1"), DB.dump().catch(() => 0)]) expect(p).toBeInstanceOf(Promise);
  expect(await s.first("a").then((a) => a + 1)).toBe(42);
  expect(await Promise.all([s.first("a"), DB.prepare("SELECT 2 AS a").first("a")])).toEqual([41, 2]);
  // Errors reject rather than throw: .catch() sees them.
  expect(await DB.prepare("SELEC 1").all().catch((e) => e.message)).toMatch(/^D1_ERROR: near "SELEC": syntax error/);
});

test("from 2026-10-24: results, meta, raw() and first() as in workerd", async () => {
  const DB = fresh("2026-10-24");
  await DB.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
  const inserted = await DB.prepare("INSERT INTO t (name) VALUES (?), (?)").bind("one", "two").run();
  expect(Object.keys(inserted).sort()).toEqual(["meta", "results", "success"]);
  expect(Object.keys(inserted.meta).sort()).toEqual(["changed_db", "changes", "duration", "last_row_id", "rows_read", "rows_written", "served_by", "size_after"]);
  expect([inserted.meta.changes, inserted.meta.last_row_id, inserted.meta.changed_db, inserted.meta.rows_written]).toEqual([2, 2, true, 2]);
  const read = await DB.prepare("SELECT id, name FROM t ORDER BY id").all();
  expect([read.meta.changes, read.meta.changed_db, read.meta.rows_written]).toEqual([0, false, 0]);
  expect(await DB.prepare("SELECT id, name FROM t ORDER BY id").raw()).toEqual([[1, "one"], [2, "two"]]);
  expect(await DB.prepare("SELECT id, name FROM t ORDER BY id").raw({ columnNames: true })).toEqual([["id", "name"], [1, "one"], [2, "two"]]);
  expect(await DB.prepare("SELECT id FROM t WHERE id > 9").raw({ columnNames: true })).toEqual([["id"]]);
  expect(await DB.prepare("SELECT 1 AS a, 2 AS a").raw({ columnNames: true })).toEqual([["a", "a"], [1, 2]]);
  expect((await DB.prepare("SELECT 1 AS a, 2 AS a").all()).results).toEqual([{ a: 2 }]);
  expect(await failure(() => DB.prepare("SELECT id FROM t").first("nope"))).toBe("D1_COLUMN_NOTFOUND: Column not found (nope)");
  expect(await DB.prepare("SELECT id FROM t WHERE id > 9").first("nope")).toBeNull();
});

test("from 2026-10-24: empty SQL, transactions, exec() and sessions as in workerd", async () => {
  const DB = fresh("2026-10-24");
  expect(await failure(() => DB.prepare("").all())).toBe(NO_STATEMENTS);
  expect(await failure(() => DB.batch([]))).toBe(NO_STATEMENTS);
  expect(await failure(() => DB.prepare("BEGIN TRANSACTION").run())).toMatch(/^D1_ERROR: To execute a transaction, please use the state\.storage\.transaction\(\)/);
  expect(await failure(() => DB.prepare("savepoint x").run())).toMatch(/^D1_ERROR: To execute a transaction/);
  const done = await DB.exec("CREATE TABLE t (id INTEGER)\nINSERT INTO t VALUES (1);\n\nINSERT INTO t VALUES (2);\n");
  expect([done.count, Number.isFinite(done.duration)]).toEqual([3, true]);
  expect(await DB.exec("SELECT 1").then((r) => r.count)).toBe(1);
  expect(await failure(() => DB.exec("INSERT INTO t VALUES (3);\nSELEC 2"))).toMatch(/^D1_EXEC_ERROR: Error in line 2: SELEC 2: near "SELEC": syntax error/);
  expect(await DB.prepare("SELECT count(*) AS n FROM t").first("n")).toBe(2);
  const session = DB.withSession("first-unconstrained");
  expect(await session.prepare("SELECT count(*) AS n FROM t").first("n")).toBe(2);
  expect(session.getBookmark()).toBeNull();
  expect(await session.batch([session.prepare("SELECT 1 AS a")]).then((r) => r[0].results)).toEqual([{ a: 1 }]);
});

test("from 2026-10-24: only transaction statements are refused, whatever their case or leading space", async () => {
  const DB = fresh("2026-10-24");
  const TRANSACTION = /^D1_ERROR: To execute a transaction/;
  for (const sql of [
    "BEGIN",
    "begin immediate",
    "  \n Commit",
    "END",
    "end transaction",
    "ROLLBACK TO x",
    "rollback",
    "SAVEPOINT a",
    "Release a",
    "RELEASE SAVEPOINT a",
  ]) {
    expect(await failure(() => DB.prepare(sql).run())).toMatch(TRANSACTION);
  }
  for (const sql of ["", "  ", "\n\t"]) expect(await failure(() => DB.prepare(sql).run())).toBe(NO_STATEMENTS);
  await DB.exec("CREATE TABLE t (id INTEGER, s TEXT)");
  // Statements that begin with the same first letter as a keyword, and the second letters that tell them apart.
  for (const sql of [
    "SELECT 1",
    "select 1",
    "  SELECT 1",
    "REPLACE INTO t VALUES (1, 'a')",
    "replace into t values (2, 'b')",
    "CREATE INDEX i ON t (id)",
    "EXPLAIN SELECT 1",
    "RETURNING",
    "SAVE",
    "BE",
    "ENDX",
    "WITH x AS (SELECT 1) SELECT * FROM x",
  ]) {
    const message = await failure(() => DB.prepare(sql).run());
    expect(message).not.toMatch(TRANSACTION);
    expect(message).not.toBe(NO_STATEMENTS);
  }
  expect(await DB.prepare("SELECT count(*) AS n FROM t").first("n")).toBe(2);
  // batch() checks every statement.
  expect(await failure(() => DB.batch([DB.prepare("SELECT 1"), DB.prepare("commit")]))).toMatch(TRANSACTION);
});

test("from 2026-10-24: raw() and first() answer the same as all(), and all() still has its meta", async () => {
  const DB = fresh("2026-10-24");
  await DB.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT, n REAL, b BLOB)");
  const insert = await DB.prepare("INSERT INTO t (s, n, b) VALUES (?, ?, ?)")
    .bind("x", 1.5, new Uint8Array([1, 2]))
    .run();
  expect(insert.meta).toMatchObject({
    served_by: "sproutboat",
    changes: 1,
    last_row_id: 1,
    changed_db: true,
    rows_written: 1,
  });
  const select = DB.prepare("SELECT id, s, n, b FROM t WHERE id = ?").bind(1);
  const all = await select.all();
  expect(all.results).toEqual([{ id: 1, s: "x", n: 1.5, b: [1, 2] }]);
  expect(all.meta.rows_read).toBe(1);
  expect(await select.raw()).toEqual([[1, "x", 1.5, [1, 2]]]);
  expect(await select.raw({ columnNames: true })).toEqual([
    ["id", "s", "n", "b"],
    [1, "x", 1.5, [1, 2]],
  ]);
  expect(await select.first()).toEqual(all.results[0]);
  expect(await select.first("s")).toBe("x");
  expect(await failure(() => select.first("nope"))).toMatch(/^D1_COLUMN_NOTFOUND/);
  // Parameter types that skip the buffer test, and the ones that do not.
  const types = DB.prepare("SELECT ? AS a, ? AS b, ? AS c, ? AS d, ? AS e");
  expect(await types.bind(null, true, 7, "s", new Uint8Array([9])).first()).toEqual({
    a: null,
    b: 1,
    c: 7,
    d: "s",
    e: [9],
  });
  expect(await failure(() => types.bind(undefined, 1, 1, 1, 1).first())).toMatch(/^D1_TYPE_ERROR: Type 'undefined'/);
});
