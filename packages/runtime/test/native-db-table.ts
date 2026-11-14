import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The handle table of the embedded transport (plan 018 phase 1), compiled directly against the system SQLite:
// the slot LRU, the single close function, the cache sizing rules, the object-database slot count.
// A C driver runs one scenario per process (the table is process-global) and prints one JSON line.
// SB_TEST_SQLITE_DIR=DIR (sqlite3.h and a built sqlite3.o, the amalgamation the host uses) runs it against that instead;
// SB_DB_TABLE_BENCH=1 also prints the E7 timings (adaptive cache against a fixed 2 MiB).
const transport = await readFile(new URL("../src/transport-embedded.js", import.meta.url), "utf8");
const ltxStart = transport.indexOf("// BEGIN LTX NATIVE"),
  ltxEnd = transport.indexOf("// END LTX NATIVE", ltxStart);
const tableStart = transport.indexOf("// BEGIN DB TABLE NATIVE"),
  tableEnd = transport.indexOf("// END DB TABLE NATIVE", tableStart);
assert(ltxStart > 0 && ltxEnd > ltxStart && tableStart > ltxEnd && tableEnd > tableStart);
const work = await mkdtemp(join(tmpdir(), "sb-native-dbtable-"));
const source = `
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <time.h>
#include <errno.h>
// These four lines are transport-embedded.js's globals above the LTX block: keep them equal.
#define SB_MAX_DB 64
static sqlite3* sb_dbs[SB_MAX_DB];
static char sb_db_names[SB_MAX_DB][256];
static int sb_db_count = 0;
${transport.slice(ltxStart, ltxEnd)}
${transport.slice(tableStart, tableEnd)}
static char root[512];
static void path_of(char* out, const char* kind, int i) {
  // object databases live under /do-sql/CLASS/, D1-style ones under /d1/
  if (!strcmp(kind, "do")) snprintf(out, 600, "%s/do-sql/C/%064x.sqlite", root, i);
  else snprintf(out, 600, "%s/d1/db%d.sqlite", root, i);
}
static void sql(int idx, const char* q) { char* e = 0; if (sqlite3_exec(sb_dbs[idx], q, 0, 0, &e)) { printf("{\\"error\\":\\"%s: %s\\"}\\n", q, e); exit(1); } }
static long scalar(int idx, const char* q) { sqlite3_stmt* st; long v = -1; if (!sqlite3_prepare_v2(sb_dbs[idx], q, -1, &st, 0)) { if (sqlite3_step(st) == 100) v = sqlite3_column_int64(st, 0); sqlite3_finalize(st); } return v; }
static void stats(void) { char b[600]; sb_db_stats(b, sizeof b); printf("{\\"stats\\":%s}\\n", b); }
static double ms_since(struct timespec* a) { struct timespec b; clock_gettime(CLOCK_MONOTONIC, &b); return ((b.tv_sec - a->tv_sec) * 1e9 + (b.tv_nsec - a->tv_nsec)) / 1e6; }
int main(int argc, char** argv) {
  snprintf(root, sizeof root, "%s", argv[1]);
  const char* scenario = argv[2];
  char p[600];
  sb_sqlite_boot();
  if (!strcmp(scenario, "slots")) { printf("{\\"slots\\":%d,\\"targetKb\\":%ld}\\n", sb_do_sql_open, sb_cache_target_kb); return 0; }
  if (!strcmp(scenario, "fifty")) {
    // 50 object databases through the slots: each reads back what it wrote after being closed and reopened
    int bad = 0, max_open = 0;
    for (int i = 0; i < 50; i++) {
      path_of(p, "do", i); int idx = sb_db_for(p); if (idx < 0) { printf("{\\"error\\":\\"open %d\\"}\\n", i); return 1; }
      sql(idx, "CREATE TABLE IF NOT EXISTS t (v INTEGER)"); char q[64]; snprintf(q, sizeof q, "INSERT INTO t VALUES (%d)", i * 7); sql(idx, q);
      int open = 0; for (int k = 0; k < sb_db_count; k++) if (sb_dbs[k]) open++; if (open > max_open) max_open = open;
    }
    for (int r = 0; r < 2; r++) for (int i = 49; i >= 0; i--) {
      path_of(p, "do", i); int idx = sb_db_for(p); if (idx < 0 || scalar(idx, "SELECT v FROM t") != i * 7) bad++;
    }
    stats(); printf("{\\"bad\\":%d,\\"maxOpen\\":%d}\\n", bad, max_open); return 0;
  }
  if (!strcmp(scenario, "txn")) {
    // a handle inside a transaction is never the one the LRU closes, and do.sql.close refuses it
    path_of(p, "do", 0); int a = sb_db_for(p); sql(a, "CREATE TABLE t (v)"); sql(a, "BEGIN"); sql(a, "INSERT INTO t VALUES (1)");
    for (int i = 1; i <= sb_do_sql_open + 3; i++) { path_of(p, "do", i); int idx = sb_db_for(p); if (idx < 0) { printf("{\\"error\\":\\"open %d\\"}\\n", i); return 1; } sql(idx, "CREATE TABLE IF NOT EXISTS t (v)"); }
    path_of(p, "do", 0); int refused = sb_db_close_path(p); int still = sb_db_for(p) == a;
    sql(a, "COMMIT"); int closed = sb_db_close_path(p);
    printf("{\\"refused\\":%d,\\"still\\":%d,\\"closed\\":%d}\\n", refused, still, closed); return 0;
  }
  if (!strcmp(scenario, "nowal")) {
    path_of(p, "do", 5); int idx = sb_db_for(p); sql(idx, "CREATE TABLE t (v)"); for (int i = 0; i < 100; i++) sql(idx, "INSERT INTO t VALUES (1)");
    char wal[700]; snprintf(wal, sizeof wal, "%s-wal", p); struct stat st; int walBefore = !stat(wal, &st);
    int closed = sb_db_close_path(p); int walAfter = !stat(wal, &st); snprintf(wal, sizeof wal, "%s-shm", p); int shmAfter = !stat(wal, &st);
    int again = sb_db_close_path(p);
    printf("{\\"walBefore\\":%d,\\"closed\\":%d,\\"walAfter\\":%d,\\"shmAfter\\":%d,\\"again\\":%d}\\n", walBefore, closed, walAfter, shmAfter, again); return 0;
  }
  if (!strcmp(scenario, "share")) {
    // opens N D1-style databases (not limited by the object slots) and reports each size
    int n = atoi(argv[3]); long sum = 0, mx = 0, mn = 1 << 30;
    for (int i = 0; i < n; i++) { path_of(p, "d1", i); int idx = sb_db_for(p); if (idx < 0) { printf("{\\"error\\":\\"open %d\\"}\\n", i); return 1; } sql(idx, "CREATE TABLE IF NOT EXISTS t (v)"); }
    for (int i = 0; i < sb_db_count; i++) if (sb_dbs[i]) { sum += sb_cache_kb[i]; if (sb_cache_kb[i] > mx) mx = sb_cache_kb[i]; if (sb_cache_kb[i] < mn) mn = sb_cache_kb[i]; }
    printf("{\\"n\\":%d,\\"sumKb\\":%ld,\\"maxKb\\":%ld,\\"minKb\\":%ld,\\"shareKb\\":%d}\\n", n, sum, mx, mn, sb_cache_share_kb()); return 0;
  }
  if (!strcmp(scenario, "growshrink")) {
    path_of(p, "d1", 0); int idx = sb_db_for(p); sql(idx, "CREATE TABLE t (v TEXT)");
    sql(idx, "BEGIN"); for (int i = 0; i < 12000; i++) sql(idx, "INSERT INTO t VALUES (hex(randomblob(100)))"); sql(idx, "COMMIT");
    int start = sb_cache_kb[idx];
    for (int i = 0; i < 400; i++) { idx = sb_db_for(p); scalar(idx, "SELECT sum(length(v)) FROM t"); }
    int grown = sb_cache_kb[idx];
    for (int i = 1; i < 32; i++) { char q[600]; path_of(q, "d1", i); int j = sb_db_for(q); sql(j, "CREATE TABLE IF NOT EXISTS t (v)"); }
    long sum = 0; for (int i = 0; i < sb_db_count; i++) if (sb_dbs[i]) sum += sb_cache_kb[i];
    printf("{\\"start\\":%d,\\"grown\\":%d,\\"after\\":%d,\\"sumKb\\":%ld,\\"targetKb\\":%ld,\\"grow\\":%lu,\\"shrink\\":%lu}\\n", start, grown, sb_cache_kb[0], sum, sb_cache_target_kb, sb_stat_grow, sb_stat_shrink); return 0;
  }
  if (!strcmp(scenario, "small")) {
    // one small D1-style database, a few queries: how much SQLite memory does the worker hold
    path_of(p, "d1", 0); int idx = sb_db_for(p); sql(idx, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    for (int i = 0; i < 40; i++) { char q[100]; snprintf(q, sizeof q, "INSERT INTO t (v) VALUES ('row %d')", i); sql(idx, q); }
    for (int i = 0; i < 100; i++) { idx = sb_db_for(p); scalar(idx, "SELECT count(*) FROM t"); }
    stats(); return 0;
  }
  if (!strcmp(scenario, "bench")) {
    // E7 (plan 016's G13): 200 calls of a 20-row feed after a cold open, then three scans of 50 MB
    path_of(p, "d1", 0); int idx = sb_db_for(p); sql(idx, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    sql(idx, "BEGIN"); for (int i = 0; i < 250000; i++) sql(idx, "INSERT INTO t (v) VALUES (hex(randomblob(100)))"); sql(idx, "COMMIT");
    sb_db_close_path(p);
    struct timespec a; double scan[3];
    idx = sb_db_for(p); clock_gettime(CLOCK_MONOTONIC, &a);
    for (int i = 0; i < 200; i++) { idx = sb_db_for(p); sqlite3_stmt* st; sqlite3_prepare_v2(sb_dbs[idx], "SELECT id, v FROM t ORDER BY id DESC LIMIT 20", -1, &st, 0); while (sqlite3_step(st) == 100) {} sqlite3_finalize(st); }
    double feed = ms_since(&a) * 1000 / 200;
    for (int r = 0; r < 3; r++) { idx = sb_db_for(p); clock_gettime(CLOCK_MONOTONIC, &a); scalar(idx, "SELECT sum(length(v)) FROM t"); scan[r] = ms_since(&a); }
    printf("{\\"feedUs\\":%.1f,\\"scanMs\\":[%.1f,%.1f,%.1f],\\"cacheKb\\":%d}\\n", feed, scan[0], scan[1], scan[2], sb_cache_kb[idx]); return 0;
  }
  if (!strcmp(scenario, "busy")) {
    path_of(p, "do", 9); int idx = sb_db_for(p); sql(idx, "CREATE TABLE t (v)"); sql(idx, "INSERT INTO t VALUES (1)");
    sqlite3_stmt* leaked = 0; sqlite3_prepare_v2(sb_dbs[idx], "SELECT v FROM t", -1, &leaked, 0); sqlite3_step(leaked);
    int first = sb_db_close_path(p); int open = sb_dbs[idx] != 0; unsigned long busy = sb_stat_busy;
    sqlite3_finalize(leaked); int second = sb_db_close_path(p);
    printf("{\\"first\\":%d,\\"stillOpen\\":%d,\\"busy\\":%lu,\\"second\\":%d}\\n", first, open, busy, second); return 0;
  }
  return 2;
}
`;
await Bun.write(join(work, "driver.c"), source);
const binary = join(work, "driver");
const amalgamation = process.env.SB_TEST_SQLITE_DIR;
const compile = Bun.spawnSync(
  amalgamation
    ? [
        "cc",
        "-O2",
        `-I${amalgamation}`,
        join(work, "driver.c"),
        join(amalgamation, "sqlite3.o"),
        "-lm",
        "-ldl",
        "-lpthread",
        "-o",
        binary,
      ]
    : ["cc", "-O1", join(work, "driver.c"), "-lsqlite3", "-o", binary],
);
assert.equal(compile.exitCode, 0, compile.stderr.toString());

async function run(scenario: string, env: Record<string, string> = {}, ...extra: string[]) {
  const dir = await mkdtemp(join(work, "run-"));
  const p = Bun.spawnSync([binary, dir, scenario, ...extra], { env: { PATH: process.env.PATH ?? "", ...env } });
  assert.equal(p.exitCode, 0, `${scenario}: ${p.stdout.toString()} ${p.stderr.toString()}`);
  const lines = p.stdout
    .toString()
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  return { lines, dir, last: lines[lines.length - 1] };
}
const MB32 = String(32 << 20);
try {
  // the slot count: clamp(T / 160 KiB, 8, 48) with T = limit / 8
  assert.equal((await run("slots", { SB_MEMORY_LIMIT: MB32 })).last.slots, 25);
  assert.equal((await run("slots", { SB_MEMORY_LIMIT: String(16 << 20) })).last.slots, 12);
  assert.equal((await run("slots", { SB_MEMORY_LIMIT: String(9 << 20) })).last.slots, 8);
  assert.equal((await run("slots", { SB_MEMORY_LIMIT: String(1024 << 20) })).last.slots, 48);
  assert.equal((await run("slots")).last.slots, 48, "no limit: 48 slots");
  assert.equal((await run("slots", { SB_MEMORY_LIMIT: MB32 })).last.targetKb, 4096);

  // 50 object databases through the slots (plan 013 phase D's "50 objects through 8 slots", without capture)
  const fifty = await run("fifty", { SB_MEMORY_LIMIT: MB32 });
  assert.equal(fifty.last.bad, 0);
  assert(fifty.last.maxOpen <= 25, `at most 25 object databases open, saw ${fifty.last.maxOpen}`);
  assert.equal(fifty.lines[0].stats.busy, 0);
  assert(fifty.lines[0].stats.closes >= 25);
  const eight = await run("fifty", { SB_MEMORY_LIMIT: String(9 << 20) });
  assert.equal(eight.last.bad, 0);
  assert(eight.last.maxOpen <= 8);

  // a handle inside a transaction is not closed by the LRU nor by do.sql.close
  const txn = await run("txn", { SB_MEMORY_LIMIT: String(9 << 20) });
  assert.deepEqual(txn.last, { refused: -1, still: 1, closed: 1 });

  // a close after a write leaves one clean file: no -wal, no -shm; closing again is a no-op
  // (macOS's system SQLite keeps an emptied -wal and its -shm after the last close whatever the caller does: there the
  // test checks the WAL was truncated; the Linux amalgamation, which sproutd and the standalone binary use, deletes both.)
  const nowal = await run("nowal", { SB_MEMORY_LIMIT: MB32 });
  assert.equal(nowal.last.walBefore, 1);
  assert.equal(nowal.last.closed, 1);
  assert.equal(nowal.last.again, 0);
  const files = await readdir(join(nowal.dir, "do-sql/C"));
  if (process.platform === "darwin") {
    for (const f of files.filter((f) => f.endsWith("-wal")))
      assert.equal((await stat(join(nowal.dir, "do-sql/C", f))).size, 0, "the WAL was checkpointed and truncated");
  } else {
    assert.deepEqual(nowal.last, { walBefore: 1, closed: 1, walAfter: 0, shmAfter: 0, again: 0 });
    assert.equal(files.length, 1, files.join(","));
  }

  // the share rule: 256 KiB each up to 16 open, shrinking toward T / n above that; the sum stays under T
  for (const n of [1, 4, 16, 32]) {
    const r = (await run("share", { SB_MEMORY_LIMIT: MB32 }, String(n))).last;
    assert(r.sumKb <= 4096, `n=${n}: ${JSON.stringify(r)}`);
    assert(r.maxKb <= 256, `n=${n}: starts at 256 KiB, saw ${r.maxKb}`);
    if (n <= 16) assert.equal(r.minKb, 256, `n=${n}`);
    else assert(r.maxKb <= Math.max(128, r.shareKb) + 128, `n=${n}: ${JSON.stringify(r)}`);
  }
  const unlimited = (await run("share", {}, "32")).last;
  assert.equal(unlimited.minKb, 256, "no limit: 256 KiB each, no shrinking");
  // SB_SQLITE_CACHE_MB keeps its old meaning: a fixed size
  const fixed = (await run("share", { SB_SQLITE_CACHE_MB: "3", SB_MEMORY_LIMIT: MB32 }, "20")).last;
  assert.equal(fixed.minKb, 3072);
  assert.equal(fixed.maxKb, 3072);

  // growth on evidence, then shrink when more databases open
  const gs = (await run("growshrink", { SB_MEMORY_LIMIT: MB32 })).last;
  assert.equal(gs.start, 256);
  assert(gs.grown > 256 && gs.grown <= 2048, JSON.stringify(gs));
  assert(gs.grow > 0 && gs.shrink > 0, JSON.stringify(gs));
  assert(gs.after <= 256 && gs.sumKb <= gs.targetKb, JSON.stringify(gs));

  // a leaked statement: sqlite3_close says BUSY, the slot stays open and is counted, never close_v2
  const busy = (await run("busy", { SB_MEMORY_LIMIT: MB32 })).last;
  assert.deepEqual(busy, { first: -1, stillOpen: 1, busy: 1, second: 1 });

  // one small D1 database: well under 300 KiB of SQLite memory (E7)
  const small = (await run("small", { SB_MEMORY_LIMIT: MB32 })).last;
  assert(small.stats.memUsed < 300 * 1024, JSON.stringify(small));

  if (process.env.SB_DB_TABLE_BENCH) {
    // E7 timing (not an assertion: machines differ): the adaptive cache against a fixed 2 MiB, interleaved
    for (const [name, env] of [
      ["fixed 2 MiB", { SB_SQLITE_CACHE_MB: "2" }],
      ["adaptive", { SB_MEMORY_LIMIT: MB32 }],
      ["fixed 2 MiB", { SB_SQLITE_CACHE_MB: "2" }],
      ["adaptive", { SB_MEMORY_LIMIT: MB32 }],
      ["fixed 2 MiB", { SB_SQLITE_CACHE_MB: "2" }],
      ["adaptive", { SB_MEMORY_LIMIT: MB32 }],
    ] as const)
      console.log(name.padEnd(12), JSON.stringify((await run("bench", env)).last));
  }
  console.log("native-db-table: ok");
} finally {
  await rm(work, { recursive: true, force: true });
}
