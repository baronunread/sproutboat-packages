import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { restore } from "./ltx-restore.ts";
import { buildDriver, spawnDriver, type Driver } from "./s1b-driver.ts";

// Design 029 stage S1b on the exact inline C of the embedded transport: the capture's write path after the fsync
// redesign (one WAL sync per commit; LTX files, directory entries and the position record synced only before a clean
// record; checkpoint by size or time, not after every statement) and group commit (a commit's WAL sync owed until one
// flush, captures merged). The power-loss and SIGKILL campaigns are native-storage-s1b-crash.ts.
const work = await mkdtemp(join(tmpdir(), "sb-native-s1b-"));
const binary = await buildDriver(work);
const spawn = (dir: string, env: Record<string, string> = {}) => spawnDriver(binary, dir, env);
const fresh = () => mkdtemp(join(work, "run-"));
const d1 = (dir: string) => join(dir, "data/d1/DB.sqlite");
const spool = (dir: string) => join(dir, "spool/d1/DB");

async function position(dir: string) {
  const text = await readFile(join(spool(dir), "position"), "utf8");
  const lines = text.split("\n");
  assert.equal(lines[0], "LTXPOS4");
  const f = lines[2].split(" ");
  return { epoch: lines[1], mode: f[1], txid: BigInt(f[2]), synced: BigInt(f[14]), lines, f };
}
async function ltxFiles(dir: string, epoch: string) {
  return (await readdir(join(spool(dir), epoch))).filter((n) => n.endsWith(".ltx")).sort();
}
async function assertEquals(dir: string, label: string) {
  const pos = await position(dir);
  const out = join(work, "restored-" + Math.random().toString(36).slice(2));
  await restore(join(spool(dir), pos.epoch), out);
  const a = new Uint8Array(await readFile(out)),
    b = new Uint8Array(await readFile(d1(dir)));
  assert.equal(a.length, b.length, label + ": size");
  assert(Buffer.compare(a, b) === 0, label + ": restored bytes differ from the database");
  await rm(out);
}
const count = (dir: string, table = "t") => {
  const db = new Database(d1(dir), { readonly: true });
  const n = Number(db.query(`SELECT count(*) FROM ${table}`).values()[0][0]);
  assert.equal(db.query("PRAGMA integrity_check").values()[0][0], "ok");
  db.close();
  return n;
};
const stats = async (d: Driver) => JSON.parse(await d.send("stats"));
const state = async (d: Driver) => JSON.parse(await d.send("state d1 DB"));
async function fill(d: Driver, n: number, tag = "r") {
  for (let i = 0; i < n; i++) assert.match(await d.send(`sql d1 DB INSERT INTO t(v) VALUES('${tag}${i}')`), /^0 /);
}
const big = { SB_LTX_CKPT_BYTES: "8388608", SB_LTX_CKPT_MS: "3600000" };

try {
  // 1. The new write path between checkpoints: the WAL is not reset after every statement, no capture file is synced, so a
  // commit costs the WAL's own sync and nothing else. (The LTX files are synced once, when a checkpoint comes: test 2.)
  {
    const dir = await fresh();
    const d = await spawn(dir, big);
    assert.match(await d.send("sql d1 DB CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)"), /^0 /);
    const before = await stats(d);
    await fill(d, 200);
    const after = await stats(d);
    const syncs = after.vfsSyncs - before.vfsSyncs + (after.fsyncs - before.fsyncs);
    assert(syncs <= 200 * 1.05, `fsyncs for 200 commits: ${syncs}`);
    assert.equal(after.fsyncs - before.fsyncs, 0, "no capture file, directory or position record was synced");
    const st = await state(d);
    assert.equal(st.mode, "W");
    assert.equal(st.synced, 1, "only the base image is synced");
    assert(st.txid >= 201, "one LTX file per commit, got txid " + st.txid);
    assert(st.frames >= 200, "the WAL holds the commits: " + st.frames);
    const walSize = (await stat(d1(dir) + "-wal")).size;
    assert(walSize > 200 * 4096, "the WAL was not reset: " + walSize);
    await d.send("close d1 DB");
    const pos = await position(dir);
    assert.equal(pos.mode, "C", "a close leaves a clean record");
    assert.equal(pos.synced, pos.txid, "a clean record claims only synced files");
    await d.quit();
    await assertEquals(dir, "after a clean close");
    assert.equal(count(dir), 200);
    console.log(
      `PASS steady state: ${syncs} syncs for 200 commits (1.0 per commit while no checkpoint is due), no capture sync, WAL ${walSize} bytes kept`,
    );
  }

  // 2. Checkpoints by size: many of them, each leaving the chain complete; the sync count stays near one per commit.
  {
    const dir = await fresh();
    const d = await spawn(dir, { SB_LTX_CKPT_BYTES: "65536", SB_LTX_CKPT_MS: "3600000" });
    await d.send("sql d1 DB CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    const before = await stats(d);
    await fill(d, 400, "x");
    const after = await stats(d);
    const total = after.vfsSyncs - before.vfsSyncs + (after.fsyncs - before.fsyncs);
    assert(total < 400 * 3, `syncs per commit with a 64 KiB WAL: ${total / 400}`);
    const walSize = (await stat(d1(dir) + "-wal")).size;
    assert(walSize < 65536 + 8192, "the WAL is bounded by the threshold: " + walSize);
    await d.send("close d1 DB");
    await d.quit();
    await assertEquals(dir, "after 400 commits and many checkpoints");
    assert.equal(count(dir), 400);
    console.log(
      `PASS checkpoint by size: ${(total / 400).toFixed(2)} syncs per commit at a 64 KiB WAL, WAL bounded, chain complete`,
    );
  }

  // 3. Checkpoint by time: a statement after the interval moves the WAL.
  {
    const dir = await fresh();
    const d = await spawn(dir, { SB_LTX_CKPT_BYTES: "8388608", SB_LTX_CKPT_MS: "300" });
    await d.send("sql d1 DB CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    await fill(d, 20);
    assert.equal((await state(d)).mode, "W");
    await Bun.sleep(350);
    await fill(d, 1);
    const st = await state(d);
    assert.equal(st.mode, "C", "the statement after the interval checkpointed");
    assert.equal(st.frames, 0);
    await d.send("close d1 DB");
    await d.quit();
    await assertEquals(dir, "after a time checkpoint");
    console.log("PASS checkpoint by time: a statement after SB_LTX_CKPT_MS moves the WAL and writes the clean record");
  }

  // 4. SB_LTX_CKPT_BYTES=0 is the policy of stage S1: a checkpoint after every statement.
  {
    const dir = await fresh();
    const d = await spawn(dir, { SB_LTX_CKPT_BYTES: "0" });
    await d.send("sql d1 DB CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    await fill(d, 10);
    const st = await state(d);
    assert.equal(st.mode, "C");
    assert.equal(st.synced, st.txid);
    assert.equal((await stat(d1(dir) + "-wal")).size, 0);
    await d.send("close d1 DB");
    await d.quit();
    await assertEquals(dir, "S1 policy");
    console.log("PASS SB_LTX_CKPT_BYTES=0 restores the checkpoint after every statement");
  }

  // 5. A kill with files above synced_txid: the resume verifies them all and the chain, then continues in the same epoch.
  {
    const dir = await fresh();
    const d = await spawn(dir, big);
    await d.send("sql d1 DB CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    await fill(d, 60);
    const epoch = (await state(d)).epoch;
    await d.kill();
    const pos = await position(dir);
    assert.equal(pos.mode, "W");
    assert(pos.synced < pos.txid);
    const e = await spawn(dir, big);
    assert.match(await e.send("sql d1 DB INSERT INTO t(v) VALUES('after')"), /^0 /);
    const s = await stats(e);
    assert.equal(s.resume, 1, "resumed, not re-based");
    assert.equal(s.fresh, 0);
    assert.equal((await state(e)).epoch, epoch, "same epoch");
    await e.send("close d1 DB");
    await e.quit();
    await assertEquals(dir, "after a resumed kill");
    assert.equal(count(dir), 61);
    console.log(
      "PASS resume after a kill with unsynced files: same epoch, every file verified, chain restores byte for byte",
    );
  }

  // 6. What a power cut can do to the unsynced files (a hole, a zero-length or torn file, one that is gone): any of them
  // costs a new epoch and never data. The database is intact through its WAL; the chain is rebuilt from a base image.
  for (const damage of ["hole", "torn-middle", "zero-length", "torn-last", "removed-last"] as const) {
    const dir = await fresh();
    const d = await spawn(dir, big);
    await d.send("sql d1 DB CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    await fill(d, 30);
    const epoch = (await state(d)).epoch;
    await d.kill();
    const pos = await position(dir);
    const files = await ltxFiles(dir, epoch);
    const unsynced = files.slice(Number(pos.synced));
    assert(unsynced.length >= 5, "files above synced_txid: " + unsynced.length);
    const middle = join(spool(dir), epoch, unsynced[Math.floor(unsynced.length / 2)]);
    const last = join(spool(dir), epoch, unsynced[unsynced.length - 1]);
    if (damage === "hole") await unlink(middle);
    if (damage === "torn-middle") await truncate(middle, (await stat(middle)).size - 100);
    if (damage === "zero-length") await truncate(middle, 0);
    if (damage === "torn-last") await truncate(last, (await stat(last)).size - 1);
    if (damage === "removed-last") await unlink(last);
    const e = await spawn(dir, big);
    assert.match(await e.send("sql d1 DB INSERT INTO t(v) VALUES('after')"), /^0 /);
    const s = await stats(e);
    assert.equal(s.fresh, 1, damage + ": a new base");
    assert.equal(s.resume, 0);
    assert.notEqual((await state(e)).epoch, epoch, damage + ": a new epoch");
    await e.send("close d1 DB");
    await e.quit();
    assert.equal(count(dir), 31, damage + ": no row lost");
    await assertEquals(dir, "after " + damage);
  }
  console.log(
    "PASS damaged unsynced files (hole, torn, zero-length, removed): new epoch, no row lost, restore byte for byte",
  );

  // 7. A stale or missing W record (never fsynced): the same, a new epoch.
  {
    const dir = await fresh();
    const d = await spawn(dir, big);
    await d.send("sql d1 DB CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    await fill(d, 10);
    await d.kill();
    const text = await readFile(join(spool(dir), "position"), "utf8");
    await writeFile(join(spool(dir), "position"), text.slice(0, text.length - 5)); // torn
    const e = await spawn(dir, big);
    await e.send("sql d1 DB INSERT INTO t(v) VALUES('after')");
    assert.equal((await stats(e)).fresh, 1);
    await e.send("close d1 DB");
    await e.quit();
    await assertEquals(dir, "after a torn record");
    assert.equal(count(dir), 11);
    // a record of the older format
    const dir2 = await fresh();
    const f = await spawn(dir2, big);
    await f.send("sql d1 DB CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    await fill(f, 5);
    await f.kill();
    const pos = await position(dir2);
    const old = `LTXPOS3\n${pos.epoch}\n${pos.f.slice(0, 14).join(" ")}\n`;
    await writeFile(join(spool(dir2), "position"), old + "0000000000000000\n");
    const g = await spawn(dir2, big);
    await g.send("sql d1 DB INSERT INTO t(v) VALUES('after')");
    assert.equal((await stats(g)).fresh, 1, "LTXPOS3 is not resumed");
    await g.send("close d1 DB");
    await g.quit();
    await assertEquals(dir2, "after an LTXPOS3 record");
    console.log("PASS a torn W record and an LTXPOS3 record are not trusted: new epoch, no row lost");
  }

  // 8. Group commit: the commits are in the WAL with their syncs owed, capture is held, one flush syncs once and captures
  // them as one LTX file.
  {
    const dir = await fresh();
    const d = await spawn(dir, big);
    await d.send("sql d1 DB CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    const t0 = (await state(d)).txid;
    const s0 = await stats(d);
    for (let i = 0; i < 20; i++) assert.equal(await d.send(`sqld d1 DB INSERT INTO t(v) VALUES('g${i}')`), "D 0");
    assert.equal(await d.send("owed"), "1");
    const s1 = await stats(d);
    assert.equal(s1.vfsSyncs, s0.vfsSyncs, "no WAL sync ran for the 20 held commits");
    assert(s1.deferredSyncs >= 20, "20 syncs were owed: " + s1.deferredSyncs);
    assert.equal((await state(d)).txid, t0, "capture is held until the flush");
    assert.equal(await d.send("flush"), "0 flushed");
    const s2 = await stats(d);
    assert.equal(s2.vfsSyncs - s0.vfsSyncs, 1, "one WAL sync for the group");
    assert.equal(s2.fsyncs, s0.fsyncs, "and no other");
    assert.equal((await state(d)).txid, t0 + 1, "one LTX file for the group");
    assert.equal(await d.send("owed"), "0");
    // a second group, and a read inside it
    for (let i = 0; i < 5; i++) await d.send(`sqld d1 DB INSERT INTO t(v) VALUES('h${i}')`);
    assert.equal(await d.send("sqld d1 DB SELECT count(*) FROM t"), "D 0");
    assert.equal(await d.send("owed"), "1", "a read while something is owed still sees it owed");
    await d.send("flush");
    // an inline statement flushes what is owed (it has no barrier of its own)
    for (let i = 0; i < 3; i++) await d.send(`sqld d1 DB INSERT INTO t(v) VALUES('i${i}')`);
    assert.match(await d.send("sql d1 DB INSERT INTO t(v) VALUES('inline')"), /^0 /);
    assert.equal(await d.send("owed"), "0", "an inline statement leaves nothing owed");
    await d.send("close d1 DB");
    await d.quit();
    assert.equal(count(dir), 20 + 5 + 3 + 1);
    await assertEquals(dir, "after group commits");
    console.log(
      "PASS group commit: 20 held commits, one WAL sync, one LTX file; reads see it owed; an inline statement flushes",
    );
  }

  // 9. A kill with commits held (never flushed, so never acknowledged): the database and the chain are consistent, whatever
  // survived. SIGKILL keeps the page cache, so the committed frames are still in the WAL and are captured at resume.
  {
    const dir = await fresh();
    const d = await spawn(dir, big);
    await d.send("sql d1 DB CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    await fill(d, 10);
    for (let i = 0; i < 7; i++) await d.send(`sqld d1 DB INSERT INTO t(v) VALUES('h${i}')`);
    await d.kill();
    const e = await spawn(dir, big);
    await e.send("sql d1 DB INSERT INTO t(v) VALUES('after')");
    const s = await stats(e);
    assert.equal(s.resume, 1, "resumed from the WAL");
    await e.send("close d1 DB");
    await e.quit();
    assert.equal(count(dir), 10 + 7 + 1, "held commits that reached the WAL survive a plain kill");
    await assertEquals(dir, "after a kill with held commits");
    console.log("PASS kill with held commits: resumed, the uncaptured tail is captured, restore byte for byte");
  }

  // 10. Group commit across a due checkpoint and across two files.
  {
    const dir = await fresh();
    const d = await spawn(dir, { SB_LTX_CKPT_BYTES: "65536", SB_LTX_CKPT_MS: "3600000" });
    await d.send("sql d1 DB CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    await d.send("sql store x CREATE TABLE kv(k INTEGER PRIMARY KEY, v TEXT)");
    for (let round = 0; round < 40; round++) {
      for (let i = 0; i < 6; i++) {
        await d.send(`sqld d1 DB INSERT INTO t(v) VALUES(hex(randomblob(900)))`);
        await d.send(`sqld store x INSERT INTO kv(v) VALUES('${round}-${i}')`);
      }
      assert.equal(await d.send("flush"), "0 flushed");
      assert.equal(await d.send("owed"), "0");
    }
    await d.send("close d1 DB");
    await d.send("close store x");
    await d.quit();
    assert.equal(count(dir), 240);
    await assertEquals(dir, "d1 after grouped commits and checkpoints");
    const db = new Database(join(dir, "data/store.sqlite"), { readonly: true });
    assert.equal(Number(db.query("SELECT count(*) FROM kv").values()[0][0]), 240);
    db.close();
    console.log("PASS group commit over two files and many due checkpoints: no row lost, chains restore byte for byte");
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
