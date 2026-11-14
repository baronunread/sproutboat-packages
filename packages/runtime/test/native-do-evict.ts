import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Durable Object eviction (plan 018, compatibility date 2026-11-21) on a standalone binary: an idle object leaves memory after
// SB_DO_IDLE_MS and its next event constructs it again; the cap, the overloaded error, alarms into evicted objects, pins, the
// reset on a failed blockConcurrencyWhile and the revoked zombie. These are the first copy of the conformance cases of
// sproutd's conformance/bindings/do.js (plan 018 phase 4). Needs SB_CLI, a sproutboat-cli checkout linked to this one.
const cli = process.env.SB_CLI;
if (!cli) {
  console.log("skipped: set SB_CLI to a sproutboat-cli checkout linked to this checkout (it builds the sprout)");
  process.exit(0);
}
const IDLE = 300; // ms; every case waits four times that
const WAIT = IDLE * 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = mkdtempSync(join(tmpdir(), "sb-native-do-evict-"));
const servers: ReturnType<typeof Bun.spawn>[] = [];
const fixture = new URL("./fixtures/do-evict-app.js", import.meta.url).pathname;

function build(label: string, date: string): string {
  const project = join(workdir, label);
  mkdirSync(join(project, "src"), { recursive: true });
  copyFileSync(fixture, join(project, "src/index.js"));
  writeFileSync(
    join(project, "sproutboat.jsonc"),
    JSON.stringify({
      name: "evict-app",
      main: "src/index.js",
      compatibility_date: date,
      durable_objects: { OBJ: "Obj", SLOW: "Slow", FLAKY: "Flaky" },
    }),
  );
  const built = Bun.spawnSync(["bun", join(cli!, "src/main.ts"), "build", "--standalone", "--target", "host"], {
    cwd: project,
    stdout: "ignore",
    stderr: "inherit",
  });
  assert.equal(built.exitCode, 0, `${label}: the CLI could not build the sprout`);
  return join(project, "dist/evict-app");
}

interface Server {
  port: number;
  kill(): Promise<void>;
  get(path: string): Promise<any>;
  raw(path: string): Promise<Response>;
  stderr(): string;
}
async function start(binary: string, label: string, env: Record<string, string>, capture = false): Promise<Server> {
  const port = freePort();
  const data = join(workdir, `data-${label}`);
  const proc = Bun.spawn([binary], {
    cwd: workdir,
    env: { ...process.env, SB_DATA_DIR: data, PORT: String(port), ...env },
    stdout: "ignore",
    stderr: capture ? "pipe" : "inherit",
  });
  servers.push(proc);
  let captured = "";
  if (capture && proc.stderr instanceof ReadableStream) {
    const stream = proc.stderr;
    void (async () => {
      for await (const chunk of stream) captured += new TextDecoder().decode(chunk);
    })();
  }
  let up = false;
  for (let attempt = 0; attempt < 100 && !up; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
      up = true;
    } catch {
      if (proc.exitCode !== null) break;
      await sleep(100);
    }
  }
  assert(up, `${label}: the compiled handler did not start`);
  return {
    port,
    stderr: () => captured,
    raw: (path) => fetch(`http://127.0.0.1:${port}${path}`),
    get: async (path) => (await fetch(`http://127.0.0.1:${port}${path}`)).json(),
    kill: async () => {
      proc.kill(9);
      await proc.exited;
    },
  };
}
let ids = 0;
const fresh = () => `o${Date.now().toString(36)}${ids++}`;

try {
  const [binary, before] = await Promise.all([
    Promise.resolve(build("on", "2026-11-21")),
    Promise.resolve(build("off", "2026-11-20")),
  ]);
  const main = await start(binary, "main", { SB_DO_IDLE_MS: String(IDLE) });

  // evictMem: an in-memory counter is 1 again after the idle wait; without the wait it is 2
  {
    const id = fresh();
    assert.equal((await main.get(`/via/${id}/mem`)).mem, 1);
    assert.equal((await main.get(`/via/${id}/mem`)).mem, 2, "no wait: the object stayed");
    await sleep(WAIT);
    const after = await main.get(`/via/${id}/mem`);
    assert.equal(after.mem, 1, "after the idle wait the instance is new");
    // evictCtor: the constructor count in storage went up by one per wake, not per request
    assert.equal(after.ctor, 2);
    for (let i = 0; i < 5; i++) assert.equal((await main.get(`/via/${id}/mem`)).ctor, 2);
  }

  // evictStorage, evictSql: a key and a row written before the wait are read after it
  {
    const id = fresh();
    await main.get(`/via/${id}/put?k=key&v=value1`);
    await sleep(WAIT);
    const got = await main.get(`/via/${id}/get?k=key`);
    assert.equal(got.k, "value1");
    assert.deepEqual(got.rows, ["value1"]);
    assert.equal(got.mem, 0, "a new instance");
  }

  // evictBusy: a request that sits in the object for several idle waits is not evicted in flight
  {
    const id = fresh();
    await main.get(`/via/${id}/mem`);
    const held = await main.get(`/via/${id}/hold?ms=${WAIT * 2}`);
    assert.equal(held.ctor, 1);
    assert.equal((await main.get(`/via/${id}/mem`)).mem, 2, "same instance after the long request");
  }

  // evictWaitUntil: a waitUntil task that outlives the response keeps the object, and its write is there afterwards
  {
    const id = fresh();
    await main.get(`/via/${id}/mem`);
    await main.get(`/via/${id}/waituntil?ms=${WAIT}`);
    await sleep(IDLE * 2);
    assert.equal((await main.get(`/via/${id}/mem`)).mem, 2, "kept while the task runs");
    await sleep(WAIT * 2);
    const got = await main.get(`/via/${id}/get?k=wu`);
    assert.equal(got.k, "done");
    assert.equal(got.mem, 0, "and then it left");
  }

  // evictTimerPin: a pending setTimeout keeps the object; it leaves after the timer fired and another wait
  {
    const id = fresh();
    await main.get(`/via/${id}/mem`);
    await main.get(`/via/${id}/timer?ms=${WAIT * 2}`);
    await sleep(WAIT);
    assert.equal((await main.get(`/via/${id}/mem`)).mem, 2, "pinned by the timer");
    await sleep(WAIT * 2 + IDLE);
    assert.equal((await main.get(`/via/${id}/mem`)).mem, 1, "gone after the timer fired and another wait");
  }

  // a never-cleared setInterval pins forever
  {
    const id = fresh();
    await main.get(`/via/${id}/interval`);
    await sleep(WAIT * 2);
    assert.equal((await main.get(`/via/${id}/mem`)).mem, 1, "not evicted: the interval lives");
    await sleep(WAIT);
    assert.equal((await main.get(`/via/${id}/mem`)).mem, 2);
  }

  // evictTxn: a transaction that awaits across the wait commits; the object was not evicted under it
  {
    const id = fresh();
    await main.get(`/via/${id}/mem`);
    await main.get(`/via/${id}/txn?ms=${WAIT * 2}`);
    assert.equal((await main.get(`/via/${id}/mem`)).mem, 2);
    assert.equal((await main.get(`/via/${id}/get?k=t`)).k, 1, "committed");
  }

  // evictZombie: a promise the handler left running writes after the object was evicted: rejected, key absent
  {
    const id = fresh();
    await main.get(`/via/${id}/zombie?n=1`);
    await sleep(WAIT);
    await main.get("/release/1");
    const result = (await main.get("/zombie-result/1")).result;
    assert.match(result, /^rejected: .*evicted/, result);
    assert.equal((await main.get(`/via/${id}/get?k=z`)).k, null, "the zombie's key is absent");
  }

  // evictAbort: abort() then a call: new instance, storage kept, SQL readable
  {
    const id = fresh();
    await main.get(`/via/${id}/put?k=a&v=1`);
    await main.get(`/via/${id}/mem`);
    const aborted = await main.raw(`/via/${id}/abort`);
    assert.equal(aborted.status, 503);
    const next = await main.get(`/via/${id}/get?k=a`);
    assert.equal(next.mem, 0);
    assert.equal(next.k, "1");
    assert.deepEqual(next.rows, ["1"]);
    assert(next.ctor >= 2, "constructed again");
  }

  // evictBcw: the first event after a wake sees the field the constructor's blockConcurrencyWhile set
  {
    const id = fresh();
    await main.get(`/via/${id}/mem`);
    await sleep(WAIT);
    assert.equal((await main.get(`/via/${id}/mem`)).ctor, 2);
  }
  // evictBcwThrow: a constructor whose blockConcurrencyWhile rejects once: that call fails, the next constructs again and succeeds
  {
    const id = fresh();
    const first = await main.raw(`/via/${id}/x?cls=Flaky`);
    assert.equal(first.status, 503, "the first call fails");
    const second = await main.get(`/via/${id}/x?cls=Flaky`);
    assert.equal(second.ok, 2, "built again and succeeded");
  }

  // evictAlarm: an alarm set before the wait fires after it; the constructor ran before alarm(); one run
  {
    const id = fresh();
    await main.get(`/via/${id}/alarm?ms=${WAIT * 2}`);
    await sleep(WAIT);
    let log = await main.get(`/via/${id}/alarmlog`);
    assert.equal(log.runs, 0, "the alarm is not due yet");
    const ctorBefore = log.ctor;
    assert.equal(ctorBefore, 2, "the read above woke the evicted object");
    await sleep(WAIT * 3);
    log = await main.get(`/via/${id}/alarmlog`);
    assert.equal(log.runs, 1);
    assert.equal(
      log.log[0].ctor,
      ctorBefore + 1,
      "the object was evicted again and its constructor ran before alarm()",
    );
    assert.equal(log.log[0].retryCount, 0);
  }

  // evictAlarmRetry: an alarm that throws twice, with a wait between, sees retryCount 0, 1, 2 (the row's count, not the instance's)
  {
    const id = fresh();
    await main.get(`/via/${id}/failalarm?n=2&ms=100`);
    let log = await main.get(`/via/${id}/alarmlog`);
    for (let i = 0; i < 40 && log.runs < 3; i++) {
      await sleep(500);
      log = await main.get(`/via/${id}/alarmlog`);
    }
    assert.deepEqual(
      log.log.map((r) => r.retryCount),
      [0, 1, 2],
    );
    assert.equal(log.runs, 3);
  }

  // evictManyAlarms: 40 objects with alarms due at once all run exactly once
  {
    const base = fresh();
    const names = Array.from({ length: 40 }, (_, i) => `${base}-${i}`);
    await Promise.all(names.map((n) => main.get(`/via/${n}/alarm?ms=1500`)));
    await sleep(6000);
    const runs = await Promise.all(names.map(async (n) => (await main.get(`/via/${n}/alarmlog`)).runs));
    assert.deepEqual(
      runs,
      names.map(() => 1),
    );
  }
  await main.kill();

  // capWait, capOverloaded: at most 4 objects awake; 8 short requests all answer; 4 long ones and a fifth: the fifth is overloaded
  {
    const capped = await start(binary, "cap", { SB_DO_IDLE_MS: "600000", SB_DO_MAX: "4", SB_DO_WAIT_MS: "800" });
    const names = Array.from({ length: 8 }, () => fresh());
    const answers = await Promise.all(names.map((n) => capped.get(`/via/${n}/hold?ms=150`)));
    assert.equal(answers.length, 8);
    for (const a of answers) assert.equal(a.error, undefined, JSON.stringify(a));
    const longs = Array.from({ length: 4 }, () => fresh());
    const holding = longs.map((n) => capped.get(`/via/${n}/hold?ms=2500`));
    await sleep(300);
    const t0 = performance.now();
    const fifth = await capped.get(`/via/${fresh()}/mem`);
    const waited = performance.now() - t0;
    assert.equal(fifth.overloaded, true, JSON.stringify(fifth));
    assert(waited >= 700, `waited ${Math.round(waited)} ms before the error`);
    for (const h of await Promise.all(holding))
      assert.equal(h.error, undefined, "the long requests were not disturbed");
    // the slots are free again
    assert.equal((await capped.get(`/via/${fresh()}/mem`)).mem, 1);
    await capped.kill();
  }

  // the per-object queue limit: events queued behind one object's gate beyond SB_DO_QUEUE_MAX are overloaded
  {
    const queued = await start(binary, "queue", { SB_DO_IDLE_MS: "600000", SB_DO_QUEUE_MAX: "3" });
    const id = fresh();
    const calls = await Promise.all(Array.from({ length: 6 }, () => queued.get(`/via/${id}/x?cls=Slow`)));
    const overloaded = calls.filter((c) => c.overloaded === true).length;
    const served = calls.filter((c) => c.ready === true).length;
    assert.equal(served, 3, JSON.stringify(calls));
    assert.equal(overloaded, 3, JSON.stringify(calls));
    await queued.kill();
  }

  // the sweep runs on its own timer: with no further request an idle object still leaves (the counters say so on stderr)
  {
    const quiet = await start(binary, "sweep", { SB_DO_IDLE_MS: String(IDLE), SB_DO_STATS: "1" }, true);
    await quiet.get(`/via/${fresh()}/mem`);
    await sleep(WAIT);
    const text = quiet.stderr();
    assert.match(text, /objects_awake=1 /, text);
    assert.match(text, /objects_awake=0 .*evicted_idle=1 /, text);
    await quiet.kill();
  }

  // SB_DO_IDLE_MS=0 keeps everything resident (the cap still applies)
  {
    const resident = await start(binary, "resident", { SB_DO_IDLE_MS: "0" });
    const id = fresh();
    await resident.get(`/via/${id}/mem`);
    await sleep(WAIT);
    assert.equal((await resident.get(`/via/${id}/mem`)).mem, 2);
    await resident.kill();
  }

  // before the compatibility date nothing evicts
  {
    const old = await start(before, "before", { SB_DO_IDLE_MS: String(IDLE) });
    const id = fresh();
    await old.get(`/via/${id}/mem`);
    await sleep(WAIT);
    const after = await old.get(`/via/${id}/mem`);
    assert.equal(after.mem, 2, "the object stayed resident");
    assert.equal(after.ctor, 1);
    await old.kill();
  }
  console.log("native-do-evict: ok");
} finally {
  for (const server of servers) server.kill(9);
  rmSync(workdir, { recursive: true, force: true });
}
