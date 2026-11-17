// Storage stage S1 fixture: one handler that writes every kind of file stage S1 captures, and the disposable tables it moves.
//   /kv/put?k=K&v=V  /kv/get?k=K     KV  (store.sqlite)
//   /d1/put?v=V      /d1/all         D1  (d1/DB.sqlite)
//   /do/ID/put?v=V   /do/ID/all      a Durable Object: storage.put and storage.sql  (do-sql/Obj/<id>.sqlite, store.sqlite)
//   /rl /ae                          a rate limiter and an Analytics Engine write (volatile.sqlite when store is captured)
//   anything else                    "plain": touches no binding
const json = (v, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

export class Obj {
  constructor(state) {
    this.state = state;
  }
  async fetch(request) {
    const url = new URL(request.url);
    const v = url.searchParams.get("v") ?? "v";
    switch (url.pathname.slice(1)) {
      case "put": {
        await this.state.storage.put("last", v);
        this.state.storage.sql.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)");
        this.state.storage.sql.exec("INSERT INTO t VALUES (?)", v);
        return json({ ok: true });
      }
      default: {
        let rows = [];
        try {
          rows = this.state.storage.sql
            .exec("SELECT v FROM t ORDER BY rowid")
            .toArray()
            .map((r) => r.v);
        } catch {}
        return json({ last: (await this.state.storage.get("last")) ?? null, rows });
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.split("/").filter(Boolean);
    const v = url.searchParams.get("v") ?? "v";
    try {
      switch (path[0]) {
        case "kv":
          if (path[1] === "put") {
            await env.KV.put(url.searchParams.get("k") ?? "k", v);
            return json({ ok: true });
          }
          return json({ v: await env.KV.get(url.searchParams.get("k") ?? "k") });
        case "d1":
          await env.DB.prepare("CREATE TABLE IF NOT EXISTS t (v TEXT)").run();
          if (path[1] === "put") {
            await env.DB.prepare("INSERT INTO t VALUES (?)").bind(v).run();
            return json({ ok: true });
          }
          return json({ rows: (await env.DB.prepare("SELECT v FROM t ORDER BY rowid").all()).results.map((r) => r.v) });
        case "do": {
          const stub = env.OBJ.get(env.OBJ.idFromName(path[1]));
          const r = await stub.fetch("http://do/" + (path[2] ?? "all") + url.search);
          return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
        }
        case "rl":
          return json({ success: (await env.LIMITER.limit({ key: "k" })).success });
        case "ae":
          env.METRICS.writeDataPoint({ blobs: ["b"], doubles: [1], indexes: ["i"] });
          return json({ ok: true });
        default:
          return new Response("plain");
      }
    } catch (error) {
      return json({ error: String((error && error.message) || error) }, 500);
    }
  },
};
