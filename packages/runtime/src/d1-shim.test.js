// The D1 shim (`env.DB`) over the broker's D1 store (the production platform's path),
// at a compatibility date before and after 2026-10-23. The embedded transport's half is
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

for (const date of ["2026-09-28", "2026-10-23"]) {
  test(`${date}: bytes bind as a BLOB, and the parameters after them are kept`, () => {
    const DB = fresh(date);
    DB.exec("CREATE TABLE t (a TEXT, b BLOB, c TEXT)");
    DB.prepare("INSERT INTO t VALUES (?, ?, ?)")
      .bind("u8", new Uint8Array([0, 255, 7]), "after")
      .run();
    DB.prepare("INSERT INTO t VALUES (?, ?, ?)")
      .bind("ab", new Uint8Array([1, 2]).buffer, "after")
      .run();
    DB.prepare("INSERT INTO t VALUES (?, ?, ?)")
      .bind("view", new DataView(new Uint8Array([9, 8, 7]).buffer, 1, 2), "after")
      .run();
    expect(DB.prepare("SELECT a, hex(b) AS h, typeof(b) AS t, c FROM t ORDER BY rowid").all().results).toEqual([
      { a: "u8", h: "00FF07", t: "blob", c: "after" },
      { a: "ab", h: "0102", t: "blob", c: "after" },
      { a: "view", h: "0807", t: "blob", c: "after" },
    ]);
  });

  test(`${date}: batch() is one transaction`, () => {
    const DB = fresh(date);
    DB.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    expect(() => DB.batch([DB.prepare("INSERT INTO t VALUES (1)"), DB.prepare("INSERT INTO t VALUES (1)")])).toThrow(
      /UNIQUE/,
    );
    expect(DB.prepare("SELECT count(*) AS n FROM t").first("n")).toBe(0);
  });
}

test("before 2026-10-23: lenient parameters, no foreign keys, BLOBs as one char per byte", () => {
  const DB = fresh("2026-09-28");
  // (bun:sqlite has always refused a wrong parameter count here; the embedded transport has not.)
  expect(DB.prepare("SELECT ?1 AS a").bind(undefined).first()).toEqual({ a: null });
  DB.exec("CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (p INTEGER REFERENCES p(id))");
  DB.prepare("INSERT INTO c VALUES (99)").run();
  expect(DB.prepare("SELECT x'00ff' AS b").first("b")).toBe("\u0000ÿ");
  expect(caught(() => DB.prepare("SELEC 1").all())).toMatch(/^sproutboat d1\.query: /);
});

test("from 2026-10-23: D1's parameter rules", () => {
  const DB = fresh("2026-10-23");
  expect(caught(() => DB.prepare("SELECT ?1").bind(undefined))).toBe(
    "D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'",
  );
  expect(caught(() => DB.prepare("SELECT ?1").bind({ a: 1 }))).toBe(
    "D1_TYPE_ERROR: Type 'object' not supported for value '[object Object]'",
  );
  expect(caught(() => DB.prepare("SELECT ?1").bind(10n))).toBe(
    "D1_TYPE_ERROR: Type 'bigint' not supported for value '10'",
  );
  expect(caught(() => DB.prepare("SELECT ?1, ?2").bind(1).all())).toBe(
    "D1_ERROR: Wrong number of parameter bindings for SQL query.",
  );
  expect(caught(() => DB.prepare("SELECT ?1").bind(1, 2).all())).toBe(
    "D1_ERROR: Wrong number of parameter bindings for SQL query.",
  );
  expect(caught(() => DB.prepare("SELECT ?1").all())).toBe(
    "D1_ERROR: Wrong number of parameter bindings for SQL query.",
  );
  expect(DB.prepare("SELECT ?1 AS a, ?1 AS b, ?2 AS c").bind("x", true).first()).toEqual({ a: "x", b: "x", c: 1 });
});

test("from 2026-10-23: foreign keys, BLOBs as byte arrays, D1's error text", () => {
  const DB = fresh("2026-10-23");
  DB.exec("CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (p INTEGER REFERENCES p(id))");
  expect(caught(() => DB.prepare("INSERT INTO c VALUES (99)").run())).toBe(
    "D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)",
  );
  DB.prepare("INSERT INTO p VALUES (1)").run();
  expect(caught(() => DB.prepare("INSERT INTO p VALUES (1)").run())).toBe(
    "D1_ERROR: UNIQUE constraint failed: p.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)",
  );
  expect(caught(() => DB.prepare("SELECT * FROM nope").all())).toBe("D1_ERROR: no such table: nope: SQLITE_ERROR");
  expect(DB.prepare("SELECT x'00ff' AS b").first("b")).toEqual([0, 255]);
  expect(DB.prepare("SELECT count(*) AS n FROM p").run().meta.changes).toBe(0);
});
