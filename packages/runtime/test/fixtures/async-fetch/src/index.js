let counter = 0;
export default {
  async fetch(request) {
    const u = new URL(request.url);
    if (u.pathname === "/ping") return new Response("ok");
    const base = u.searchParams.get("base") || "http://127.0.0.1:19100";
    if (u.pathname === "/fan") {
      const n = Number(u.searchParams.get("n") || 20);
      const delay = u.searchParams.get("delay") || "100";
      const t0 = Date.now();
      const rs = await Promise.all(
        Array.from({ length: n }, (_, i) => fetch(base + "/slow?i=" + i + "&delay=" + delay).then((r) => r.text())),
      );
      return Response.json({ n, ms: Date.now() - t0, bodies: rs.slice(0, 3), last: rs[n - 1] });
    }
    if (u.pathname === "/one") {
      const r = await fetch(base + "/slow?delay=" + (u.searchParams.get("delay") || "0"));
      return new Response(await r.text(), { status: r.status });
    }
    if (u.pathname === "/post") {
      const r = await fetch(base + "/echo", { method: "POST", body: "hello-" + ++counter, headers: { "x-test": "1" } });
      return Response.json({ status: r.status, text: await r.text(), ct: r.headers.get("content-type") });
    }
    if (u.pathname === "/refuse") {
      try {
        await fetch("http://127.0.0.1:1/");
        return new Response("no error", { status: 500 });
      } catch (e) {
        return Response.json({ rejected: true, name: e.name, message: String(e.message) });
      }
    }
    if (u.pathname === "/abort") {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 20);
      try {
        await fetch(base + "/slow?delay=500", { signal: ac.signal });
        return new Response("no abort", { status: 500 });
      } catch (e) {
        return Response.json({ aborted: true, name: e.name });
      }
    }
    if (u.pathname === "/order") {
      // global state across an await fetch
      const mine = ++counter;
      await fetch(base + "/slow?delay=" + (u.searchParams.get("delay") || "50")).then((r) => r.text());
      return Response.json({ mine, after: counter });
    }
    return new Response("not found", { status: 404 });
  },
};
