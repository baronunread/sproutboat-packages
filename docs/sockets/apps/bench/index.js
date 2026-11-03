import { connect } from "cloudflare:sockets";
const held = [];
export default {
  async fetch(req) {
    const u = new URL(req.url);
    const port = Number(u.searchParams.get("port"));
    if (u.pathname === "/lat") {
      const n = Number(u.searchParams.get("n") || 200);
      const times = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        const s = connect({ hostname: "127.0.0.1", port });
        await s.opened;
        times.push((performance.now() - t0) * 1000);
        await s.close();
      }
      times.sort((a, b) => a - b);
      return Response.json({
        n,
        p50_us: Math.round(times[n >> 1]),
        p99_us: Math.round(times[Math.floor(n * 0.99)]),
        mean_us: Math.round(times.reduce((a, b) => a + b, 0) / n),
      });
    }
    if (u.pathname === "/rtt") {
      const n = Number(u.searchParams.get("n") || 2000);
      const s = connect({ hostname: "127.0.0.1", port });
      const w = s.writable.getWriter(),
        r = s.readable.getReader();
      const msg = new TextEncoder().encode("ping");
      await w.write(msg);
      await r.read();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        await w.write(msg);
        await r.read();
      }
      const us = ((performance.now() - t0) * 1000) / n;
      await s.close();
      return Response.json({ n, us_per_roundtrip: Math.round(us) });
    }
    if (u.pathname === "/hold") {
      const k = Number(u.searchParams.get("k"));
      for (let i = 0; i < k; i++) {
        const s = connect({ hostname: "127.0.0.1", port });
        await s.opened;
        held.push(s);
      }
      return Response.json({ held: held.length });
    }
    if (u.pathname === "/release") {
      for (const s of held) await s.close();
      held.length = 0;
      return Response.json({ held: 0 });
    }
    return new Response("bench");
  },
};
