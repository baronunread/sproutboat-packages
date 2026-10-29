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
    expect(
      await failure(() => DB.batch([DB.prepare("INSERT INTO t VALUES (1)"), DB.prepare("INSERT INTO t VALUES (1)")])),
    ).toMatch(/UNIQUE/);
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
  expect(caught(() => DB.prepare("SELECT ?1").bind(undefined))).toBe(
    "D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'",
  );
  expect(caught(() => DB.prepare("SELECT ?1").bind({ a: 1 }))).toBe(
    "D1_TYPE_ERROR: Type 'object' not supported for value '[object Object]'",
  );
  expect(caught(() => DB.prepare("SELECT ?1").bind(10n))).toBe(
    "D1_TYPE_ERROR: Type 'bigint' not supported for value '10'",
  );
  expect(await failure(() => DB.prepare("SELECT ?1, ?2").bind(1).all())).toBe(WRONG_COUNT);
  expect(await failure(() => DB.prepare("SELECT ?1").bind(1, 2).all())).toBe(WRONG_COUNT);
  expect(await failure(() => DB.prepare("SELECT ?1").all())).toBe(WRONG_COUNT);
  expect(await DB.prepare("SELECT ?1 AS a, ?1 AS b, ?2 AS c").bind("x", true).first()).toEqual({
    a: "x",
    b: "x",
    c: 1,
  });
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
  expect(await failure(() => DB.prepare("SELECT * FROM nope").all())).toBe(
    "D1_ERROR: no such table: nope: SQLITE_ERROR",
  );
  expect(await DB.prepare("SELECT x'00ff' AS b").first("b")).toEqual([0, 255]);
});

test("from 2026-10-24: every query method returns a Promise", async () => {
  const DB = fresh("2026-10-24");
  const s = DB.prepare("SELECT 41 AS a");
  for (const p of [s.all(), s.run(), s.first(), s.raw(), DB.batch([s]), DB.exec("SELECT 1"), DB.dump().catch(() => 0)])
    expect(p).toBeInstanceOf(Promise);
  expect(await s.first("a").then((a) => a + 1)).toBe(42);
  expect(await Promise.all([s.first("a"), DB.prepare("SELECT 2 AS a").first("a")])).toEqual([41, 2]);
  // Errors reject rather than throw: .catch() sees them.
  expect(
    await DB.prepare("SELEC 1")
      .all()
      .catch((e) => e.message),
  ).toMatch(/^D1_ERROR: near "SELEC": syntax error/);
});

test("from 2026-10-24: results, meta, raw() and first() as in workerd", async () => {
  const DB = fresh("2026-10-24");
  await DB.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
  const inserted = await DB.prepare("INSERT INTO t (name) VALUES (?), (?)").bind("one", "two").run();
  expect(Object.keys(inserted).sort()).toEqual(["meta", "results", "success"]);
  expect(Object.keys(inserted.meta).sort()).toEqual([
    "changed_db",
    "changes",
    "duration",
    "last_row_id",
    "rows_read",
    "rows_written",
    "served_by",
    "size_after",
  ]);
  expect([
    inserted.meta.changes,
    inserted.meta.last_row_id,
    inserted.meta.changed_db,
    inserted.meta.rows_written,
  ]).toEqual([2, 2, true, 2]);
  const read = await DB.prepare("SELECT id, name FROM t ORDER BY id").all();
  expect([read.meta.changes, read.meta.changed_db, read.meta.rows_written]).toEqual([0, false, 0]);
  expect(await DB.prepare("SELECT id, name FROM t ORDER BY id").raw()).toEqual([
    [1, "one"],
    [2, "two"],
  ]);
  expect(await DB.prepare("SELECT id, name FROM t ORDER BY id").raw({ columnNames: true })).toEqual([
    ["id", "name"],
    [1, "one"],
    [2, "two"],
  ]);
  expect(await DB.prepare("SELECT id FROM t WHERE id > 9").raw({ columnNames: true })).toEqual([["id"]]);
  expect(await DB.prepare("SELECT 1 AS a, 2 AS a").raw({ columnNames: true })).toEqual([
    ["a", "a"],
    [1, 2],
  ]);
  expect((await DB.prepare("SELECT 1 AS a, 2 AS a").all()).results).toEqual([{ a: 2 }]);
  expect(await failure(() => DB.prepare("SELECT id FROM t").first("nope"))).toBe(
    "D1_COLUMN_NOTFOUND: Column not found (nope)",
  );
  expect(await DB.prepare("SELECT id FROM t WHERE id > 9").first("nope")).toBeNull();
});

test("from 2026-10-24: empty SQL, transactions, exec() and sessions as in workerd", async () => {
  const DB = fresh("2026-10-24");
  expect(await failure(() => DB.prepare("").all())).toBe(NO_STATEMENTS);
  expect(await failure(() => DB.batch([]))).toBe(NO_STATEMENTS);
  expect(await failure(() => DB.prepare("BEGIN TRANSACTION").run())).toMatch(
    /^D1_ERROR: To execute a transaction, please use the state\.storage\.transaction\(\)/,
  );
  expect(await failure(() => DB.prepare("savepoint x").run())).toMatch(/^D1_ERROR: To execute a transaction/);
  const done = await DB.exec("CREATE TABLE t (id INTEGER)\nINSERT INTO t VALUES (1);\n\nINSERT INTO t VALUES (2);\n");
  expect([done.count, Number.isFinite(done.duration)]).toEqual([3, true]);
  expect(await DB.exec("SELECT 1").then((r) => r.count)).toBe(1);
  expect(await failure(() => DB.exec("INSERT INTO t VALUES (3);\nSELEC 2"))).toMatch(
    /^D1_EXEC_ERROR: Error in line 2: SELEC 2: near "SELEC": syntax error/,
  );
  expect(await DB.prepare("SELECT count(*) AS n FROM t").first("n")).toBe(2);
  const session = DB.withSession("first-unconstrained");
  expect(await session.prepare("SELECT count(*) AS n FROM t").first("n")).toBe(2);
  expect(session.getBookmark()).toBeNull();
  expect(await session.batch([session.prepare("SELECT 1 AS a")]).then((r) => r[0].results)).toEqual([{ a: 1 }]);
});

// __sbD1IsTransaction replaced `/^(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(text)`.
test("a statement is a transaction keyword exactly as the regular expression it replaced said", () => {
  // oxlint-disable-next-line no-function-constructor -- the prelude is prepended as text in production too
  const { isTx } = new Function("Porffor", `${source}\nreturn { isTx: __sbD1IsTransaction };`)({ c: () => "" });
  const old = (text) => /^(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(text);
  const cases = [
    "BEGIN",
    "begin",
    "Begin TRANSACTION",
    "begin;",
    "BEGIN\n",
    "commit",
    "COMMIT;",
    "end",
    "END TRANSACTION",
    "rollback to x",
    "ROLLBACK",
    "savepoint x",
    "SAVEPOINT\tx",
    "release x",
    "RELEASE",
    "beginning",
    "begin_x",
    "begin1",
    "ending",
    "endx",
    "ender",
    "committed",
    "rollbacks",
    "savepoints",
    "released",
    "select 1",
    "SELECT begin FROM t",
    "insert into t values (1)",
    "be",
    "en",
    "e",
    "",
    "BEGINX",
    "begin-",
    "end(",
    "end.",
    "release@",
    "commité",
    "xbegin",
    " begin",
    "savepoint",
    "savepointx",
    "rollback_",
    "ROLLBACKĀ",
    "bégin",
  ];
  for (const text of cases) expect([text, isTx(text)]).toEqual([text, old(text)]);
});

// From 2026-11-03: workerd's PRAGMA allow-list (the strict path only; exec lines and batch statements too).
const ALLOWED_PRAGMAS = [
  "table_list",
  "table_info(t)",
  "table_xinfo(t)",
  "index_list(t)",
  "index_info(i)",
  "index_xinfo(i)",
  "foreign_keys",
  "foreign_key_list(t)",
  "foreign_key_check",
  "quick_check",
  "optimize",
  "defer_foreign_keys",
  "case_sensitive_like",
  "recursive_triggers",
  "data_version",
  "legacy_alter_table",
  "reverse_unordered_selects",
  "ignore_check_constraints",
];
const NOT_AUTHORIZED = "D1_ERROR: not authorized: SQLITE_AUTH";
test("from 2026-11-03: PRAGMAs outside D1's allow-list are refused, the allowed ones run", async () => {
  const DB = fresh("2026-11-03");
  await DB.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT);\nCREATE INDEX i ON t (a)");
  for (const pragma of ALLOWED_PRAGMAS)
    expect(await failure(() => DB.prepare(`PRAGMA ${pragma}`).all())).not.toBe(NOT_AUTHORIZED);
  expect((await DB.prepare("PRAGMA table_info(t)").raw()).map((c) => c[1])).toEqual(["id", "a"]);
  expect(await DB.prepare("PRAGMA foreign_keys").first("foreign_keys")).toBe(1);
  for (const sql of [
    "PRAGMA user_version",
    "PRAGMA user_version = 3",
    "pragma integrity_check",
    "PRAGMA journal_mode",
    "PRAGMA page_count",
    "PRAGMA TABLE_INFO(t)",
    "PRAGMA Foreign_Keys",
    "PRAGMA nonexistent",
    "PRAGMA temp.table_info(t)",
    "PRAGMA main.user_version",
    '  PRAGMA "user_version"',
    "/* x */ PRAGMA user_version",
    "-- x\nPRAGMA user_version",
  ])
    expect(await failure(() => DB.prepare(sql).run())).toBe(NOT_AUTHORIZED);
  expect(await failure(() => DB.prepare("PRAGMA main.table_info(t)").all())).not.toBe(NOT_AUTHORIZED);
  expect(await failure(() => DB.prepare('PRAGMA "table_info"(t)').all())).not.toBe(NOT_AUTHORIZED);
  expect(await failure(() => DB.prepare("PRAGMA nosuch.user_version").all())).not.toBe(NOT_AUTHORIZED);
  // not a PRAGMA at all
  expect((await DB.prepare("SELECT 'PRAGMA user_version' AS p").first()).p).toBe("PRAGMA user_version");
  expect(await failure(() => DB.batch([DB.prepare("SELECT 1"), DB.prepare("PRAGMA user_version")]))).toBe(
    NOT_AUTHORIZED,
  );
  expect(await failure(() => DB.exec("SELECT 1;\nPRAGMA user_version"))).toBe(
    "D1_EXEC_ERROR: Error in line 2: PRAGMA user_version: not authorized: SQLITE_AUTH",
  );
  expect(await failure(() => DB.exec("PRAGMA foreign_keys = ON; PRAGMA user_version = 3"))).toBe(
    "D1_EXEC_ERROR: Error in line 1: PRAGMA foreign_keys = ON; PRAGMA user_version = 3: not authorized: SQLITE_AUTH",
  );
  // a ';' inside a string does not start a statement
  expect((await DB.exec("SELECT ';PRAGMA user_version'")).count).toBe(1);
  expect((await DB.exec("PRAGMA foreign_keys = ON; PRAGMA table_info(t)")).count).toBe(1);
});

test("before 2026-11-03: every PRAGMA still runs", async () => {
  const DB = fresh("2026-11-02");
  expect(await DB.prepare("PRAGMA user_version").first("user_version")).toBe(0);
  expect((await DB.exec("PRAGMA user_version = 3")).count).toBe(1);
  expect(await DB.prepare("PRAGMA user_version").first("user_version")).toBe(3);
});

test("exec errors read as D1's: the statement's offset and SQLite's code, from 2026-11-03", async () => {
  const DB = fresh("2026-11-03");
  const text = (sql) => failure(() => DB.exec(sql));
  await DB.exec("CREATE TABLE t (id INTEGER)");
  expect(await text("INSERT INTO t (id) VALUES (1); SELEC 2")).toBe(
    'D1_EXEC_ERROR: Error in line 1: INSERT INTO t (id) VALUES (1); SELEC 2: near "SELEC": syntax error at offset 0: SQLITE_ERROR',
  );
  expect(await text("SELEC 2")).toBe(
    'D1_EXEC_ERROR: Error in line 1: SELEC 2: near "SELEC": syntax error at offset 0: SQLITE_ERROR',
  );
  expect(await text("SELECT 1;\n  SELEC 3")).toBe(
    'D1_EXEC_ERROR: Error in line 2:   SELEC 3: near "SELEC": syntax error at offset 2: SQLITE_ERROR',
  );
  expect(await text("/*c*/ SELEC 1")).toBe(
    'D1_EXEC_ERROR: Error in line 1: /*c*/ SELEC 1: near "SELEC": syntax error at offset 6: SQLITE_ERROR',
  );
  expect(await text("SELECT ';'; SELEC 1")).toBe(
    `D1_EXEC_ERROR: Error in line 1: SELECT ';'; SELEC 1: near "SELEC": syntax error at offset 0: SQLITE_ERROR`,
  );
  expect(await text("SELECT * FROM nope")).toBe(
    "D1_EXEC_ERROR: Error in line 1: SELECT * FROM nope: no such table: nope: SQLITE_ERROR",
  );
  expect(await text("SELECT 1,")).toBe("D1_EXEC_ERROR: Error in line 1: SELECT 1,: incomplete input: SQLITE_ERROR");
  await DB.exec("CREATE TABLE u (a UNIQUE); INSERT INTO u VALUES (1)");
  expect(await text("INSERT INTO u VALUES (1)")).toBe(
    "D1_EXEC_ERROR: Error in line 1: INSERT INTO u VALUES (1): UNIQUE constraint failed: u.a: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)",
  );
  // earlier dates keep the bare message
  const old = fresh("2026-11-02");
  expect(await failure(() => old.exec("SELEC 2"))).toBe(
    'D1_EXEC_ERROR: Error in line 1: SELEC 2: near "SELEC": syntax error',
  );
});

test("from 2026-11-03: a statement with no statement in it, an empty exec, and PRAGMA foreign_keys = OFF", async () => {
  const DB = fresh("2026-11-03");
  const NONE = "D1_ERROR: SQL code did not contain a statement.";
  for (const sql of [";", " ; ", "-- hi", "/* x */", "-- a\n/* b */;"])
    expect(await failure(() => DB.prepare(sql).all())).toBe(NONE);
  expect((await DB.prepare("-- c\nSELECT 1 AS a").first()).a).toBe(1);
  expect(await failure(() => DB.exec(""))).toBe("D1_EXEC_ERROR: Error in line 1: : No SQL statements detected.");
  expect(await failure(() => DB.exec(";"))).toBe(
    "D1_EXEC_ERROR: Error in line 1: ;: SQL code did not contain a statement.",
  );
  expect(await failure(() => DB.exec("SELECT 1;\n-- x"))).toBe(
    "D1_EXEC_ERROR: Error in line 2: -- x: SQL code did not contain a statement.",
  );
  await DB.exec("CREATE TABLE p (id INTEGER PRIMARY KEY);\nCREATE TABLE c (a REFERENCES p(id))");
  await DB.prepare("PRAGMA foreign_keys = OFF").run();
  expect(await DB.prepare("PRAGMA foreign_keys").first("foreign_keys")).toBe(1);
  expect(await failure(() => DB.prepare("INSERT INTO c VALUES (5)").run())).toMatch(
    /^D1_ERROR: FOREIGN KEY constraint failed/,
  );
  // earlier dates keep the old answers
  const old = fresh("2026-11-02");
  expect(await failure(() => old.exec(""))).toBe("D1_ERROR: No SQL statements detected.");
});

test("from 2026-11-03: prepare('A; B') runs every statement and answers with the last", async () => {
  const DB = fresh("2026-11-03");
  await DB.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, v TEXT UNIQUE)");
  const r = await DB.prepare("INSERT INTO t (id) VALUES (7); INSERT INTO t (id) VALUES (8)").run();
  expect([r.meta.changes, r.meta.last_row_id, r.results]).toEqual([2, 8, []]);
  expect((await DB.prepare("INSERT INTO t (id) VALUES (10); UPDATE t SET name = 'x'").run()).meta.changes).toBe(4);
  expect((await DB.prepare("SELECT 1 AS a; SELECT 2 AS b").all()).results).toEqual([{ b: 2 }]);
  expect((await DB.prepare("UPDATE t SET name = 'y'; SELECT id FROM t WHERE id = 10").all()).results).toEqual([
    { id: 10 },
  ]);
  expect(await DB.prepare("SELECT 1; SELECT 2, 3").raw()).toEqual([[2, 3]]);
  expect(
    (await DB.prepare("INSERT INTO t (id) VALUES (30); INSERT INTO t (id) VALUES (31); ").run()).meta.changes,
  ).toBe(2);
  expect((await DB.prepare("SELECT 1; SELECT ? AS p").bind(5).first()).p).toBe(5);
  // all or nothing
  const count = () => DB.prepare("SELECT count(*) AS c FROM t").first("c");
  const before = await count();
  expect(await failure(() => DB.prepare("INSERT INTO t (id) VALUES (40); garbage").run())).toBe(
    'D1_ERROR: near "garbage": syntax error at offset 0: SQLITE_ERROR',
  );
  expect(
    await failure(() =>
      DB.prepare("INSERT INTO t (id, v) VALUES (41, 'a'); INSERT INTO t (id, v) VALUES (42, 'a')").run(),
    ),
  ).toMatch(/^D1_ERROR: UNIQUE constraint failed: t\.v: SQLITE_CONSTRAINT/);
  expect(await count()).toBe(before);
  expect(
    await failure(() => DB.prepare("INSERT INTO t (id) VALUES (?); INSERT INTO t (id) VALUES (?)").bind(50, 51).run()),
  ).toBe(
    "D1_ERROR: When executing multiple SQL statements in a single call, only the last statement can have parameters.",
  );
  expect(await failure(() => DB.prepare("SELECT 1;;").all())).toBe("D1_ERROR: SQL code did not contain a statement.");
  expect(await failure(() => DB.prepare("SELECT 1; -- c").all())).toBe(
    "D1_ERROR: SQL code did not contain a statement.",
  );
  expect(await failure(() => DB.prepare("SELECT 1; PRAGMA user_version").all())).toBe(NOT_AUTHORIZED);
  expect(await failure(() => DB.prepare("SELECT 1; SELECT ? AS p").bind(1, 2).all())).toBe(WRONG_COUNT);
  expect(await count()).toBe(before);
  // a trigger body is one statement
  await DB.prepare("CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET name = 'trig' WHERE id = new.id; END").run();
  await DB.prepare("INSERT INTO t (id) VALUES (60)").run();
  expect(await DB.prepare("SELECT name FROM t WHERE id = 60").first("name")).toBe("trig");
  // before the date only the first statement runs
  const old = fresh("2026-11-02");
  await old.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
  expect((await old.prepare("INSERT INTO t (id) VALUES (1); INSERT INTO t (id) VALUES (2)").run()).meta.changes).toBe(
    1,
  );
});

test("from 2026-11-03: every number binds as a REAL, as in workerd", async () => {
  const DB = fresh("2026-11-03");
  expect(
    await DB.prepare("SELECT typeof(?1) AS a, typeof(?2) AS b, typeof(?3) AS c, typeof(?4) AS d, typeof(?5) AS e")
      .bind(1, 1.5, "1", true, null)
      .first(),
  ).toEqual({ a: "real", b: "real", c: "text", d: "real", e: "null" });
  expect(await DB.prepare("SELECT ? / ? AS d").bind(7, 2).first("d")).toBe(3.5);
  expect(await DB.prepare("SELECT :a + :a AS d, @b AS b").bind(2, 3).first()).toEqual({ d: 4, b: 3 });
  await DB.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n INT, name TEXT)");
  const r = await DB.prepare("INSERT INTO t (id, n, name) VALUES (?, ?, ?)").bind(70, 7, 7).run();
  expect([r.meta.changes, r.meta.last_row_id]).toEqual([1, 70]);
  expect(
    await DB.prepare("SELECT typeof(id) AS a, typeof(n) AS b, name, typeof(name) AS c FROM t WHERE id = ?")
      .bind(70)
      .first(),
  ).toEqual({
    a: "integer",
    b: "integer",
    name: "7.0",
    c: "text",
  });
  expect(
    (await DB.prepare("SELECT id FROM t WHERE id IN (?, ?) LIMIT ? OFFSET ?").bind(70, 71, 5, 0).all()).results,
  ).toEqual([{ id: 70 }]);
  // a '?' inside a string or a comment is not a parameter
  expect(await DB.prepare("SELECT '?' AS q, ? AS p -- ?").bind(2).first()).toEqual({ q: "?", p: 2 });
  // an error's offset counts the SQL as written
  expect(await failure(() => DB.prepare("SELECT ?, zz FROM t").bind(1).all())).toBe(
    "D1_ERROR: no such column: zz at offset 10: SQLITE_ERROR",
  );
  expect(await failure(() => DB.prepare("SELECT ?, ?, zz FROM t").bind(1, 2).all())).toBe(
    "D1_ERROR: no such column: zz at offset 13: SQLITE_ERROR",
  );
  const old = fresh("2026-11-02");
  expect(await old.prepare("SELECT typeof(?1) AS a").bind(1).first("a")).toBe("integer");
});
