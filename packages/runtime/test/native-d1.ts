import assert from "node:assert/strict";
import { closeSync, openSync, readFileSync, readdirSync, readSync, writeSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The embedded transport's SQL runner (sb_sql_run and sb_bind_params), compiled from the
// transport's own inline C against the system SQLite, the way native-ltx.ts does. Only
// the C up to the D1 backup code is needed; the few runtime symbols it names are stubbed.
const transport = await readFile(new URL("../src/transport-embedded.js", import.meta.url), "utf8");
const start = transport.indexOf("Porffor.c`\n") + "Porffor.c`\n".length;
const end = transport.indexOf("// #164 — an online");
assert(start > 20 && end > start, "transport C block markers moved");
const work = await mkdtemp(join(tmpdir(), "sb-native-d1-"));
try {
  await writeFile(
    join(work, "bearssl.h"),
    `typedef struct { int x; } br_sha256_context;
static void br_sha256_init(br_sha256_context* c) { (void)c; }
static void br_sha256_update(br_sha256_context* c, const void* d, unsigned long n) { (void)c; (void)d; (void)n; }
static void br_sha256_out(const br_sha256_context* c, void* o) { (void)c; (void)o; }
`,
  );
  await writeFile(join(work, "block.c"), transport.slice(start, end));
  await writeFile(
    join(work, "driver.c"),
    `#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <sys/stat.h>
typedef struct { double val; int type; } jsval;
typedef uint32_t u32;
static uint32_t porf_native_fetch_alloc_bytestring(const char* d, size_t n) { (void)d; (void)n; return 0; }
#include "block.c"
const char* sb_standalone_app_name(void) { return "test"; }
// One call per line: PATH \\t SQL \\t PARAMS_JSON; one reply line each. ":break PATH" makes
// PATH's next LTX capture fail (native-ltx.ts's :break-position).
int main(void) {
  sb_ltx_compat = 1;  // __sbLtxConfigure at compatibility date 2026-10-22 or later
  char* line = 0; size_t cap = 0;
  while (getline(&line, &cap, stdin) > 0) {
    line[strcspn(line, "\\n")] = 0;
    if (!strncmp(line, ":break ", 7)) { line[strcspn(line, "\\t")] = 0; char p[1024]; snprintf(p, sizeof(p), "%s.ltx/position.tmp", line + 7); mkdir(p, 0700); puts("{}"); fflush(stdout); continue; }
    char* sql = strchr(line, '\\t'); if (!sql) return 2; *sql++ = 0;
    char* params = strchr(sql, '\\t'); if (!params) return 2; *params++ = 0;
    char* out = sb_sql_run(line, sql, params); puts(out); fflush(stdout); free(out);
  }
  return 0;
}
`,
  );
  const binary = join(work, "driver");
  const compile = Bun.spawnSync(["cc", "-O1", "-w", "-I", work, join(work, "driver.c"), "-lsqlite3", "-o", binary]);
  assert.equal(compile.exitCode, 0, compile.stderr.toString());

  const d1 = join(work, "data/d1/DB.sqlite");
  const store = join(work, "data/store.sqlite");
  const run = (calls: [string, string, unknown[]][]) => {
    const input = calls.map(([path, sql, params]) => `${path}\t${sql}\t${JSON.stringify(params)}\n`).join("");
    const p = Bun.spawnSync([binary], { stdin: Buffer.from(input) });
    assert.equal(p.exitCode, 0, p.stderr.toString());
    return p.stdout
      .toString()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  };
  const blob = (bytes: number[]) => ({ $blob: Buffer.from(bytes).toString("hex") });

  // A Uint8Array bind used to stop the parameter parse: it, and every parameter after it,
  // were stored as NULL (data loss).
  const [, , stored, other] = run([
    [d1, "CREATE TABLE t (a TEXT, b BLOB, c TEXT)", []],
    [d1, "INSERT INTO t VALUES (?1, ?2, ?3)", ["k", blob([0, 255, 127, 0x22]), "after"]],
    [d1, "SELECT a, b, typeof(b) AS bt, length(b) AS bl, c FROM t", []],
    [store, "SELECT x'00ff' AS b", []],
  ]);
  assert.deepEqual(
    stored.rows,
    [["k", { $blob: "00ff7f22" }, "blob", 4, "after"]],
    "blob stored as a BLOB, later parameters kept",
  );
  assert.equal(other.rows[0][0], String(other.rows[0][0]), "outside D1 a BLOB is still one char per byte, not hex");

  // An object that is not a blob binds NULL and the parse carries on (a "}" in a string included).
  const [, kept] = run([
    [d1, "INSERT INTO t VALUES (?1, ?2, ?3)", [{ a: "}{" }, 5, "x"]],
    [d1, "SELECT a, b, c FROM t WHERE c = 'x'", []],
  ]);
  assert.deepEqual(kept.rows, [[null, 5, "x"]]);

  // Strict D1 calls (compatibility date 2026-10-24) check the parameter count.
  const [few, many, right, reuse] = run([
    [d1, "/*sb-d1-strict*/SELECT ?1, ?2", [1]],
    [d1, "/*sb-d1-strict*/SELECT ?1", [1, 2]],
    [d1, "/*sb-d1-strict*/SELECT ?1 AS a", [1]],
    [d1, "/*sb-d1-strict*/SELECT ?1 AS a, ?1 AS b, ?2 AS c", ["x", "y"]],
  ]);
  assert.equal(few.ok, false);
  assert.equal(few.error, "Wrong number of parameter bindings for SQL query.");
  assert.equal(many.ok, false);
  assert.deepEqual(right.rows, [[1]]);
  assert.deepEqual(reuse.rows, [["x", "x", "y"]]);
  const [loose] = run([[d1, "SELECT ?1 AS a, ?2 AS b", [1]]]);
  assert.deepEqual(loose.rows, [[1, null]], "without the marker a missing parameter is NULL, as before");

  // Errors carry SQLite's extended code and the offset in the caller's SQL.
  const [syntax, unique] = run([
    [d1, "/*sb-d1-strict*/SELEC 1", []],
    [d1, "CREATE TABLE u (id INTEGER PRIMARY KEY); INSERT INTO u VALUES (1)", []],
  ]);
  assert.equal(syntax.ok, false);
  assert.equal(syntax.code, 1);
  assert.equal(syntax.offset, 0);
  assert.equal(unique.ok, true);
  const [, dup] = run([
    [d1, "INSERT INTO u VALUES (1)", []],
    [d1, "INSERT INTO u VALUES (1)", []],
  ]);
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 1555, "SQLITE_CONSTRAINT_PRIMARYKEY");

  // A read reports no changes, not the last write's.
  const [write, read] = run([
    [d1, "INSERT INTO t (a) VALUES ('z')", []],
    [d1, "SELECT count(*) FROM t", []],
  ]);
  assert.equal(write.changes, 1);
  assert.equal(read.changes, 0);
  // The transport's D1 ops (JS), on the same C: lifted from BEGIN/END D1 OPS.
  const opsStart = transport.indexOf("// BEGIN D1 OPS");
  const opsEnd = transport.indexOf("// END D1 OPS");
  assert(opsStart > 0 && opsEnd > opsStart, "D1 ops markers moved");
  // One long-lived driver, so a SAVEPOINT spans calls as it does in a worker: FIFOs give
  // the lifted (synchronous) ops a synchronous line protocol.
  const fifoIn = join(work, "in"),
    fifoOut = join(work, "out");
  assert.equal(Bun.spawnSync(["mkfifo", fifoIn, fifoOut]).exitCode, 0);
  const driver = Bun.spawn(["sh", "-c", `exec "${binary}" < "${fifoIn}" > "${fifoOut}"`], {
    env: { ...process.env, SB_LTX_ENABLE: "1", SB_LTX_DATABASE: "LTX" },
  });
  const toDriver = openSync(fifoIn, "w"),
    fromDriver = openSync(fifoOut, "r");
  let pending = "";
  const sqlRaw = (path: string, sql: string, params: string) => {
    writeSync(toDriver, `${path}\t${sql}\t${params}\n`);
    const chunk = Buffer.alloc(65536);
    while (!pending.includes("\n")) {
      const n = readSync(fromDriver, chunk, 0, chunk.length, null);
      if (n <= 0) throw new Error("driver exited");
      pending += chunk.toString("utf8", 0, n);
    }
    const line = pending.slice(0, pending.indexOf("\n"));
    pending = pending.slice(line.length + 1);
    return line;
  };
  const sql = (path: string, text: string, params: unknown[]) => {
    const r = JSON.parse(sqlRaw(path, text, JSON.stringify(params)));
    if (r.ok === false) throw new Error("sqlite: " + r.error);
    return r;
  };
  // oxlint-disable-next-line no-function-constructor -- lifting a block out of the text-only transport
  const ops = new Function(
    "__sbSqlRaw",
    "__sbSql",
    `${transport.slice(opsStart, opsEnd)}\nreturn { __sbD1Run, __sbD1Batch, __sbD1Open };`,
  )(sqlRaw, sql);
  const db2 = join(work, "data/d1/OPS.sqlite");
  ops.__sbD1Run(db2, "CREATE TABLE p (id INTEGER PRIMARY KEY)", [], false);
  ops.__sbD1Run(db2, "CREATE TABLE c (id INTEGER PRIMARY KEY, p INTEGER REFERENCES p(id))", [], false);
  // batch() is one transaction: the failing second insert undoes the first.
  assert.throws(
    () =>
      ops.__sbD1Batch(
        db2,
        [
          { sql: "INSERT INTO p VALUES (5)", params: [] },
          { sql: "INSERT INTO p VALUES (5)", params: [] },
        ],
        false,
      ),
    /UNIQUE/,
  );
  assert.equal(ops.__sbD1Run(db2, "SELECT count(*) AS n FROM p", [], false).results[0].n, 0, "batch rolled back");
  assert.equal(
    ops.__sbD1Batch(
      db2,
      [
        { sql: "INSERT INTO p VALUES (1)", params: [] },
        { sql: "INSERT INTO p VALUES (2)", params: [] },
      ],
      false,
    ).length,
    2,
  );
  // Old dates: no foreign keys, a BLOB read as one char per byte, errors as before.
  ops.__sbD1Open(db2, false);
  ops.__sbD1Run(db2, "INSERT INTO c VALUES (1, 99)", [], false);
  const oldBlob = ops.__sbD1Run(db2, "SELECT ?1 AS b", [{ $blob: "00ff" }], false).results[0].b;
  assert.equal(oldBlob, "\u0000ÿ");
  assert.throws(() => ops.__sbD1Run(db2, "SELEC 1", [], false), /^Error: sqlite: near "SELEC": syntax error$/);
  // Strict (2026-10-24): foreign keys on, rows with columns, D1's error text.
  ops.__sbD1Open(db2, true);
  assert.throws(
    () => ops.__sbD1Run(db2, "INSERT INTO c VALUES (2, 98)", [], true),
    (e: Error) =>
      e.message ===
      "D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)",
  );
  const strictRow = ops.__sbD1Run(db2, "SELECT 1 AS a, ?1 AS a", [{ $blob: "0a" }], true);
  assert.deepEqual([strictRow.columns, strictRow.rows], [["a", "a"], [[1, { $blob: "0a" }]]]);
  assert.throws(
    () => ops.__sbD1Run(db2, "SELEC 1", [], true),
    (e: Error) => e.message === 'D1_ERROR: near "SELEC": syntax error at offset 0: SQLITE_ERROR',
  );
  assert.throws(
    () => ops.__sbD1Run(db2, "INSERT INTO p VALUES (1)", [], true),
    (e: Error) =>
      e.message ===
      "D1_ERROR: UNIQUE constraint failed: p.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)",
  );
  assert.throws(
    () => ops.__sbD1Run(db2, "SELECT ?1", [], true),
    (e: Error) => e.message === "D1_ERROR: Wrong number of parameter bindings for SQL query.",
  );
  // LTX capture on (SB_LTX_ENABLE, database LTX): a batch is one commit, and a capture
  // that fails at RELEASE (after SQLite committed) surfaces as itself: SQLITE_IOERR with a
  // message that says so, never "no such savepoint" from the cleanup, and the database then
  // refuses writes until restart.
  const ltx = join(work, "data/d1/LTX.sqlite");
  const generation = () => join(ltx + ".ltx", readFileSync(ltx + ".ltx/position", "utf8").split("\n")[1]);
  const ltxFiles = () => readdirSync(generation()).filter((n) => n.endsWith(".ltx")).length;
  ops.__sbD1Open(ltx, true);
  ops.__sbD1Run(ltx, "CREATE TABLE e (id INTEGER PRIMARY KEY, v TEXT)", [], true);
  const beforeBatch = ltxFiles();
  ops.__sbD1Batch(
    ltx,
    [
      { sql: "INSERT INTO e VALUES (1, 'a')", params: [] },
      { sql: "INSERT INTO e VALUES (2, 'b')", params: [] },
    ],
    true,
  );
  assert.equal(ltxFiles(), beforeBatch + 1, "a batch is one LTX commit");
  // Break capture just before the batch's RELEASE.
  // oxlint-disable-next-line no-function-constructor -- lifting a block out of the text-only transport
  const breaking = new Function(
    "__sbSqlRaw",
    "__sbSql",
    `${transport.slice(opsStart, opsEnd)}\nreturn { __sbD1Run, __sbD1Batch };`,
  )((path: string, text: string, params: string) => {
    if (text === "RELEASE sb_d1_batch") sqlRaw(":break " + path, "", "");
    return sqlRaw(path, text, params);
  }, sql);
  const LTX_FAILED =
    "D1_ERROR: LTX capture failed: the transaction may be committed locally but is not durable in the replication log; writes are refused until restart: SQLITE_IOERR";
  assert.throws(
    () => breaking.__sbD1Batch(ltx, [{ sql: "INSERT INTO e VALUES (3, 'c')", params: [] }], true),
    (e: Error) => e.message === LTX_FAILED,
  );
  assert.throws(
    () => ops.__sbD1Run(ltx, "INSERT INTO e VALUES (4, 'd')", [], true),
    (e: Error) => e.message === LTX_FAILED,
    "writes refused after a capture failure",
  );
  assert.throws(
    () => ops.__sbD1Run(ltx, "SELECT 1", [], false),
    /^Error: sqlite: LTX capture failed/,
    "old dates see the same failure",
  );
  closeSync(toDriver);
  closeSync(fromDriver);
  await driver.exited;
  console.log(
    "native d1: sb_sql_run and the D1 ops pass (blob binds, atomic batch, strict counts, foreign keys, error text)",
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
