import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

// Compile the exact inline C used by the embedded transport against SQLite.
// This tests WAL bytes, crash boundaries and fsync paths without a JS mock.
const transport = await readFile(new URL("../src/transport-embedded.js", import.meta.url), "utf8");
const start = transport.indexOf("// BEGIN LTX NATIVE");
const end = transport.indexOf("// END LTX NATIVE", start);
assert(start > 0 && end > start);
const work = await mkdtemp(join(tmpdir(), "sb-native-ltx-"));
const binary = join(work, "driver");
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
#include <signal.h>
#define SB_MAX_DB 16
${transport.slice(start, end)}
int main(int argc,char **argv) {
  if(argc!=2)return 2;sb_ltx_compat=1;if(sb_ltx_register())return 3;
  char lockpath[1024];snprintf(lockpath,sizeof(lockpath),"%s.ltx.lock",argv[1]);
  int lock=open(lockpath,O_RDWR|O_CREAT,0600);if(lock<0||flock(lock,LOCK_EX|LOCK_NB))return 4;
  sqlite3 *db=0;if(sqlite3_open_v2(argv[1],&db,6,"sb-ltx-bounded"))return 5;
  if(getenv("SB_LTX_TEST_AUTO_VACUUM"))sqlite3_exec(db,"PRAGMA auto_vacuum=INCREMENTAL;",0,0,0);
  if(sqlite3_exec(db,"PRAGMA journal_mode=WAL;PRAGMA cache_size=-2000;",0,0,0)||sb_ltx_start(0,db,argv[1],lock))return 6;
  puts("ready");fflush(stdout);sb_ltx_test_armed=1;
  char *line=0;size_t cap=0;
  while(getline(&line,&cap,stdin)>0) {
    if(strncmp(line,":break-position",15)==0){char p[1024];snprintf(p,sizeof(p),"%s.ltx/position.tmp",argv[1]);mkdir(p,0700);puts("0 injected");fflush(stdout);continue;}
    char *error=0;int rc=sb_ltx_states[0].failed?10:sqlite3_exec(db,line,0,0,&error);
    if(sb_ltx_after(0))rc=10;
    printf("%d %s\\n",rc,error?error:sqlite3_errmsg(db));fflush(stdout);sqlite3_free(error);
  }
  free(line);sqlite3_close(db);close(lock);return 0;
}
`;
await writeFile(join(work, "driver.c"), source);
await rm(binary, { force: true });
const compile = Bun.spawnSync(["cc", "-O2", "-DSB_LTX_TESTING", join(work, "driver.c"), "-lsqlite3", "-o", binary]);
assert.equal(compile.exitCode, 0, compile.stderr.toString());

// Independent CRC baseline in Bun. This intentionally uses BigInt, unlike C.
const table: bigint[] = [];
for (let i = 0; i < 256; i++) {
  let c = BigInt(i);
  for (let j = 0; j < 8; j++) c = (c >> 1n) ^ (c & 1n ? 0xd800000000000000n : 0n);
  table.push(c);
}
function crc(data: Uint8Array, init = 0xffffffffffffffffn) {
  let c = init;
  for (const b of data) c = table[Number((c ^ BigInt(b)) & 255n)] ^ (c >> 8n);
  return c;
}
const flag = 0x8000000000000000n,
  mask = 0xffffffffffffffffn;
function pageCrc(pgno: number, page: Uint8Array) {
  const p = new Uint8Array(4);
  new DataView(p.buffer).setUint32(0, pgno);
  return flag | (crc(page, crc(p)) ^ mask);
}

async function restore(epoch: string, output: string) {
  const files = (await readdir(epoch)).filter((n) => n.endsWith(".ltx")).sort();
  let db = new Uint8Array(0),
    checksum = 0n,
    txid = 0n;
  for (const file of files) {
    const b = new Uint8Array(await readFile(join(epoch, file)));
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    assert.equal(new TextDecoder().decode(b.subarray(0, 4)), "LTX1");
    const pageSize = v.getUint32(8),
      commit = v.getUint32(12);
    assert.equal(v.getBigUint64(16), txid + 1n);
    assert.equal(v.getBigUint64(40), checksum);
    const next = new Uint8Array(commit * pageSize);
    next.set(db.subarray(0, next.length));
    db = next;
    let offset = 100,
      hash = crc(b.subarray(0, 100));
    const entries = [];
    for (;;) {
      const begin = offset,
        pgno = v.getUint32(offset),
        flags = v.getUint16(offset + 4);
      hash = crc(b.subarray(offset, offset + 6), hash);
      offset += 6;
      if (!pgno) {
        assert.equal(flags, 0);
        break;
      }
      assert.equal(flags, 1);
      assert(pgno <= commit);
      const size = v.getUint32(offset);
      hash = crc(b.subarray(offset, offset + 4), hash);
      offset += 4;
      const stop = offset + size;
      assert(stop <= b.length);
      assert.equal(b[offset++], 0xf0);
      let literals = 15,
        byte;
      do {
        byte = b[offset++];
        literals += byte;
      } while (byte === 255);
      assert.equal(literals, pageSize);
      assert.equal(offset + pageSize, stop);
      const page = b.subarray(offset, stop);
      db.set(page, (pgno - 1) * pageSize);
      hash = crc(page, hash);
      offset = stop;
      entries.push({ pgno, offset: begin, size: stop - begin });
    }
    const indexStart = offset;
    function varint() {
      let n = 0n,
        s = 0n;
      for (let i = 0; i < 10; i++) {
        assert(offset < b.length);
        const c = b[offset++];
        n |= BigInt(c & 127) << s;
        if (c < 128) return Number(n);
        s += 7n;
      }
      throw new Error("varint overflow");
    }
    for (const entry of entries) {
      assert.equal(varint(), entry.pgno);
      assert.equal(varint(), entry.offset);
      assert.equal(varint(), entry.size);
    }
    assert.equal(varint(), 0);
    assert.equal(v.getBigUint64(offset), BigInt(offset - indexStart));
    offset += 8;
    hash = crc(b.subarray(indexStart, offset + 8), hash);
    checksum = flag;
    for (let p = 1; p <= commit; p++)
      checksum = flag | (checksum ^ pageCrc(p, db.subarray((p - 1) * pageSize, p * pageSize)));
    assert.equal(v.getBigUint64(offset), checksum, file);
    assert.equal(v.getBigUint64(offset + 8), flag | (hash ^ mask), file);
    assert.equal(offset + 16, b.length);
    txid = v.getBigUint64(24);
  }
  await writeFile(output, db);
  return { files: files.length, txid };
}
async function run(path: string, sql: string, extra: Record<string, string> = {}) {
  const child = Bun.spawn([binary, path], {
    env: { ...process.env, ...extra },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(sql);
  child.stdin.end();
  const [code, out, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  assert.equal(code, 0, error);
  assert(out.startsWith("ready\n"), out);
  return out.split("\n").slice(1).filter(Boolean);
}
async function stoppedCommit(path: string, phase: string, count = 1) {
  const child = Bun.spawn([binary, path], {
    env: { ...process.env, SB_LTX_TEST_STOP: phase, SB_LTX_TEST_COMMIT: String(count) },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  let text = "";
  async function line() {
    while (!text.includes("\n")) {
      const r = await reader.read();
      if (r.done) throw new Error("driver exited before ready: " + (await new Response(child.stderr).text()));
      text += new TextDecoder().decode(r.value);
    }
    const n = text.indexOf("\n");
    const value = text.slice(0, n);
    text = text.slice(n + 1);
    return value;
  }
  assert.equal(await line(), "ready");
  const position = await readFile(path + ".ltx/position", "utf8");
  const epoch = position.split("\n")[1];
  const sql =
    count === 2
      ? "INSERT INTO events VALUES(1,'one'); INSERT INTO events VALUES(2,'two');\n"
      : "INSERT INTO events VALUES(1,'one');\n";
  child.stdin.write(sql);
  child.stdin.flush();
  let stopped = false;
  for (let i = 0; i < 200; i++) {
    const state = Bun.spawnSync(["ps", "-o", "state=", "-p", String(child.pid)]).stdout.toString();
    if (state.includes("T")) {
      stopped = true;
      break;
    }
    if (child.exitCode !== null) break;
    await Bun.sleep(10);
  }
  child.kill("SIGKILL");
  await child.exited;
  assert(stopped, "did not reach crash boundary " + phase);
  return epoch;
}

try {
  const path = join(work, "test.sqlite");
  const sql =
    "CREATE TABLE t(id INTEGER PRIMARY KEY,value TEXT);\n" +
    Array.from({ length: 100 }, (_, i) => `INSERT INTO t VALUES(${i + 1},'row-${i + 1}');`).join("\n") +
    "\n";
  const replies = await run(path, sql);
  assert.equal(replies.length, 101);
  assert(
    replies.every((n) => n.startsWith("0 ")),
    replies.join("\n"),
  );
  const root = path + ".ltx";
  const epoch = (await readdir(root)).find((n) => n.startsWith("epoch-"));
  assert(epoch);
  const restored = join(work, "restored.sqlite");
  const result = await restore(join(root, epoch), restored);
  assert.equal(result.files, 102);
  assert.deepEqual(await readFile(restored), await readFile(path));
  const db = new Database(restored);
  assert.equal(db.query("PRAGMA integrity_check").get()?.integrity_check, "ok");
  db.close();
  const cleanPosition = await readFile(root + "/position", "utf8");
  assert(cleanPosition.split("\n")[2].startsWith("C "));
  const finishedBefore = await readdir(join(root, epoch));
  for (let n = 0; n < 5; n++) {
    await run(path, "SELECT 1;\n");
    assert.equal(await readFile(root + "/position", "utf8"), cleanPosition, "idle restart must not rewrite position");
    assert.deepEqual(await readdir(join(root, epoch)), finishedBefore, "idle restart must not rewrite a base");
    assert.equal((await readdir(root)).filter((n) => n.startsWith("epoch-")).length, 1);
  }
  // A D1 batch() (__sbD1Batch) is a SAVEPOINT around its statements, each its own call,
  // then RELEASE: one transaction, so one LTX file with the next TXID. A rolled-back batch
  // (ROLLBACK TO, then RELEASE) commits the pages it touched back unchanged: at most one
  // more LTX file, and the restored database has none of its rows.
  {
    const batchPath = join(work, "batch.sqlite");
    await run(batchPath, "CREATE TABLE b(id INTEGER PRIMARY KEY,value TEXT);\n");
    const batchRoot = batchPath + ".ltx";
    const batchEpoch = (await readdir(batchRoot)).find((n) => n.startsWith("epoch-"));
    assert(batchEpoch);
    const ltxFiles = async () => (await readdir(join(batchRoot, batchEpoch))).filter((n) => n.endsWith(".ltx")).sort();
    const before = await ltxFiles();
    const lastTxid = BigInt("0x" + before[before.length - 1].split("-")[0]);
    const replies = await run(
      batchPath,
      "SAVEPOINT sb_d1_batch;\nINSERT INTO b VALUES(1,'one');\nINSERT INTO b VALUES(2,'two');\nRELEASE sb_d1_batch;\n",
    );
    assert(
      replies.every((n) => n.startsWith("0 ")),
      replies.join("\n"),
    );
    const after = await ltxFiles();
    const added = after.filter((n) => !before.includes(n));
    assert.equal(added.length, 1, "a batch is one LTX file: " + added.join(", "));
    const [minTxid, maxTxid] = added[0]
      .replace(".ltx", "")
      .split("-")
      .map((h) => BigInt("0x" + h));
    assert.equal(minTxid, lastTxid + 1n);
    assert.equal(maxTxid, lastTxid + 1n);
    const rolledBack = await run(
      batchPath,
      "SAVEPOINT sb_d1_batch;\nINSERT INTO b VALUES(3,'three');\nROLLBACK TO sb_d1_batch;\nRELEASE sb_d1_batch;\n",
    );
    assert(
      rolledBack.every((n) => n.startsWith("0 ")),
      rolledBack.join("\n"),
    );
    assert((await ltxFiles()).length <= after.length + 1, "a rolled-back batch writes at most one LTX file");
    const batchRestore = join(work, "batch-restored.sqlite");
    await restore(join(batchRoot, batchEpoch), batchRestore);
    assert.deepEqual(await readFile(batchRestore), await readFile(batchPath));
    const check = new Database(batchRestore);
    assert.deepEqual(check.query("SELECT id, value FROM b ORDER BY id").all(), [
      { id: 1, value: "one" },
      { id: 2, value: "two" },
    ]);
    check.close();
  }
  // Size alone is not enough: an offline committed change must invalidate a clean marker.
  const offline = new Database(path);
  offline.exec("UPDATE t SET value='changed-offline' WHERE id=1");
  offline.close();
  await run(path, "SELECT 1;\n");
  const offlineEpoch = (await readFile(root + "/position", "utf8")).split("\n")[1];
  assert.notEqual(offlineEpoch, epoch);
  const offlineRestore = join(work, "offline.sqlite");
  await restore(join(root, offlineEpoch), offlineRestore);
  assert.deepEqual(await readFile(offlineRestore), await readFile(path));
  const bounded = join(work, "bounded.sqlite");
  const boundedReplies = await run(
    bounded,
    "CREATE TABLE t(v BLOB);\nINSERT INTO t VALUES(zeroblob(1000000));\nINSERT INTO t VALUES('small');\n",
    { SB_LTX_MAX_WAL_BYTES: "131072" },
  );
  assert(boundedReplies[1].startsWith("13 "), boundedReplies.join("\n"));
  assert(boundedReplies[2].startsWith("0 "), boundedReplies.join("\n"));
  const live = new Database(bounded);
  assert.equal(live.query("SELECT count(*) n FROM t").get()?.n, 1);
  assert.equal(live.query("PRAGMA integrity_check").get()?.integrity_check, "ok");
  live.close();
  const walStat = await stat(bounded + "-wal").catch(() => null);
  assert(!walStat || walStat.size <= 131072);
  const shrinking = join(work, "shrinking.sqlite");
  const shrinkReplies = await run(
    shrinking,
    "CREATE TABLE t(v BLOB);\nBEGIN; INSERT INTO t VALUES(zeroblob(500000)); COMMIT;\nBEGIN; INSERT INTO t VALUES('rolled-back'); ROLLBACK;\nDELETE FROM t;\nPRAGMA incremental_vacuum(10000);\n",
    { SB_LTX_TEST_AUTO_VACUUM: "1" },
  );
  assert(
    shrinkReplies.every((n) => n.startsWith("0 ")),
    shrinkReplies.join("\n"),
  );
  const shrinkEpoch = (await readFile(shrinking + ".ltx/position", "utf8")).split("\n")[1];
  const shrinkRestore = join(work, "shrinking-restored.sqlite");
  await restore(shrinking + ".ltx/" + shrinkEpoch, shrinkRestore);
  assert.deepEqual(await readFile(shrinking), await readFile(shrinkRestore));
  assert((await stat(shrinking)).size < 32768, "incremental vacuum should shrink the file");
  const failure = join(work, "failure.sqlite");
  const failed = await run(
    failure,
    "CREATE TABLE events(id INTEGER PRIMARY KEY,value TEXT);\n:break-position\nINSERT INTO events VALUES(1,'committed-before-error');\nINSERT INTO events VALUES(2,'must-be-rejected');\n",
  );
  assert(failed[2].startsWith("10 ") && failed[3].startsWith("10 "), failed.join("\n"));
  await rm(failure + ".ltx/position.tmp", { recursive: true });
  await run(failure, "SELECT 1;\n");
  const failureEpoch = (await readFile(failure + ".ltx/position", "utf8")).split("\n")[1];
  const failureRestore = join(work, "failure-restored.sqlite");
  await restore(failure + ".ltx/" + failureEpoch, failureRestore);
  const failedDb = new Database(failureRestore);
  assert.equal(failedDb.query("SELECT count(*) n FROM events").get()?.n, 1);
  failedDb.close();
  const phases = [
    "wal-committed",
    "ltx-written",
    "ltx-fsynced",
    "ltx-published",
    "position-fsynced",
    "position-published",
    "before-checkpoint",
    "after-checkpoint",
    "checkpoint-record-fsynced",
    "checkpoint-record-published",
  ];
  for (const phase of phases) {
    const crashPath = join(work, "crash-" + phase + ".sqlite");
    await run(crashPath, "CREATE TABLE events(id INTEGER PRIMARY KEY,value TEXT);\n");
    const epoch = await stoppedCommit(crashPath, phase);
    const before = (await readdir(crashPath + ".ltx/" + epoch)).filter((n) => n.endsWith(".ltx")).length;
    const oldRestore = join(work, "old-" + phase + ".sqlite");
    await restore(crashPath + ".ltx/" + epoch, oldRestore);
    const beforeDb = new Database(oldRestore);
    assert.equal(beforeDb.query("PRAGMA integrity_check").get()?.integrity_check, "ok");
    const durableRows = beforeDb.query("SELECT count(*) n FROM events").get()?.n;
    beforeDb.close();
    assert.equal(durableRows, before > 2 ? 1 : 0);
    await run(crashPath, "SELECT 1;\n");
    const position = (await readFile(crashPath + ".ltx/position", "utf8")).split("\n");
    if (phase === "position-published" || phase === "before-checkpoint" || phase === "checkpoint-record-published")
      assert.equal(position[1], epoch, "matching WAL must resume");
    else assert.notEqual(position[1], epoch, "mismatched position must make a fresh base");
    const recovered = join(work, "recovered-" + phase + ".sqlite");
    await restore(crashPath + ".ltx/" + position[1], recovered);
    const rdb = new Database(recovered);
    assert.equal(rdb.query("SELECT count(*) n FROM events").get()?.n, 1);
    assert.equal(rdb.query("PRAGMA integrity_check").get()?.integrity_check, "ok");
    rdb.close();
  }
  const pending = join(work, "pending.sqlite");
  await run(pending, "CREATE TABLE events(id INTEGER PRIMARY KEY,value TEXT);\n");
  const pendingEpoch = await stoppedCommit(pending, "wal-committed", 2);
  await run(pending, "SELECT 1;\n");
  assert.equal((await readFile(pending + ".ltx/position", "utf8")).split("\n")[1], pendingEpoch);
  const pendingRestore = join(work, "pending-restored.sqlite");
  const pendingResult = await restore(pending + ".ltx/" + pendingEpoch, pendingRestore);
  assert.equal(pendingResult.files, 4); // Base, schema commit and both recovered inserts.
  const pdb = new Database(pendingRestore);
  assert.equal(pdb.query("SELECT count(*) n FROM events").get()?.n, 2);
  assert.equal(pdb.query("PRAGMA integrity_check").get()?.integrity_check, "ok");
  pdb.close();
  console.log(
    "PASS restart: 10 SIGKILL durability boundaries, matching-prefix resume, orphan/missing/reset fallback, pending committed WAL tail captured before serving",
  );
  console.log(
    "PASS native LTX: 102-file chain, independent CRC/index checks, byte-exact restore, integrity, hard WAL ceiling and oversized transaction rollback",
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
