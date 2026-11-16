import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { restore } from "./ltx-restore.ts";
import { buildDriver, spawnDriver, type Driver } from "./s1b-driver.ts";
import { Disk, parseTrace, type Op } from "./plsim.ts";

// Design 029 stage S1b: the crash campaign for the capture's new write path (no per-commit fsync of capture files, W
// records never synced, checkpoint by size or time, group commit). Two parts:
//
//  1. Power loss (Linux with strace). A real run is traced; for a power cut after (nearly) every syscall of it the disk a
//     cut would leave is rebuilt (plsim.ts: strict, and torn with a seed) and the real code recovers from it. At every point:
//     the database passes integrity_check; every row the run had acknowledged is in it (a "sql" reply, or the "flush"
//     reply that releases held "sqld" commits); and, after the recovered handle closes cleanly, the spool's chain restores
//     byte for byte to the database. Recovery may start a new epoch (a base image); it may never lose or invent a row.
//  2. SIGKILL (everywhere). Many rounds of random mixes of inline and held commits, killed at random times: the same checks
//     (a plain kill keeps the page cache, so this is the process-death half of the promise).
// SB_S1B_POINTS caps the power-cut points per scenario (default 600; the campaign of the report used 4000).
const work = await mkdtemp(join(tmpdir(), "sb-native-s1b-crash-"));
const binary = await buildDriver(work);
const maxPoints = Number(process.env.SB_S1B_POINTS ?? 600);
const rounds = Number(process.env.SB_S1B_ROUNDS ?? 40);

type Cmd = { line: string; ack?: { d1?: string; store?: string }; held?: boolean };
const HEXQ = (v: string) => v.replace(/'/g, "''");
let seq = 0;
const insert = (kind: "d1" | "store", held = false): Cmd => {
  const v = `v${seq++}`;
  return kind === "d1"
    ? { line: `${held ? "sqld" : "sql"} d1 DB INSERT INTO t(v) VALUES('${HEXQ(v)}')`, ack: { d1: v }, held }
    : { line: `${held ? "sqld" : "sql"} store x INSERT INTO kv(v) VALUES('${HEXQ(v)}')`, ack: { store: v }, held };
};
const SCHEMA = [
  "sql d1 DB CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)",
  "sql store x CREATE TABLE kv(id INTEGER PRIMARY KEY, v TEXT)",
];

// ---- what a recovered tree must satisfy ----
type Acked = { d1: Set<string>; store: Set<string> };
function values(file: string, sql: string): string[] {
  const db = new Database(file, { readonly: true });
  try {
    assert.equal(db.query("PRAGMA integrity_check").values()[0][0], "ok", file + ": integrity_check");
    return db
      .query(sql)
      .values()
      .map((r) => String(r[0]));
  } finally {
    db.close();
  }
}
async function chainEqualsFile(spool: string, file: string, label: string) {
  const text = (await readFile(join(spool, "position"), "utf8")).split("\n");
  assert.equal(text[0], "LTXPOS4", label);
  assert.equal(text[2].split(" ")[1], "C", label + ": a clean close leaves a clean record");
  const out = join(work, "restored-" + Math.random().toString(36).slice(2));
  await restore(join(spool, text[1]), out);
  const a = readFileSync(out),
    b = readFileSync(file);
  rmSync(out, { force: true });
  assert(a.length === b.length && Buffer.compare(a, b) === 0, label + ": the chain does not restore to the database");
}
let recovered = { resume: 0, fresh: 0, cheap: 0, full: 0 };
async function recoverAndCheck(img: string, acked: Acked, label: string, have: { d1: boolean; store: boolean }) {
  const d = await spawnDriver(binary, img, {});
  try {
    if (have.d1) assert.notEqual((await d.send("open d1 DB")).split(" ")[0], "-1", label + ": open d1");
    if (have.store) assert.notEqual((await d.send("open store x")).split(" ")[0], "-1", label + ": open store");
    const s = JSON.parse(await d.send("stats"));
    recovered.resume += s.resume;
    recovered.fresh += s.fresh;
    recovered.cheap += s.cheap;
    recovered.full += s.full;
    // the recovered handle takes a statement, then closes cleanly
    if (have.d1) assert.match(await d.send("sql d1 DB INSERT INTO t(v) VALUES('after-recovery')"), /^0 /, label);
    if (have.d1) await d.send("close d1 DB");
    if (have.store) await d.send("close store x");
  } finally {
    await d.quit();
  }
  if (have.d1) {
    const got = new Set(values(join(img, "data/d1/DB.sqlite"), "SELECT v FROM t"));
    for (const v of acked.d1) assert(got.has(v), `${label}: acknowledged d1 row ${v} is lost`);
    await chainEqualsFile(join(img, "spool/d1/DB"), join(img, "data/d1/DB.sqlite"), label + " d1");
  }
  if (have.store) {
    const got = new Set(values(join(img, "data/store.sqlite"), "SELECT v FROM kv"));
    for (const v of acked.store) assert(got.has(v), `${label}: acknowledged store row ${v} is lost`);
    await chainEqualsFile(join(img, "spool/store"), join(img, "data/store.sqlite"), label + " store");
  }
}

// ---- part 1: power loss ----
const strace = Bun.spawnSync(["sh", "-c", "command -v strace"]);
const haveStrace = process.platform === "linux" && strace.exitCode === 0;
const traceCalls =
  "open,openat,creat,close,lseek,write,pwrite64,ftruncate,truncate,fsync,fdatasync,rename,renameat,renameat2,link,linkat,unlink,unlinkat,rmdir,mkdir,mkdirat";

async function runScenario(
  name: string,
  opts: {
    prep: Cmd[];
    prepKill?: boolean;
    traced: Cmd[];
    env: Record<string, string>;
    closeAtEnd?: boolean;
  },
) {
  const root = join(work, name);
  mkdirSync(root, { recursive: true });
  // the initial state: built by an untraced process, then synced
  const prepAcked: Acked = { d1: new Set(), store: new Set() };
  {
    const d = await spawnDriver(binary, root, opts.env);
    for (const line of SCHEMA) await d.send(line);
    for (const c of opts.prep) {
      await d.send(c.line);
      if (c.held) continue;
      if (c.ack?.d1) prepAcked.d1.add(c.ack.d1);
      if (c.ack?.store) prepAcked.store.add(c.ack.store);
    }
    if (opts.prep.some((c) => c.held)) {
      await d.send("flush");
      for (const c of opts.prep) {
        if (c.ack?.d1) prepAcked.d1.add(c.ack.d1);
        if (c.ack?.store) prepAcked.store.add(c.ack.store);
      }
    }
    if (opts.prepKill) await d.kill();
    else {
      await d.send("close d1 DB");
      await d.send("close store x");
      await d.quit();
    }
  }
  Bun.spawnSync(["sync"]);
  const initial = root + ".initial";
  rmSync(initial, { recursive: true, force: true });
  cpSync(root, initial, { recursive: true });
  // the traced run
  const tracePath = root + ".trace";
  const child = Bun.spawn(
    ["strace", "-f", "-qq", "-xx", "-s", "4194304", "-e", `trace=${traceCalls}`, "-o", tracePath, binary, root],
    {
      env: {
        PATH: process.env.PATH ?? "",
        SB_LTX_ROOT: join(root, "spool"),
        SB_DATA_DIR: join(root, "data"),
        SB_LTX_ENABLE: "1",
        SB_LTX_SCOPE: "d1,store,do-sql",
        SB_OWNER_LOCK: "1",
        ...opts.env,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const reader = child.stdout.getReader();
  let buf = "";
  const line = async () => {
    while (!buf.includes("\n")) {
      const r = await reader.read();
      if (r.done) throw new Error("traced driver exited: " + (await new Response(child.stderr).text()));
      buf += new TextDecoder().decode(r.value);
    }
    const i = buf.indexOf("\n");
    const out = buf.slice(0, i);
    buf = buf.slice(i + 1);
    return out;
  };
  assert.equal(await line(), "ready");
  const cmds = [...opts.traced];
  if (opts.closeAtEnd) cmds.push({ line: "close d1 DB" }, { line: "close store x" });
  const replies: string[] = [];
  for (const c of cmds) {
    child.stdin.write(c.line + "\n");
    child.stdin.flush();
    replies.push(await line());
  }
  child.stdin.write("quit\n");
  child.stdin.end();
  await child.exited;
  // acknowledgements, by the reply that carries them (reply 0 is "ready")
  const ackedAt: Acked[] = [{ d1: new Set(prepAcked.d1), store: new Set(prepAcked.store) }];
  const held: Cmd[] = [];
  for (let i = 0; i < cmds.length; i++) {
    const prev = ackedAt[ackedAt.length - 1];
    const next: Acked = { d1: new Set(prev.d1), store: new Set(prev.store) };
    const c = cmds[i];
    if (c.held) held.push(c);
    else if (c.line === "flush") {
      for (const h of held) {
        if (h.ack?.d1) next.d1.add(h.ack.d1);
        if (h.ack?.store) next.store.add(h.ack.store);
      }
      held.length = 0;
    } else if (c.ack && /^0 /.test(replies[i])) {
      if (c.ack.d1) next.d1.add(c.ack.d1);
      if (c.ack.store) next.store.add(c.ack.store);
    }
    ackedAt.push(next);
  }
  const ops = parseTrace(readFileSync(tracePath, "utf8"), root);
  rmSync(tracePath, { force: true });
  assert(ops.length > 50, name + ": the trace is empty");
  // which operations are crash points
  const interesting = (op: Op, i: number) => op.t !== "write" || i % 4 === 0;
  const all = ops.map((op, i) => ({ op, i })).filter(({ op, i }) => interesting(op, i));
  const stride = Math.max(1, Math.ceil(all.length / maxPoints));
  const chosen = new Set(all.filter((_, j) => j % stride === 0).map(({ i }) => i));
  const disk = new Disk(root);
  disk.loadInitial(initial);
  let acks = 0,
    checked = 0;
  const kinds: Partial<Record<Op["t"], number>> = {};
  const have = { d1: true, store: true };
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.t === "ack") acks++;
    disk.apply(op);
    if (!chosen.has(i)) continue;
    // the replies the run had written by now: reply 0 is "ready", reply n carries command n-1's answer
    const acked = ackedAt[Math.max(0, Math.min(ackedAt.length - 1, acks - 1))];
    for (const mode of ["strict", "torn"] as const) {
      if (mode === "torn" && checked % 2) continue;
      const img = join(work, `${name}-image`);
      disk.materialize(img, mode, 1000 + i);
      await recoverAndCheck(img, acked, `${name} cut after op ${i} (${op.t}) ${mode}`, have).catch((e) => {
        throw new Error(`${e.message}\n  op ${i}: ${JSON.stringify({ ...op, data: undefined })}`);
      });
      checked++;
      kinds[op.t] = (kinds[op.t] ?? 0) + 1;
    }
  }
  rmSync(join(work, `${name}-image`), { recursive: true, force: true });
  rmSync(initial, { recursive: true, force: true });
  return { name, ops: ops.length, checked, kinds };
}

try {
  if (haveStrace) {
    const results = [];
    // A. steady state: inline commits, a checkpoint every few commits (a 48 KiB WAL), on two files
    seq = 0;
    {
      const prep = Array.from({ length: 12 }, (_, i) => insert(i % 2 ? "store" : "d1"));
      const traced: Cmd[] = [];
      for (let i = 0; i < 90; i++) traced.push(insert(i % 3 === 2 ? "store" : "d1"));
      results.push(
        await runScenario("steady", {
          prep,
          traced,
          env: { SB_LTX_CKPT_BYTES: "49152", SB_LTX_CKPT_MS: "3600000" },
          closeAtEnd: true,
        }),
      );
    }
    // B. group commit: held commits flushed together, inline ones between, checkpoints due inside groups
    seq = 0;
    {
      const prep = Array.from({ length: 6 }, () => insert("d1"));
      const traced: Cmd[] = [];
      for (let g = 0; g < 22; g++) {
        const n = 1 + (g % 6);
        for (let i = 0; i < n; i++) traced.push(insert(i % 2 ? "store" : "d1", true));
        traced.push({ line: "flush" });
        if (g % 5 === 4) traced.push(insert("d1"));
      }
      results.push(
        await runScenario("group", {
          prep,
          traced,
          env: { SB_LTX_CKPT_BYTES: "49152", SB_LTX_CKPT_MS: "3600000" },
          closeAtEnd: true,
        }),
      );
    }
    // C. the traced process starts on a killed W state (files above synced_txid): resume, then commits, no checkpoint
    seq = 0;
    {
      const prep = Array.from({ length: 30 }, (_, i) => insert(i % 2 ? "store" : "d1"));
      const traced: Cmd[] = [];
      for (let i = 0; i < 50; i++) traced.push(insert(i % 2 ? "store" : "d1"));
      results.push(
        await runScenario("resume", {
          prep,
          prepKill: true,
          traced,
          env: { SB_LTX_CKPT_BYTES: "8388608", SB_LTX_CKPT_MS: "3600000" },
          closeAtEnd: false,
        }),
      );
    }
    // D. the default policy with big commits: base-sized frames, a checkpoint by size
    seq = 0;
    {
      const prep = Array.from({ length: 4 }, () => insert("d1"));
      const traced: Cmd[] = [];
      for (let i = 0; i < 30; i++) {
        const v = `v${seq++}`;
        traced.push({ line: `sql d1 DB INSERT INTO t(v) VALUES('${v}' || hex(randomblob(3000)))`, ack: { d1: v } });
      }
      results.push(
        await runScenario("big", {
          prep,
          traced,
          env: { SB_LTX_CKPT_BYTES: "131072", SB_LTX_CKPT_MS: "3600000" },
          closeAtEnd: true,
        }),
      );
    }
    let total = 0;
    for (const r of results) {
      total += r.checked;
      console.log(
        `  ${r.name}: ${r.ops} syscalls traced, ${r.checked} power cuts recovered (${Object.entries(r.kinds)
          .filter(([, n]) => n)
          .map(([k, n]) => `${n} after ${k}`)
          .join(", ")})`,
      );
    }
    console.log(
      `  recoveries: ${recovered.resume} resumed in place, ${recovered.fresh} started a new epoch, ${recovered.cheap} cheap reopens, ${recovered.full} full-checksum reopens`,
    );
    console.log(
      `PASS power loss: ${total} simulated cuts over ${results.length} scenarios; no acknowledged row lost, integrity ok, every restore byte for byte`,
    );
  } else {
    console.log("skipped part 1 (power loss): needs Linux and strace");
  }

  // ---- part 2: SIGKILL rounds, random mixes of inline and held commits ----
  {
    recovered = { resume: 0, fresh: 0, cheap: 0, full: 0 };
    const dir = await mkdtemp(join(work, "kill-"));
    let s = 12345;
    const rnd = (n: number) => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s % n;
    };
    seq = 0;
    const acked: Acked = { d1: new Set(), store: new Set() };
    let rowsAcked = 0;
    for (let round = 0; round < rounds; round++) {
      const env = rnd(2)
        ? { SB_LTX_CKPT_BYTES: String(16384 + rnd(5) * 16384), SB_LTX_CKPT_MS: "3600000" }
        : { SB_LTX_CKPT_BYTES: "8388608", SB_LTX_CKPT_MS: "40" };
      const d = await spawnDriver(binary, dir, env);
      if (round === 0) for (const line of SCHEMA) await d.send(line);
      else {
        for (const k of ["d1 DB", "store x"]) await d.send(`open ${k}`);
      }
      const stop = Date.now() + 20 + rnd(120);
      let pending: Cmd[] = [];
      while (Date.now() < stop) {
        const r = rnd(10);
        if (r < 5) {
          const c = insert(rnd(2) ? "d1" : "store");
          const reply = await d.send(c.line);
          assert.match(reply, /^0 /, reply);
          if (c.ack?.d1) acked.d1.add(c.ack.d1);
          if (c.ack?.store) acked.store.add(c.ack.store);
          rowsAcked++;
        } else if (r < 9) {
          const c = insert(rnd(2) ? "d1" : "store", true);
          assert.match(await d.send(c.line), /^D 0/);
          pending.push(c);
        } else if (pending.length) {
          assert.equal(await d.send("flush"), "0 flushed");
          for (const c of pending) {
            if (c.ack?.d1) acked.d1.add(c.ack.d1);
            if (c.ack?.store) acked.store.add(c.ack.store);
            rowsAcked++;
          }
          pending = [];
        }
      }
      await d.kill(); // held commits not flushed are not acknowledged and may or may not survive
    }
    await recoverAndCheck(dir, acked, `${rounds} SIGKILL rounds`, { d1: true, store: true });
    console.log(
      `PASS SIGKILL: ${rounds} rounds of random inline and held commits (${rowsAcked} acknowledged rows over d1 and store), every acknowledged row present, integrity ok, chains restore byte for byte`,
    );
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
