// Durable Object eviction fixture (plan 018): objects that count what survives an eviction. Every handler is a path:
//   /via/ID/OP?...   a stub.fetch to object ID of class Obj (or Slow, Flaky) running OP; errors come back as JSON with `overloaded`
//   /release/N       resolves the zombie promise N
//   /zombie-result/N what the zombie got when it tried to write after its object was evicted
const json = (v, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
globalThis.__release = {};
globalThis.__zombie = {};

export class Obj {
  constructor(state, env) {
    this.state = state;
    this.mem = 0;
    this.ctor = 0;
    // The constructor count lives in storage: it goes up once per wake, not per request.
    state.blockConcurrencyWhile(async () => {
      this.ctor = ((await state.storage.get("ctor")) || 0) + 1;
      await state.storage.put("ctor", this.ctor);
    });
  }
  async fetch(request) {
    const url = new URL(request.url);
    const q = (k, d) => (url.searchParams.has(k) ? url.searchParams.get(k) : d);
    const storage = this.state.storage;
    switch (url.pathname.slice(1)) {
      case "mem":
        this.mem++;
        return json({ mem: this.mem, ctor: this.ctor });
      case "put":
        await storage.put(q("k", "k"), q("v", "v"));
        this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)");
        this.state.storage.sql.exec("INSERT INTO t VALUES (?)", q("v", "v"));
        return json({ ok: true });
      case "get": {
        let rows = [];
        try {
          rows = this.state.storage.sql
            .exec("SELECT v FROM t")
            .toArray()
            .map((r) => r.v);
        } catch {}
        return json({ k: (await storage.get(q("k", "k"))) ?? null, rows, ctor: this.ctor, mem: this.mem });
      }
      case "alarm":
        await storage.setAlarm(Date.now() + Number(q("ms", "1000")));
        return json({ ok: true, ctor: this.ctor });
      case "failalarm":
        await storage.put("failAlarm", Number(q("n", "2")));
        await storage.setAlarm(Date.now() + Number(q("ms", "300")));
        return json({ ok: true });
      case "alarmlog":
        return json({
          log: (await storage.get("alarmLog")) || [],
          runs: (await storage.get("alarmRuns")) || 0,
          ctor: this.ctor,
        });
      case "hold":
        await sleep(Number(q("ms", "1000")));
        return json({ mem: this.mem, ctor: this.ctor });
      case "waituntil":
        this.state.waitUntil(sleep(Number(q("ms", "800"))).then(() => storage.put("wu", "done")));
        return json({ ok: true });
      case "timer": {
        const ms = Number(q("ms", "1200"));
        setTimeout(() => {
          this.fired = true;
        }, ms);
        return json({ ok: true });
      }
      case "interval":
        this.tick = 0;
        setInterval(() => {
          this.tick++;
        }, 100);
        return json({ ok: true });
      case "txn":
        await storage.transaction(async (txn) => {
          await txn.put("t", 1);
          await sleep(Number(q("ms", "1200")));
        });
        return json({ ok: true });
      case "abort":
        this.state.abort("test abort");
        return json({ unreachable: true });
      case "zombie": {
        const n = q("n", "1");
        const state = this.state;
        // A promise chain the handler forgets: it wakes after the object was evicted and writes as if it were still alive.
        new Promise((resolve) => {
          globalThis.__release[n] = resolve;
        }).then(async () => {
          try {
            await state.storage.put("z", "written by a zombie");
            globalThis.__zombie[n] = "wrote";
          } catch (e) {
            globalThis.__zombie[n] = "rejected: " + e.message;
          }
        });
        return json({ ok: true });
      }
      default:
        return json({ error: "no such op" }, 404);
    }
  }
  async alarm(info) {
    const storage = this.state.storage;
    const left = (await storage.get("failAlarm")) || 0;
    const runs = ((await storage.get("alarmRuns")) || 0) + 1;
    await storage.put("alarmRuns", runs);
    const log = (await storage.get("alarmLog")) || [];
    log.push({ retryCount: info.retryCount, isRetry: info.isRetry, ctor: this.ctor, mem: this.mem });
    await storage.put("alarmLog", log);
    if (left > 0) {
      await storage.put("failAlarm", left - 1);
      throw new Error("alarm failed on purpose");
    }
  }
}

// A constructor that holds the gate for a while: events queue behind it.
export class Slow {
  constructor(state) {
    this.state = state;
    state.blockConcurrencyWhile(async () => {
      await sleep(600);
      this.ready = true;
    });
  }
  async fetch() {
    return json({ ready: this.ready === true });
  }
}

// A constructor whose blockConcurrencyWhile rejects the first time: the object is reset and built again.
export class Flaky {
  constructor(state) {
    this.state = state;
    state.blockConcurrencyWhile(async () => {
      const n = ((await state.storage.get("flaky")) || 0) + 1;
      await state.storage.put("flaky", n);
      if (n === 1) throw new Error("first construction fails");
      this.ok = n;
    });
  }
  async fetch() {
    return json({ ok: this.ok });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/");
    if (parts[1] === "release") {
      globalThis.__release[parts[2]]();
      await sleep(50);
      return json({ ok: true });
    }
    if (parts[1] === "zombie-result") return json({ result: globalThis.__zombie[parts[2]] ?? null });
    if (parts[1] !== "via") return new Response("ok");
    const cls = url.searchParams.get("cls") || "Obj";
    const ns = cls === "Slow" ? env.SLOW : cls === "Flaky" ? env.FLAKY : env.OBJ;
    try {
      const stub = ns.get(ns.idFromName(parts[2]));
      const res = await stub.fetch(new Request("https://do/" + parts[3] + url.search));
      return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
    } catch (e) {
      return json({ error: String(e.message), overloaded: e.overloaded === true }, 503);
    }
  },
};
