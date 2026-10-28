let ready = false;
async function init(env) {
  if (ready) return;
  ready = true;
  await env.DB.exec("CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY, w TEXT)");
  await env.DB.exec("CREATE TABLE IF NOT EXISTS crons (at TEXT, w TEXT)");
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const w = __sbEnv("SB_WORKER_INDEX") || "solo";
    if (url.pathname === "/who") return new Response(w);
    await init(env);
    if (url.pathname === "/write") {
      const id = url.searchParams.get("id");
      await env.DB.prepare("INSERT INTO t (id, w) VALUES (?, ?)").bind(id, w).run();
      return new Response("ok");
    }
    if (url.pathname === "/batch") {
      const id = url.searchParams.get("id");
      await env.DB.batch([
        env.DB.prepare("INSERT INTO t (id, w) VALUES (?, ?)").bind(id, w),
        env.DB.prepare("SELECT count(*) AS n FROM t"),
      ]);
      return new Response("ok");
    }
    if (url.pathname === "/kv") {
      const key = url.searchParams.get("k");
      await env.KV.put(key, w);
      return new Response((await env.KV.get(key)) ?? "none");
    }
    if (url.pathname === "/count") {
      const r = await env.DB.prepare("SELECT count(*) AS n, count(distinct id) AS d FROM t").first();
      const c = await env.DB.prepare("SELECT count(*) AS n, count(distinct at) AS d FROM crons").first();
      const per = await env.DB.prepare("SELECT w, count(*) AS n FROM t GROUP BY w ORDER BY w").all();
      return Response.json({ n: r.n, d: r.d, crons: c.n, cronMinutes: c.d, per: per.results });
    }
    if (url.pathname === "/slow") {
      await new Promise((resolve) => setTimeout(resolve, Number(url.searchParams.get("ms") || 1500)));
      return new Response("slow-done:" + w);
    }
    return new Response("ok:" + w);
  },
  async scheduled(event, env) {
    await init(env);
    await env.DB.prepare("INSERT INTO crons (at, w) VALUES (?, ?)")
      .bind(String(event.scheduledTime), __sbEnv("SB_WORKER_INDEX") || "solo")
      .run();
  },
};
