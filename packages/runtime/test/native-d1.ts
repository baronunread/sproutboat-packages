import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { restore } from "./ltx-restore";
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
    if (!strncmp(line, ":db ", 4)) { int r = sql[0] == 'p' ? sb_db_page_size(line + 4) : sb_db_quota_freeze(line + 4, sql[0] == 'c' ? -1 : sql[0] == 'f'); printf("{\\"n\\":%d}\\n", r); fflush(stdout); continue; }
    if (!strncmp(line, ":bytes ", 7)) { line[strcspn(line, "\\t")] = 0; printf("{\\"n\\":%lld}\\n", sb_dir_bytes(line + 7, 0)); fflush(stdout); continue; }
    // ":cells PATH": the same statement through sb_sql_run_x with cells, printed as JSON the test
    // can compare with sb_sql_run's rows: TEXT as \\uXXXX units (sb_text_units), BLOB as {"$blob":hex}.
    if (!strncmp(line, ":cells ", 7)) {
      sb_cells cs = { 0, 0, 0, 0, 0 };
      char* head = sb_sql_run_x(line + 7, sql, params, &cs);
      // A result has no JSON header: its column names are the first cells and its counts are in cs.
      if (head) printf("{\\"head\\":%s,\\"rows\\":[", head);
      else {
        printf("{\\"head\\":{\\"ok\\":true,\\"cols\\":[");
        for (int c = 0; c < cs.hdr; c++) printf(c ? ",\\"%.*s\\"" : "\\"%.*s\\"", cs.c[c].n, cs.a + cs.c[c].off);
        printf("],\\"changes\\":%lld,\\"rowid\\":%lld},\\"rows\\":[", cs.changes, cs.rowid);
      }
      size_t nrow = cs.ncol ? (cs.n - (size_t)cs.hdr) / (size_t)cs.ncol : 0;
      for (size_t r = 0; r < nrow; r++) {
        printf(r ? ",[" : "[");
        for (int c = 0; c < cs.ncol; c++) {
          sb_cell* x = &cs.c[(size_t)cs.hdr + r * (size_t)cs.ncol + (size_t)c];
          if (c) printf(",");
          if (x->t == 0) printf("null");
          else if (x->t == 1) printf("%.17g", x->d);
          else if (x->t == 2) {
            uint16_t* u = (uint16_t*)malloc((size_t)x->n * 2 + 2); int wide = 0;
            size_t k = sb_text_units((const unsigned char*)(cs.a + x->off), (size_t)x->n, u, &wide);
            printf("\\"");
            for (size_t i = 0; i < k; i++) printf("\\\\u%04x", u[i]);
            printf("\\"");
            free(u);
          } else { printf("{\\"$blob\\":\\""); for (int i = 0; i < x->n; i++) printf("%02x", (unsigned char)cs.a[x->off + i]); printf("\\"}"); }
        }
        printf("]");
      }
      printf("]}\\n"); fflush(stdout); sb_cells_free(&cs); free(head); continue;
    }
    // ":script PATH" runs SQL as a script (sb_sql_script, what exec() uses).
    char* out = !strncmp(line, ":script ", 8) ? sb_sql_script(line + 8, sql) : sb_sql_run(line, sql, params); puts(out); fflush(stdout); free(out);
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

  // Strict rows handed over as cells (the JS arrays are built from them in C) hold exactly what
  // the JSON rows hold: NULL, integers, floats, ASCII, Latin-1, BMP and astral text, every kind
  // of invalid UTF-8, a BLOB, and no rows at all.
  const cellRun = (sql: string, params: unknown[] = []) => {
    const input = `:cells ${d1}\t/*sb-d1-strict*/${sql}\t${JSON.stringify(params)}\n${d1}\t/*sb-d1-strict*/${sql}\t${JSON.stringify(params)}\n`;
    const out = Bun.spawnSync([binary], { stdin: Buffer.from(input) });
    assert.equal(out.exitCode, 0, out.stderr.toString());
    const [cells, json] = out.stdout
      .toString()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    return { cells, json };
  };
  const bad = [
    "x'80'",
    "x'c0af'",
    "x'c3'",
    "x'e282'",
    "x'f09f9880'",
    "x'f0'",
    "x'eda080'",
    "x'f4908080'",
    "x'e0809a'",
    "x'41c342'",
    "x'ffff'",
    "x'c3a9e282'",
  ];
  const texts = [
    "''",
    "'plain ascii'",
    "'caf\u00e9'",
    "'\u4e1c\u4eac'",
    "'x\u{1F680}y'",
    "'\u00ff\u0100'",
    "char(113, 34, 92, 10, 9, 1, 127)",
    ...bad.map((b) => `CAST(${b} AS TEXT)`),
  ];
  for (const t of texts) {
    const { cells, json } = cellRun(`SELECT ${t} AS t, 7 AS i, 2.5 AS f, NULL AS n, x'00ff7f' AS b, ${t} || 'z' AS u`);
    assert.equal(cells.head.ok, true);
    assert.deepEqual(cells.rows, json.rows, `cells equal the JSON rows for ${t}`);
    assert.deepEqual(cells.head.cols, json.cols);
    assert.equal(cells.head.changes, json.changes);
    assert.equal(cells.head.rowid, json.rowid);
  }
  const empty = cellRun("SELECT a FROM t WHERE 0");
  assert.deepEqual(empty.cells.rows, []);
  assert.deepEqual(empty.json.rows, []);
  const wide = cellRun("SELECT * FROM t");
  assert.deepEqual(wide.cells.rows, wide.json.rows, "a table with a BLOB and NULLs");
  const failed = cellRun("SELECT nope FROM nowhere");
  assert.equal(failed.cells.head.ok, false);

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
  let driverClosed = false;
  const sqlRaw = (path: string, sql: string, params: string) => {
    if (driverClosed) throw new Error("original D1 driver is closed");
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
  const scriptRaw = (path: string, text: string) => sqlRaw(":script " + path, text, "[]");
  // __sbSqlRowsRaw as the transport's C block gives it: an error is [header JSON], a result is
  // ["", rows, columns, changes, rowid], BLOBs as byte arrays.
  const rowsOf =
    (raw: (path: string, text: string, params: string) => string) => (path: string, text: string, params: string) => {
      const r = JSON.parse(raw(":cells " + path, text, params));
      if (r.head.ok === false) return [JSON.stringify(r.head)];
      const rows = r.rows.map((row: unknown[]) =>
        row.map((c) => (c instanceof Object && "$blob" in c ? [...Buffer.from(String(c.$blob), "hex")] : c)),
      );
      return ["", rows, r.head.cols, r.head.changes, r.head.rowid];
    };
  const ops = new Function(
    "__sbSqlRaw",
    "__sbSql",
    "__sbSqlScriptRaw",
    "__sbSqlRowsRaw",
    `${transport.slice(opsStart, opsEnd)}\nreturn { __sbD1Run, __sbD1Batch, __sbD1Open, __sbD1ExecLines };`,
  )(sqlRaw, sql, scriptRaw, rowsOf(sqlRaw));
  // The storage quota, lifted from "The storage quota" to __sbStore, for DIR and LIMIT.
  const quotaStart = transport.indexOf("// The storage quota: an app's data directory");
  const quotaEnd = transport.indexOf("function __sbStore() {");
  assert(quotaStart > 0 && quotaEnd > quotaStart, "quota block moved");
  const liftQuota = (dir: string, limit: number) =>
    new Function(
      "__sbEnv",
      "__sbDir",
      "__sbDirBytesRaw",
      "__sbD1DbRaw",
      "__sbD1Captured_",
      "__sbSql",
      "__sbSqlRaw",
      `${transport.slice(quotaStart, quotaEnd)}\nreturn { __sbQuotaCheck, __sbD1Quota, __sbQuotaFull, expire() { __sbQuotaAt = -1; } };`,
    )(
      (name: string) => (name === "SB_STORAGE_MAX_BYTES" ? String(limit) : ""),
      () => dir,
      (d: string) => String(JSON.parse(sqlRaw(":bytes " + d, "", "")).n),
      (path: string, what: string) => String(JSON.parse(sqlRaw(":db " + path, what, "")).n),
      (path: string) => JSON.parse(sqlRaw(":db " + path, "c", "")).n,
      sql,
      sqlRaw,
    );
  const dirBytes = (d: string) => Number(JSON.parse(sqlRaw(":bytes " + d, "", "")).n);
  // Another driver process (a restarted worker), with its own FIFOs and lifted blocks.
  const connect = (tag: string) => {
    const inPath = join(work, "in-" + tag),
      outPath = join(work, "out-" + tag);
    assert.equal(Bun.spawnSync(["mkfifo", inPath, outPath]).exitCode, 0);
    const child = Bun.spawn(["sh", "-c", `exec "${binary}" < "${inPath}" > "${outPath}"`], {
      env: { ...process.env, SB_LTX_ENABLE: "1", SB_LTX_DATABASE: "LTX" },
    });
    const to = openSync(inPath, "w"),
      from = openSync(outPath, "r");
    let buffered = "";
    const raw = (path: string, text: string, params: string) => {
      writeSync(to, `${path}\t${text}\t${params}\n`);
      const chunk = Buffer.alloc(65536);
      while (!buffered.includes("\n")) {
        const n = readSync(from, chunk, 0, chunk.length, null);
        if (n <= 0) throw new Error("driver exited");
        buffered += chunk.toString("utf8", 0, n);
      }
      const line = buffered.slice(0, buffered.indexOf("\n"));
      buffered = buffered.slice(line.length + 1);
      return line;
    };
    const run = (path: string, text: string, params: unknown[]) => {
      const r = JSON.parse(raw(path, text, JSON.stringify(params)));
      if (r.ok === false) throw new Error("sqlite: " + r.error);
      return r;
    };
    // oxlint-disable-next-line no-function-constructor -- lifting a block out of the text-only transport
    const lifted = new Function(
      "__sbSqlRaw",
      "__sbSql",
      "__sbSqlScriptRaw",
      "__sbSqlRowsRaw",
      `${transport.slice(opsStart, opsEnd)}\nreturn { __sbD1Run, __sbD1Batch, __sbD1Open, __sbD1ExecLines };`,
    )(raw, run, (path: string, text: string) => raw(":script " + path, text, "[]"), rowsOf(raw));
    const lift = (dir: string, limit: number) =>
      // oxlint-disable-next-line no-function-constructor -- lifting a block out of the text-only transport
      new Function(
        "__sbEnv",
        "__sbDir",
        "__sbDirBytesRaw",
        "__sbD1DbRaw",
        "__sbD1Captured_",
        "__sbSql",
        "__sbSqlRaw",
        `${transport.slice(quotaStart, quotaEnd)}\nreturn { __sbQuotaCheck, __sbD1Quota, __sbQuotaFull };`,
      )(
        (name: string) => (name === "SB_STORAGE_MAX_BYTES" ? String(limit) : ""),
        () => dir,
        (d: string) => String(JSON.parse(raw(":bytes " + d, "", "")).n),
        (path: string, what: string) => String(JSON.parse(raw(":db " + path, what, "")).n),
        (path: string) => JSON.parse(raw(":db " + path, "c", "")).n,
        run,
        raw,
      );
    return {
      sqlRaw: raw,
      ops: lifted,
      liftQuota: lift,
      exited: child.exited,
      close: () => (closeSync(to), closeSync(from)),
    };
  };
  // exec() from 2026-10-24: line by line, all or nothing, the failing line named.
  const ex = join(work, "data/d1/EXEC.sqlite");
  ops.__sbD1ExecLines(ex, ["CREATE TABLE x (id INTEGER)", "INSERT INTO x VALUES (1); INSERT INTO x VALUES (2);"]);
  assert.throws(
    () => ops.__sbD1ExecLines(ex, ["INSERT INTO x VALUES (3);", "SELEC 2"]),
    (e: Error) => e.message === 'D1_EXEC_ERROR: Error in line 2: SELEC 2: near "SELEC": syntax error',
  );
  assert.equal(ops.__sbD1Run(ex, "SELECT count(*) AS n FROM x", [], false).results[0].n, 2, "exec rolled back");
  // From 2026-11-03 (parity): D1's text, with the failing statement's own offset (counted from its first
  // non-space character) and SQLite's result code.
  const parityError = (lines: string[]) => {
    try {
      ops.__sbD1ExecLines(ex, lines, true);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    return "did not throw";
  };
  const parityCases: [string[], string][] = [
    [
      ["INSERT INTO x VALUES (3); SELEC 2"],
      'Error in line 1: INSERT INTO x VALUES (3); SELEC 2: near "SELEC": syntax error at offset 0: SQLITE_ERROR',
    ],
    [["SELEC 2"], 'Error in line 1: SELEC 2: near "SELEC": syntax error at offset 0: SQLITE_ERROR'],
    [["SELECT 1;", "  SELEC 3"], 'Error in line 2:   SELEC 3: near "SELEC": syntax error at offset 2: SQLITE_ERROR'],
    [["/*c*/ SELEC 1"], 'Error in line 1: /*c*/ SELEC 1: near "SELEC": syntax error at offset 6: SQLITE_ERROR'],
    [["SELECT * FROM nope"], "Error in line 1: SELECT * FROM nope: no such table: nope: SQLITE_ERROR"],
    [["SELECT 1,"], "Error in line 1: SELECT 1,: incomplete input: SQLITE_ERROR"],
  ];
  for (const [lines, text] of parityCases) assert.equal(parityError(lines), "D1_EXEC_ERROR: " + text);
  ops.__sbD1ExecLines(ex, ["CREATE TABLE ux (a UNIQUE)", "INSERT INTO ux VALUES (1)"], true);
  assert.equal(
    parityError(["INSERT INTO ux VALUES (1)"]),
    "D1_EXEC_ERROR: Error in line 1: INSERT INTO ux VALUES (1): UNIQUE constraint failed: ux.a: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)",
  );
  // From 2026-11-03 (multi): a statement with more behind it runs them all, in one savepoint, and answers with the last.
  const mdb = join(work, "data/d1/MULTI.sqlite");
  const multi = (sql: string, params: unknown[] = []) => ops.__sbD1Run(mdb, sql, params, true, true);
  const multiError = (sql: string, params: unknown[] = []) => {
    try {
      multi(sql, params);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    return "did not throw";
  };
  multi("CREATE TABLE m (id INTEGER PRIMARY KEY, name TEXT, v TEXT UNIQUE)");
  const two = multi("INSERT INTO m (id) VALUES (7); INSERT INTO m (id) VALUES (8)");
  assert.deepEqual([two.meta.changes, two.meta.last_row_id, two.rows.length], [2, 8, 0]);
  assert.equal(multi("INSERT INTO m (id) VALUES (10); UPDATE m SET name = 'x'").meta.changes, 4);
  assert.deepEqual(multi("SELECT 1 AS a; SELECT 2 AS b").columns, ["b"]);
  assert.deepEqual(multi("SELECT 1; SELECT ? AS p", [5]).rows, [[5]]);
  assert.equal(multi("INSERT INTO m (id) VALUES (30); INSERT INTO m (id) VALUES (31); ").meta.changes, 2);
  const mcount = () => ops.__sbD1Run(mdb, "SELECT count(*) FROM m", [], true, true).rows[0][0];
  const mbefore = mcount();
  assert.equal(
    multiError("INSERT INTO m (id) VALUES (40); garbage"),
    'D1_ERROR: near "garbage": syntax error at offset 0: SQLITE_ERROR',
  );
  assert.match(
    multiError("INSERT INTO m (id, v) VALUES (41, 'a'); INSERT INTO m (id, v) VALUES (42, 'a')"),
    /^D1_ERROR: UNIQUE constraint failed: m\.v: SQLITE_CONSTRAINT/,
  );
  assert.equal(
    multiError("INSERT INTO m (id) VALUES (?); INSERT INTO m (id) VALUES (?)", [50, 51]),
    "D1_ERROR: When executing multiple SQL statements in a single call, only the last statement can have parameters.",
  );
  assert.equal(multiError("SELECT 1;;"), "D1_ERROR: SQL code did not contain a statement.");
  assert.equal(multiError("SELECT 1; -- c"), "D1_ERROR: SQL code did not contain a statement.");
  assert.equal(
    multiError("SELECT 1; SELECT ? AS p", [1, 2]),
    "D1_ERROR: Wrong number of parameter bindings for SQL query.",
  );
  assert.equal(mcount(), mbefore, "a failing script left nothing behind");
  assert.equal(
    ops.__sbD1Run(mdb, "INSERT INTO m (id) VALUES (60); INSERT INTO m (id) VALUES (61)", [], true, false).meta.changes,
    1,
    "without multi only the first runs",
  );
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
  assert.deepEqual([strictRow.columns, strictRow.rows], [["a", "a"], [[1, [10]]]]);
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
  // With capture on, an authorization failure says so (it read "not an error" once capture
  // had run), and the quota works: its page size comes from capture, not from the
  // page_size pragma the capture authorizer refuses.
  assert.throws(
    () => ops.__sbD1Run(ltx, "PRAGMA page_size", [], true),
    (e: Error) => e.message === "D1_ERROR: not authorized: SQLITE_AUTH",
  );
  assert.throws(
    () => ops.__sbD1ExecLines(ltx, ["PRAGMA journal_mode = DELETE"]),
    (e: Error) => e.message === "D1_EXEC_ERROR: Error in line 1: PRAGMA journal_mode = DELETE: not authorized",
  );
  const data = join(work, "data");
  const roomy = liftQuota(data, dirBytes(data) + (1 << 20));
  roomy.__sbD1Quota(ltx);
  ops.__sbD1Run(ltx, "INSERT INTO e VALUES (10, 'under the quota')", [], true);
  assert.equal(ops.__sbD1Run(ltx, "SELECT v FROM e WHERE id = 10", [], true).rows[0][0], "under the quota");
  // Over the quota with capture on, every write is refused, a same-size UPDATE and a DELETE
  // too (each would add an LTX file to the spool), and the spool stops growing; reads and
  // read-only batches still run. Under the quota again, writes resume.
  const tight = liftQuota(data, 1);
  tight.__sbD1Quota(ltx);
  const spool = ltxFiles();
  const QUOTA =
    "D1_ERROR: storage quota exceeded: writes are refused while this app's data, including its replication log, is over its quota: SQLITE_FULL";
  for (const write of [
    "INSERT INTO e VALUES (11, 'x')",
    "UPDATE e SET v = 'y' WHERE id = 10",
    "DELETE FROM e WHERE id = 10",
  ])
    assert.throws(
      () => ops.__sbD1Run(ltx, write, [], true),
      (e: Error) => e.message === QUOTA,
      write,
    );
  assert.throws(
    () => ops.__sbD1ExecLines(ltx, ["UPDATE e SET v = 'z'"]),
    (e: Error) => e.message.startsWith("D1_EXEC_ERROR: Error in line 1: UPDATE e SET v = 'z': storage quota exceeded"),
  );
  assert.throws(
    () =>
      ops.__sbD1Batch(
        ltx,
        [
          { sql: "SELECT 1", params: [] },
          { sql: "DELETE FROM e", params: [] },
        ],
        true,
      ),
    (e: Error) => e.message === QUOTA,
  );
  assert.equal(
    ops.__sbD1Batch(ltx, [{ sql: "SELECT count(*) FROM e", params: [] }], true).length,
    1,
    "a read-only batch runs",
  );
  assert.equal(ops.__sbD1Run(ltx, "SELECT v FROM e WHERE id = 10", [], true).rows[0][0], "under the quota");
  assert.equal(ltxFiles(), spool, "no LTX file while over the quota");
  const again = liftQuota(data, dirBytes(data) + (1 << 20));
  again.__sbD1Quota(ltx);
  ops.__sbD1Run(ltx, "UPDATE e SET v = 'thawed' WHERE id = 10", [], true);
  assert.equal(ltxFiles(), spool + 1, "writes, and capture, resume under the quota");
  // Break capture just before the batch's RELEASE.
  // oxlint-disable-next-line no-function-constructor -- lifting a block out of the text-only transport
  const breaking = new Function(
    "__sbSqlRaw",
    "__sbSql",
    "__sbSqlScriptRaw",
    "__sbSqlRowsRaw",
    `${transport.slice(opsStart, opsEnd)}\nreturn { __sbD1Run, __sbD1Batch };`,
  )(
    (path: string, text: string, params: string) => {
      if (text === "RELEASE sb_d1_batch") sqlRaw(":break " + path, "", "");
      return sqlRaw(path, text, params);
    },
    sql,
    scriptRaw,
    rowsOf(sqlRaw),
  );
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
  assert.throws(
    () => ops.__sbD1ExecLines(ltx, ["INSERT INTO e VALUES (5, 'e')"]),
    (e: Error) =>
      e.message ===
      "D1_ERROR: LTX capture failed: the transaction may be committed locally but is not durable in the replication log; writes are refused until restart: SQLITE_IOERR",
    "exec() after a capture failure",
  );
  const qdir = join(work, "quota");
  const qdb = join(qdir, "d1/Q.sqlite");
  const quota = liftQuota(qdir, 262144);
  ops.__sbD1Run(qdb, "CREATE TABLE q (b BLOB)", [], true);
  quota.__sbD1Quota(qdb);
  quota.__sbQuotaCheck("KV put()");
  // Fill to the limit: a database is capped at the quota, so growth past it fails with
  // SQLITE_FULL; then the directory is over, a KV write is refused, and reads and deletes
  // keep working. VACUUM gives the space back and writes resume.
  let rows = 0;
  assert.throws(
    () => {
      for (; rows < 64; rows++) ops.__sbD1Run(qdb, "INSERT INTO q VALUES (zeroblob(65536))", [], true);
    },
    (e: Error) => e.message === "D1_ERROR: database or disk is full: SQLITE_FULL",
  );
  assert(rows >= 2 && rows < 5, "filled to about 256 KiB: " + rows);
  quota.expire();
  assert.equal(quota.__sbQuotaFull(), true);
  assert.throws(
    () => quota.__sbQuotaCheck("KV put()"),
    /^Error: KV put\(\) failed: storage quota exceeded \(this app stores \d+ bytes; the limit is 262144\)$/,
  );
  quota.__sbD1Quota(qdb);
  assert.equal(ops.__sbD1Run(qdb, "SELECT count(*) FROM q", [], true).rows[0][0], rows, "reads still work");
  ops.__sbD1Run(qdb, "DELETE FROM q", [], true);
  ops.__sbD1Run(qdb, "VACUUM", [], true);
  // No checkpoint by the app: over the quota the runtime checkpoints and truncates the WAL
  // (once a second) before measuring again, so DELETE and VACUUM alone make room.
  await Bun.sleep(1000);
  quota.expire();
  quota.__sbD1Quota(qdb);
  quota.__sbQuotaCheck("KV put()");
  ops.__sbD1Run(qdb, "INSERT INTO q VALUES (zeroblob(65536))", [], true);
  driverClosed = true;
  closeSync(toDriver);
  closeSync(fromDriver);
  await driver.exited;

  // A restart that finds the app over its quota, capture on: the first D1 call of the new
  // worker (process) already freezes. Reads work, writes are refused, the spool and its
  // position stay exactly as they were, and the chain restores the database byte for byte.
  // A capture failure still reads as one, over the quota too.
  await rm(ltx + ".ltx/position.tmp", { recursive: true, force: true });
  const second = connect("restart");
  const quota2 = second.liftQuota(data, 1);
  quota2.__sbD1Quota(ltx);
  const spoolBefore = readdirSync(generation()).sort();
  const positionBefore = readFileSync(ltx + ".ltx/position", "utf8");
  const count = second.ops.__sbD1Run(ltx, "SELECT count(*) FROM e", [], true).rows[0][0];
  for (const write of ["INSERT INTO e VALUES (20, 'x')", "UPDATE e SET v = v", "DELETE FROM e"])
    assert.throws(
      () => second.ops.__sbD1Run(ltx, write, [], true),
      (e: Error) => e.message === QUOTA,
      "restart, over the quota: " + write,
    );
  assert.deepEqual(readdirSync(generation()).sort(), spoolBefore, "no LTX file after a clean resume over the quota");
  assert.equal(readFileSync(ltx + ".ltx/position", "utf8"), positionBefore, "the position is unchanged");
  second.close();
  await second.exited;
  {
    const live = new Database(ltx);
    live.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    assert.equal(live.query("SELECT count(*) AS n FROM e").get()?.n, count);
    live.close();
    const restored = join(work, "restart-restored.sqlite");
    await restore(generation(), restored);
    assert.deepEqual(
      await readFile(restored),
      await readFile(ltx),
      "the retained chain restores the database byte for byte",
    );
  }
  const third = connect("failure");
  const thirdBytes = Number(JSON.parse(third.sqlRaw(":bytes " + data, "", "")).n);
  third.liftQuota(data, thirdBytes + (1 << 20)).__sbD1Quota(ltx);
  const breaking3 = (path: string, text: string, params: string) => {
    if (text.startsWith("INSERT INTO e VALUES (30")) third.sqlRaw(":break " + path, "", "");
    return third.sqlRaw(path, text, params);
  };
  const brokenWrite = JSON.parse(breaking3(ltx, "INSERT INTO e VALUES (30, 'x')", "[]"));
  assert.equal(brokenWrite.code, 10, "a capture failure reports SQLITE_IOERR");
  const failed3 = JSON.parse(third.sqlRaw(ltx, "INSERT INTO e VALUES (31, 'y')", "[]"));
  assert.equal(failed3.code, 10, "after a capture failure, writes report it");
  third.liftQuota(data, 1).__sbD1Quota(ltx);
  const failedOver = JSON.parse(third.sqlRaw(ltx, "INSERT INTO e VALUES (32, 'z')", "[]"));
  assert.equal(failedOver.code, 10, "over the quota too, the capture failure is what a write reports");
  assert.match(failedOver.error, /^LTX capture failed/);
  third.close();
  await third.exited;
  // Locking mode. This driver is the transport on its own, as sproutd and the broker embed it (no
  // standalone shim): unset it must stay shared, so those hosts behave as before. SB_SQLITE_EXCLUSIVE=1 is
  // exclusive for a plain database; anything else, 0 included, is shared. A database under LTX replication
  // is never exclusive.
  const lockingMode = (env: Record<string, string>, path: string) => {
    const e = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "SB_SQLITE_EXCLUSIVE"));
    const p = Bun.spawnSync([binary], {
      stdin: Buffer.from(`${path}\tPRAGMA locking_mode\t[]\n`),
      env: { ...e, ...env },
    });
    assert.equal(p.exitCode, 0, p.stderr.toString());
    return JSON.parse(p.stdout.toString().trim()).rows[0][0];
  };
  const lockDb = join(work, "data/d1/LOCK.sqlite");
  assert.equal(lockingMode({}, lockDb), "normal", "the bare transport keeps shared locking unless asked");
  assert.equal(lockingMode({ SB_SQLITE_EXCLUSIVE: "0" }, lockDb), "normal");
  assert.equal(lockingMode({ SB_SQLITE_EXCLUSIVE: "1" }, lockDb), "exclusive");
  assert.equal(lockingMode({ SB_SQLITE_EXCLUSIVE: "1" }, join(work, "data/d1/LOCK2.sqlite")), "exclusive");
  console.log(
    "native d1: sb_sql_run and the D1 ops pass (blob binds, atomic batch, strict counts, foreign keys, error text)",
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
