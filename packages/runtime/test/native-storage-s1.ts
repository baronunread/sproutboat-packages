import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { restore } from "./ltx-restore.ts";

// Design 029 stage S1, on the exact inline C of the embedded transport: the one-owner lock, capture of every kind of
// file (D1, store.sqlite, Durable Object SQL) into a spool root shared with a shipper group, LTXPOS3 and epochSeq,
// the dirty list, and a captured handle leaving the table and coming back. Both native regions are compiled
// together, as native-db-table.ts does, and a driver takes one command per line (the table is process-global).
// SB_TEST_SQLITE_DIR=DIR (sqlite3.h and a built sqlite3.o) runs it against the host's amalgamation instead.
const transport = await readFile(new URL("../src/transport-embedded.js", import.meta.url), "utf8");
const ltxStart = transport.indexOf("// BEGIN LTX NATIVE"),
  ltxEnd = transport.indexOf("// END LTX NATIVE", ltxStart);
const tableStart = transport.indexOf("// BEGIN DB TABLE NATIVE"),
  tableEnd = transport.indexOf("// END DB TABLE NATIVE", tableStart);
assert(ltxStart > 0 && ltxEnd > ltxStart && tableStart > ltxEnd && tableEnd > tableStart);
const work = await mkdtemp(join(tmpdir(), "sb-native-s1-"));
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
#define SB_MAX_DB 64
static sqlite3* sb_dbs[SB_MAX_DB];
static char sb_db_names[SB_MAX_DB][256];
static int sb_db_count = 0;
${transport.slice(ltxStart, ltxEnd)}
${transport.slice(tableStart, tableEnd)}
static char root[512];
// kind: d1 NAME, store, do CLASS/HEX, vol
static int path_of(char* out, const char* kind, const char* name) {
  if (!strcmp(kind, "d1")) return snprintf(out, 700, "%s/data/d1/%s.sqlite", root, name);
  if (!strcmp(kind, "store")) return snprintf(out, 700, "%s/data/store.sqlite", root);
  if (!strcmp(kind, "do")) return snprintf(out, 700, "%s/data/do-sql/%s.sqlite", root, name);
  return snprintf(out, 700, "%s/data/volatile.sqlite", root);
}
int main(int argc, char** argv) {
  snprintf(root, sizeof root, "%s", argv[1]);
  sb_ltx_compat = 1;
  if (argc > 2) umask(077);
  char *line = 0; size_t cap = 0;
  setvbuf(stdout, 0, _IOLBF, 0);
  puts("ready");
  while (getline(&line, &cap, stdin) > 0) {
    line[strcspn(line, "\\n")] = 0;
    char cmd[16] = "", kind[8] = "", name[200] = "", p[800];
    int n = 0;
    sscanf(line, "%15s %7s %199s%n", cmd, kind, name, &n);
    const char* rest = line + n; if (*rest == ' ') rest++;
    if (!strcmp(cmd, "quit")) break;
    if (!strcmp(cmd, "stats")) {
      printf("{\\"fresh\\":%lu,\\"cheap\\":%lu,\\"full\\":%lu,\\"resume\\":%lu,\\"open\\":%d}\\n", sb_ltx_stat_fresh, sb_ltx_stat_cheap, sb_ltx_stat_full, sb_ltx_stat_resume, sb_open_dbs());
      continue;
    }
    path_of(p, kind, name);
    if (!strcmp(cmd, "opted")) { printf("%d\\n", sb_ltx_opted(p)); continue; }
    if (!strcmp(cmd, "key")) { char k[200]; int rc = sb_ltx_key(p, k, sizeof k); printf("%d %s\\n", rc, rc ? "" : k); continue; }
    if (!strcmp(cmd, "open")) {
      struct timespec a, b; clock_gettime(CLOCK_MONOTONIC, &a);
      int idx = sb_db_for(p);
      clock_gettime(CLOCK_MONOTONIC, &b);
      printf("%d %ld\\n", idx, (long)((b.tv_sec - a.tv_sec) * 1000 + (b.tv_nsec - a.tv_nsec) / 1000000));
      continue;
    }
    if (!strcmp(cmd, "close")) { printf("%d\\n", sb_db_close_path(p)); continue; }
    if (!strcmp(cmd, "sql")) {
      int idx = sb_db_for(p);
      if (idx < 0) { printf("-1 cannot open\\n"); continue; }
      char* err = 0;
      int rc = sb_ltx_states[idx].failed ? 10 : sqlite3_exec(sb_dbs[idx], rest, 0, 0, &err);
      if (sb_ltx_after(idx)) rc = 10;
      printf("%d %s\\n", rc, err ? err : "ok");
      sqlite3_free(err);
      continue;
    }
    printf("?\\n");
  }
  return 0;
}
`;
await writeFile(join(work, "driver.c"), source);
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

type Driver = {
  send(line: string): Promise<string>;
  quit(): Promise<void>;
  kill(): Promise<void>;
  pid: number;
};
const baseEnv = {
  SB_LTX_ENABLE: "1",
  SB_LTX_SCOPE: "d1,store,do-sql",
  SB_OWNER_LOCK: "1",
};
async function spawn(dir: string, env: Record<string, string> = {}, umask077 = false): Promise<Driver> {
  const child = Bun.spawn([binary, dir, ...(umask077 ? ["u"] : [])], {
    env: {
      PATH: process.env.PATH ?? "",
      SB_LTX_ROOT: join(dir, "spool"),
      SB_DATA_DIR: join(dir, "data"),
      ...baseEnv,
      ...env,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  let buffer = "";
  async function line(): Promise<string> {
    while (!buffer.includes("\n")) {
      const r = await reader.read();
      if (r.done) throw new Error("driver exited: " + (await new Response(child.stderr).text()));
      buffer += new TextDecoder().decode(r.value);
    }
    const i = buffer.indexOf("\n");
    const out = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    return out;
  }
  assert.equal(await line(), "ready");
  return {
    pid: child.pid,
    async send(text: string) {
      child.stdin.write(text + "\n");
      child.stdin.flush();
      return line();
    },
    async quit() {
      child.stdin.write("quit\n");
      child.stdin.end();
      await child.exited;
    },
    async kill() {
      child.kill("SIGKILL");
      await child.exited;
    },
  };
}
const HEX = "0123456789abcdef".repeat(4);
function rows(db: Database, table: string): number {
  return Number(db.query(`SELECT count(*) FROM ${table}`).values()[0][0]);
}
const hexN = (n: number) => n.toString(16).padStart(64, "0");
async function fresh(): Promise<string> {
  return mkdtemp(join(work, "run-"));
}
function paths(dir: string) {
  return {
    d1: join(dir, "data/d1/DB.sqlite"),
    store: join(dir, "data/store.sqlite"),
    do: join(dir, `data/do-sql/Room/${HEX}.sqlite`),
    spool: {
      d1: join(dir, "spool/d1/DB"),
      store: join(dir, "spool/store"),
      do: join(dir, `spool/do-sql/Room/${HEX}`),
    },
  };
}
async function epochOf(spool: string) {
  const text = await readFile(join(spool, "position"), "utf8");
  const lines = text.split("\n");
  assert.equal(lines[0], "LTXPOS3");
  const f = lines[2].split(" ");
  return {
    epoch: lines[1],
    seq: BigInt(f[0]),
    mode: f[1],
    txid: BigInt(f[2]),
    ino: BigInt(f[11]),
    mtime: BigInt(f[12]),
    size: BigInt(f[13]),
  };
}
// The spool's chain restored byte for byte against the database file (after a clean close, no -wal remains).
async function assertEquals(spool: string, db: string, label: string) {
  const pos = await epochOf(spool);
  const out = join(work, "restored-" + Math.random().toString(36).slice(2));
  await restore(join(spool, pos.epoch), out);
  const a = new Uint8Array(await readFile(out)),
    b = new Uint8Array(await readFile(db));
  assert.equal(a.length, b.length, label + ": size");
  assert(Buffer.compare(a, b) === 0, label + ": restored bytes differ from the database");
  await rm(out);
  const check = new Database(out + ".chk", { create: true });
  check.close();
  await rm(out + ".chk");
}

try {
  // 1. Scope and keys, with no database opened.
  {
    const dir = await fresh();
    const d = await spawn(dir, { SB_LTX_SCOPE: "d1" });
    assert.equal(await d.send("opted d1 DB"), "1");
    assert.equal(await d.send("opted store x"), "0");
    assert.equal(await d.send(`opted do Room/${HEX}`), "0");
    assert.equal(await d.send("opted vol x"), "0");
    await d.quit();
    const e = await spawn(dir, { SB_LTX_SCOPE: "store,do-sql" });
    assert.equal(await e.send("opted d1 DB"), "0");
    assert.equal(await e.send("opted store x"), "1");
    assert.equal(await e.send(`opted do Room/${HEX}`), "1");
    assert.equal(await e.send("opted vol x"), "0", "volatile.sqlite is never captured");
    assert.equal(await e.send("key store x"), "0 store");
    assert.equal(await e.send("key d1 DB"), "0 d1/DB");
    assert.equal(await e.send(`key do My$Cls/${HEX}`), `0 do-sql/My%24Cls/${HEX}`, "a dollar sign is percent-encoded");
    await e.quit();
    const bad = await spawn(dir, { SB_LTX_SCOPE: "d1,wat" });
    assert.equal(await bad.send("opted d1 DB"), "-1", "a bad scope must refuse to open, not capture nothing");
    await bad.quit();
    const legacy = await spawn(dir, { SB_LTX_SCOPE: "", SB_LTX_DATABASE: "DB", SB_LTX_ROOT: "", SB_OWNER_LOCK: "0" });
    assert.equal(await legacy.send("opted d1 DB"), "1");
    assert.equal(await legacy.send("opted d1 OTHER"), "0");
    assert.equal(await legacy.send("opted store x"), "0");
    assert.equal(await legacy.send(`opted do Room/${HEX}`), "0", "legacy mode never captured Durable Object SQL");
    await legacy.quit();
    console.log("PASS scope: d1, store and do-sql independently; volatile never; bad list refuses; keys encode");
  }

  // 2. Capture of all three kinds into the shared spool root, group-readable whatever the worker's umask.
  {
    const dir = await fresh();
    const p = paths(dir);
    await mkdir(join(dir, "spool"), { recursive: true });
    const d = await spawn(dir, {}, true);
    assert.match(await d.send("sql d1 DB CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)"), /^0 /);
    assert.match(await d.send("sql store x CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT)"), /^0 /);
    assert.match(await d.send(`sql do Room/${HEX} CREATE TABLE o(id INTEGER PRIMARY KEY, v TEXT)`), /^0 /);
    assert.match(await d.send("sql vol x CREATE TABLE rl(k TEXT PRIMARY KEY, c INTEGER)"), /^0 /);
    for (let i = 0; i < 25; i++) {
      assert.match(await d.send(`sql d1 DB INSERT INTO t(v) VALUES('d1-${i}')`), /^0 /);
      assert.match(await d.send(`sql store x INSERT INTO kv VALUES('k${i}','v${i}')`), /^0 /);
      assert.match(await d.send(`sql do Room/${HEX} INSERT INTO o(v) VALUES('do-${i}')`), /^0 /);
      assert.match(await d.send(`sql vol x INSERT OR REPLACE INTO rl VALUES('ip',${i})`), /^0 /);
    }
    for (const [kind, name] of [
      ["d1", "DB"],
      ["store", "x"],
      ["do", `Room/${HEX}`],
      ["vol", "x"],
    ])
      await d.send(`close ${kind} ${name}`);
    await d.quit();
    for (const kind of ["d1", "store", "do"] as const) {
      const pos = await epochOf(p.spool[kind]);
      assert.equal(pos.mode, "C", kind + " clean after close");
      assert(pos.txid > 25n, kind + " txid " + pos.txid);
      assert(pos.ino > 0n && pos.mtime > 0n && pos.size > 0n, kind + " clean record pins the file");
      assert(pos.seq > 1n << 30n, kind + " epochSeq is a clock-sized number");
      await assertEquals(p.spool[kind], p[kind], kind);
      const dirMode = (await stat(p.spool[kind])).mode & 0o777;
      assert.equal(dirMode & 0o070, 0o070, kind + " spool directory group rwx, got " + dirMode.toString(8));
      const posMode = (await stat(join(p.spool[kind], "position"))).mode & 0o777;
      assert.equal(posMode & 0o060, 0o060, kind + " position group rw under umask 077, got " + posMode.toString(8));
      const files = (await readdir(join(p.spool[kind], pos.epoch))).filter((n) => n.endsWith(".ltx"));
      const ltxMode = (await stat(join(p.spool[kind], pos.epoch, files[0]))).mode & 0o777;
      assert.equal(ltxMode & 0o060, 0o060, kind + " LTX file group rw, got " + ltxMode.toString(8));
    }
    assert(!(await readdir(join(dir, "spool"))).some((n) => n.includes("volatile")), "volatile.sqlite got no spool");
    assert(
      !(await Bun.file(join(dir, "data/volatile.sqlite.ltx/position")).exists()),
      "no spool beside the database either",
    );
    console.log(
      "PASS capture completeness: d1, store.sqlite and Durable Object SQL restore byte for byte; volatile.sqlite untouched; group-readable",
    );
  }

  // 3. One owner: a second worker waits, fails without changing state, then succeeds once the first dies.
  {
    const dir = await fresh();
    const a = await spawn(dir, {});
    assert.match(await a.send("sql d1 DB CREATE TABLE t(v)"), /^0 /);
    assert.equal(await a.send("sql d1 DB INSERT INTO t VALUES(1)").then((x) => x.slice(0, 1)), "0");
    const lock = Bun.file(join(dir, "data/.owner.lock"));
    assert(await lock.exists(), "the app-wide lock file exists");
    const b = await spawn(dir, { SB_OWNER_WAIT_MS: "300" });
    const t0 = Date.now();
    const [idx, ms] = (await b.send("open d1 DB")).split(" ");
    assert.equal(idx, "-1", "a second worker must not open a captured file");
    assert(Date.now() - t0 >= 280 && Date.now() - t0 < 3000, "it waited the configured time, got " + (Date.now() - t0));
    assert(Number(ms) >= 280);
    // not latched: the same process succeeds as soon as the owner is gone (SIGKILL: the kernel drops the lock)
    const p = paths(dir);
    assert.equal(await Bun.file(p.d1 + ".ltx/position").exists(), false);
    await a.kill();
    const [ok] = (await b.send("open d1 DB")).split(" ");
    assert.notEqual(ok, "-1", "the second worker takes over after the owner is killed, without a restart");
    assert.match(await b.send("sql d1 DB INSERT INTO t VALUES(2)"), /^0 /);
    await b.send("close d1 DB");
    await b.quit();
    await assertEquals(p.spool.d1, p.d1, "after takeover");
    const db = new Database(p.d1, { readonly: true });
    assert.equal(rows(db, "t"), 2);
    db.close();
    // the same lock covers every kind of file of the app, and deny never owns
    const c = await spawn(await fresh(), { SB_OWNER_LOCK: "deny" });
    assert.equal((await c.send("open d1 DB")).split(" ")[0], "-1", "deny fails at once");
    assert.equal((await c.send("open store x")).split(" ")[0], "-1");
    assert.equal((await c.send("open vol x")).split(" ")[0] === "-1", false, "an uncaptured file needs no owner");
    await c.quit();
    // two kinds, one lock: the first owner blocks a store open in another worker too
    const dir2 = await fresh();
    const e = await spawn(dir2, {});
    assert.notEqual((await e.send("open d1 DB")).split(" ")[0], "-1");
    const f = await spawn(dir2, { SB_OWNER_WAIT_MS: "100" });
    assert.equal((await f.send("open store x")).split(" ")[0], "-1", "store.sqlite is owned through the same app lock");
    assert.equal((await f.send(`open do Room/${HEX}`)).split(" ")[0], "-1", "so is Durable Object SQL");
    await f.quit();
    await e.quit();
    console.log("PASS owner lock: wait, non-latching failure, takeover after SIGKILL, deny, one lock for all kinds");
  }

  // 4. Durable Object SQL through the slots: handles leave (settling the spool) and come back (cheap reopen).
  {
    const dir = await fresh();
    // SB_MEMORY_LIMIT 8 MiB gives the smallest slot table: 8 open Durable Object databases.
    const d = await spawn(dir, { SB_MEMORY_LIMIT: String(8 << 20) });
    const count = 14; // more than the 8 slots
    for (let i = 0; i < count; i++) {
      assert.match(await d.send(`sql do Room/${hexN(i)} CREATE TABLE o(v)`), /^0 /);
      assert.match(await d.send(`sql do Room/${hexN(i)} INSERT INTO o VALUES(${i})`), /^0 /);
    }
    const open1 = JSON.parse(await d.send("stats"));
    assert(open1.open <= 8 + 0, "no more than the slot count stays open, got " + open1.open);
    const before = JSON.parse(await d.send("stats"));
    for (let r = 0; r < 2; r++)
      for (let i = count - 1; i >= 0; i--)
        assert.match(await d.send(`sql do Room/${hexN(i)} INSERT INTO o VALUES(${i + 100})`), /^0 /);
    const after = JSON.parse(await d.send("stats"));
    assert(after.cheap > before.cheap, "reopened files took the cheap path");
    assert.equal(after.full, before.full, "no reopen read every page");
    assert.equal(after.fresh, count, "one base per file, none per reopen");
    for (let i = 0; i < count; i++) await d.send(`close do Room/${hexN(i)}`);
    await d.quit();
    for (let i = 0; i < count; i++) {
      const spool = join(dir, `spool/do-sql/Room/${hexN(i)}`);
      await assertEquals(spool, join(dir, `data/do-sql/Room/${hexN(i)}.sqlite`), "object " + i);
      const db = new Database(join(dir, `data/do-sql/Room/${hexN(i)}.sqlite`), { readonly: true });
      assert.equal(rows(db, "o"), 1 + 2);
      db.close();
    }
    // the same files reopened in a new process: still the cheap path, epochs unchanged
    const spool = join(dir, `spool/do-sql/Room/${hexN(3)}`);
    const epochBefore = await epochOf(spool);
    const n = await spawn(dir, {});
    assert.match(await n.send(`sql do Room/${hexN(3)} INSERT INTO o VALUES(7)`), /^0 /);
    const s = JSON.parse(await n.send("stats"));
    assert.equal(s.cheap, 1, "a clean file reopens without reading its pages");
    assert.equal(s.fresh, 0);
    assert.equal((await epochOf(spool)).epoch, epochBefore.epoch, "same epoch after a clean reopen");
    await n.send(`close do Room/${hexN(3)}`);
    await n.quit();
    console.log(
      `PASS Durable Object SQL: ${count} objects through 8 slots capture completely, reopen cheaply, restore byte for byte`,
    );
  }

  // 5. A clean record trusts only the file it was written for.
  {
    const dir = await fresh();
    const p = paths(dir);
    const a = await spawn(dir, {});
    assert.match(await a.send("sql d1 DB CREATE TABLE t(v TEXT)"), /^0 /);
    for (let i = 0; i < 40; i++) await a.send(`sql d1 DB INSERT INTO t VALUES(hex(randomblob(500)))`);
    await a.send("close d1 DB");
    await a.quit();
    const first = await epochOf(p.spool.d1);
    // offline change that keeps the size: flip a byte in the last page
    const bytes = new Uint8Array(await readFile(p.d1));
    bytes[bytes.length - 1] ^= 0xff;
    await Bun.sleep(20);
    await writeFile(p.d1, bytes);
    const b = await spawn(dir, {});
    assert.match(await b.send("sql d1 DB INSERT INTO t VALUES('x')"), /^[0-9]+ /);
    const stats = JSON.parse(await b.send("stats"));
    assert.equal(stats.cheap, 0, "a rewritten file is not trusted cheaply");
    assert.equal(stats.full, 1, "it is read in full");
    assert.equal(stats.fresh, 1, "and a new base is taken");
    await b.send("close d1 DB");
    await b.quit();
    const second = await epochOf(p.spool.d1);
    assert.notEqual(second.epoch, first.epoch);
    assert(second.seq > first.seq, "epochSeq grows");
    await assertEquals(p.spool.d1, p.d1, "after an offline change");
    // the spool is lost: the numbering still grows
    await rm(p.spool.d1, { recursive: true });
    const c = await spawn(dir, {});
    await c.send("sql d1 DB INSERT INTO t VALUES('y')");
    await c.send("close d1 DB");
    await c.quit();
    const third = await epochOf(p.spool.d1);
    assert(third.seq > second.seq, "epochSeq grows after a lost spool");
    // an LTXPOS2 record (the format before this change) is not resumed: a new epoch starts
    const old = await epochOf(p.spool.d1);
    const body = (await readFile(join(p.spool.d1, "position"), "utf8")).split("\n");
    const f = body[2].split(" ");
    const legacyBody = `LTXPOS2\n${old.epoch}\n${f[1]} ${f.slice(2, 11).join(" ")}\n`;
    await writeFile(join(p.spool.d1, "position"), legacyBody + "0000000000000000\n");
    const g = await spawn(dir, {});
    await g.send("sql d1 DB INSERT INTO t VALUES('z')");
    await g.send("close d1 DB");
    await g.quit();
    const fourth = await epochOf(p.spool.d1);
    assert.notEqual(fourth.epoch, old.epoch, "an older position format starts a new epoch");
    assert(fourth.seq > third.seq);
    await assertEquals(p.spool.d1, p.d1, "after an LTXPOS2 record");
    // a damaged last LTX file is never trusted, even with the database untouched: a new epoch, nothing resumed
    {
      const epoch = await epochOf(p.spool.d1);
      const names = (await readdir(join(p.spool.d1, epoch.epoch))).filter((n) => n.endsWith(".ltx")).sort();
      const last = join(p.spool.d1, epoch.epoch, names[names.length - 1]);
      const bytes = new Uint8Array(await readFile(last));
      await writeFile(last, bytes.subarray(0, bytes.length - 1));
      const h = await spawn(dir, {});
      await h.send("sql d1 DB INSERT INTO t VALUES('w')");
      const hs = JSON.parse(await h.send("stats"));
      assert.equal(hs.fresh, 1, "a truncated last LTX file forces a new base");
      await h.send("close d1 DB");
      await h.quit();
      assert.notEqual((await epochOf(p.spool.d1)).epoch, epoch.epoch);
      await assertEquals(p.spool.d1, p.d1, "after a damaged last file");
    }
    console.log(
      "PASS LTXPOS3: clean record trusts only its own file; epochSeq grows across epochs, a lost spool and an LTXPOS2 record",
    );
  }

  // 6. The dirty list.
  {
    const dir = await fresh();
    const d = await spawn(dir, {});
    await d.send("sql d1 DB CREATE TABLE t(v)");
    await d.send("sql store x CREATE TABLE kv(k)");
    await d.send(`sql do Room/${HEX} CREATE TABLE o(v)`);
    const list = join(dir, "spool/dirty");
    const lines = async () => (await readFile(list, "utf8")).split("\n").filter(Boolean);
    const first = await lines();
    assert.deepEqual(
      [...first].sort(),
      ["d1/DB", `do-sql/Room/${HEX}`, "store"].sort(),
      "each file named at its first commit",
    );
    for (let i = 0; i < 20; i++) await d.send("sql d1 DB INSERT INTO t VALUES(1)");
    assert.equal((await lines()).length, 3, "no repeat inside one second");
    await Bun.sleep(1100);
    await d.send("sql d1 DB INSERT INTO t VALUES(2)");
    const again = await lines();
    assert.equal(again.length, 4);
    assert.equal(again[3], "d1/DB", "named again after a second");
    // rotation: the shipper renames the list; the next naming lands in a new one
    await rename(list, list + ".draining");
    await Bun.sleep(1100);
    await d.send("sql d1 DB INSERT INTO t VALUES(3)");
    assert.deepEqual(await lines(), ["d1/DB"], "a renamed list is replaced, not appended to");
    await d.quit();
    console.log("PASS dirty list: named at first commit, once a second after, follows a rotation");
  }

  // 7. Crash and restart: SIGKILL a writer at random points, many rounds, over all three kinds; every row the writer
  // saw acknowledged must be in the restored chain, and restoring equals the database.
  {
    const dir = await fresh();
    const p = paths(dir);
    let acked = { d1: 0, store: 0, do: 0 };
    const rounds = Number(process.env.SB_S1_CRASH_ROUNDS ?? 25);
    let resumed = 0,
      fresh_ = 0;
    for (let round = 0; round < rounds; round++) {
      const d = await spawn(dir, {});
      if (round === 0) {
        await d.send("sql d1 DB CREATE TABLE t(id INTEGER PRIMARY KEY, v)");
        await d.send("sql store x CREATE TABLE kv(id INTEGER PRIMARY KEY, v)");
        await d.send(`sql do Room/${HEX} CREATE TABLE o(id INTEGER PRIMARY KEY, v)`);
      }
      const stop = Date.now() + 30 + ((round * 37) % 140);
      let i = 0;
      while (Date.now() < stop) {
        const kind = (["d1", "store", "do"] as const)[i % 3];
        const target = kind === "d1" ? "d1 DB" : kind === "store" ? "store x" : `do Room/${HEX}`;
        const table = kind === "d1" ? "t" : kind === "store" ? "kv" : "o";
        const reply = await d.send(`sql ${target} INSERT INTO ${table}(v) VALUES('${round}-${i}')`);
        assert.match(reply, /^0 /, reply);
        acked[kind]++;
        i++;
      }
      const s = JSON.parse(await d.send("stats"));
      resumed += s.resume;
      fresh_ += s.fresh;
      await d.kill();
    }
    // a final clean run settles the spools
    const last = await spawn(dir, {});
    for (const target of ["d1 DB", "store x", `do Room/${HEX}`]) await last.send(`close ${target}`);
    for (const [kind, table, target] of [
      ["d1", "t", "d1 DB"],
      ["store", "kv", "store x"],
      ["do", "o", `do Room/${HEX}`],
    ] as const) {
      await last.send(`sql ${target} SELECT 1`);
      await last.send(`close ${target}`);
      const db = new Database(p[kind], { readonly: true });
      const n = rows(db, table);
      assert(n >= acked[kind], `${kind}: ${n} rows in the database, ${acked[kind]} acknowledged`);
      assert.equal(db.query("PRAGMA integrity_check").values()[0][0], "ok");
      db.close();
      await assertEquals(p.spool[kind], p[kind], `${kind} after ${rounds} kills`);
    }
    await last.quit();
    console.log(
      `PASS crash and restart: ${rounds} SIGKILL rounds over d1, store and do-sql (${resumed} resumes, ${fresh_} fresh bases), every acknowledged write in the chain, restores equal the databases`,
    );
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
