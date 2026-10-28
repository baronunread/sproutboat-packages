// The app under test in native-concurrent-requests.ts: every route keeps its own request's
// values in locals, awaits on timers, fetch(), body streams, KV, D1 and WebSockets, and
// reports what it saw before and after each await. A reply that holds another request's id
// is a leak between interleaved requests. Written to the subset every host compiles.
const seenCf = [];
const seenHeaders = [];
const seenCtx = [];
const wakeups = {};
let active = 0;
let maxActive = 0;
let dbReady = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function handle(request, env, ctx) {
  {
    const url = new URL(request.url);
    const path = url.pathname;
    const rid = request.headers.get("x-rid") || url.searchParams.get("id") || "";
    const delays = (url.searchParams.get("d") || "3,3,3").split(",").map(Number);
    const snap = () => ({
      rid: request.headers.get("x-rid"),
      cookie: request.headers.get("cookie"),
      url: request.url,
      method: request.method,
      env: env.GREETING,
      ctx: ctx === myCtx,
      cf: request.cf === myCf,
      headers: request.headers === myHeaders,
    });
    const myCtx = ctx;
    const myCf = request.cf;
    const myHeaders = request.headers;
    seenCf.push(myCf);
    seenHeaders.push(myHeaders);
    seenCtx.push(ctx);

    if (path === "/report") {
      return Response.json({
        n: seenCf.length,
        maxActive,
        cfShared: new Set(seenCf).size !== seenCf.length,
        headersShared: new Set(seenHeaders).size !== seenHeaders.length,
        ctxShared: new Set(seenCtx).size !== seenCtx.length,
      });
    }
    if (path === "/wu") return Response.json(wakeups[rid] || null);

    if (path === "/mix") {
      // Locals that must survive every await and every collection in between.
      const mine = { id: rid, list: [], text: "t-" + rid };
      for (let i = 0; i < 20; i++) mine.list.push(rid + ":" + i);
      const out = { rid, steps: [snap()] };
      const extra = new Headers(request.headers);
      extra.set("x-mine", rid);
      ctx.waitUntil(
        (async () => {
          await sleep(5 + delays[0]);
          wakeups[rid] = { rid, again: request.headers.get("x-rid"), mine: mine.id, ctx: ctx === myCtx };
        })(),
      );
      for (let i = 0; i < delays.length; i++) {
        await sleep(delays[i]);
        if (url.searchParams.get("alloc")) {
          // Garbage between awaits: forces collections while other requests are suspended.
          let junk = [];
          for (let k = 0; k < 40; k++) junk.push("j".repeat(2000 + k) + k);
          junk = null;
        }
        out.steps.push(snap());
      }
      const upstream = url.searchParams.get("up");
      if (upstream) {
        const r = await fetch(upstream + "/echo?id=" + rid + "&ms=" + delays[0], { headers: { "x-rid": rid } });
        out.upstream = await r.json();
        out.steps.push(snap());
      }
      out.mine = { id: mine.id, text: mine.text, list: mine.list.join(",") };
      out.extra = extra.get("x-mine");
      out.xrid = extra.get("x-rid");
      return Response.json(out, { headers: { "x-rid": rid, "x-echo": rid } });
    }

    if (path === "/promise") {
      // A promise returned from an async function and adopted by another, with timers between.
      const inner = async () => {
        await sleep(delays[0]);
        return { rid, from: "inner", seen: request.headers.get("x-rid") };
      };
      const outer = async () => {
        const v = await inner();
        await sleep(delays[1] || 1);
        return v;
      };
      const all = await Promise.all([outer(), outer(), inner()]);
      const raced = await Promise.race([sleep(50).then(() => "slow"), sleep(delays[0]).then(() => rid)]);
      const settled = await Promise.allSettled([Promise.reject(new Error("e-" + rid)), Promise.resolve(rid)]);
      return Response.json({
        rid,
        all: all.map((x) => x.seen),
        raced,
        settled: [settled[0].reason.message, settled[1].value],
        again: request.headers.get("x-rid"),
      });
    }

    if (path === "/boom") {
      await sleep(delays[0]);
      throw new Error("boom-" + rid);
    }
    if (path === "/catch") {
      try {
        await sleep(delays[0]);
        throw new Error("caught-" + rid);
      } catch (error) {
        await sleep(delays[1] || 1);
        return Response.json({ rid, message: error.message, again: request.headers.get("x-rid") });
      }
    }
    if (path === "/reject") {
      // Nothing waits on this rejection: the request and its neighbours go on.
      Promise.reject(new Error("unhandled-" + rid));
      await sleep(delays[0]);
      return Response.json({ rid, ok: true, again: request.headers.get("x-rid") });
    }

    if (path === "/body") {
      // The body is read in pieces with a timer between each, other requests interleaving.
      const reader = request.body.getReader();
      let bytes = 0;
      let sum = 0;
      let pieces = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pieces++;
        bytes += value.length;
        for (let i = 0; i < value.length; i++) sum = (sum + value[i]) % 1000003;
        await sleep(1);
      }
      return Response.json({ rid, bytes, sum, pieces, again: request.headers.get("x-rid") });
    }
    if (path === "/text") {
      const text = await request.text();
      await sleep(delays[0]);
      let sum = 0;
      for (let i = 0; i < text.length; i++) sum = (sum + text.charCodeAt(i)) % 1000003;
      return Response.json({ rid, bytes: text.length, sum, again: request.headers.get("x-rid") });
    }

    if (path === "/stream") {
      let i = 0;
      const n = 8;
      const stream = new ReadableStream({
        async pull(controller) {
          await sleep(delays[0]);
          if (i === n) {
            controller.close();
            return;
          }
          controller.enqueue(new TextEncoder().encode(rid + ":" + i + ":" + request.headers.get("x-rid") + "\n"));
          i++;
        },
      });
      return new Response(stream, { headers: { "content-type": "text/plain", "x-rid": rid } });
    }

    if (path === "/store") {
      if (!dbReady) {
        dbReady = true;
        await env.DB.exec("CREATE TABLE IF NOT EXISTS t (rid TEXT, v TEXT)");
      }
      await env.KV.put("k-" + rid, rid);
      await sleep(delays[0]);
      const kv = await env.KV.get("k-" + rid);
      await env.DB.prepare("INSERT INTO t (rid, v) VALUES (?, ?)")
        .bind(rid, "v-" + rid)
        .run();
      await sleep(delays[1] || 1);
      const row = await env.DB.prepare("SELECT v FROM t WHERE rid = ?").bind(rid).first();
      return Response.json({ rid, kv, row: row && row.v, again: request.headers.get("x-rid") });
    }

    if (path === "/pair") {
      // A WebSocketPair that stays in the worker: messages with timers between them.
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      client.accept();
      const log = [];
      server.addEventListener("message", (e) => {
        log.push("s:" + e.data);
        server.send("echo:" + e.data + ":" + request.headers.get("x-rid"));
      });
      client.addEventListener("message", (e) => log.push("c:" + e.data));
      for (let i = 0; i < 4; i++) {
        client.send(rid + ":" + i);
        await sleep(delays[0]);
      }
      await sleep(5);
      client.close(1000, rid);
      return Response.json({ rid, log });
    }

    if (path === "/ws") {
      // A client socket (hosts that carry them): each message is answered after a timer.
      if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      server.addEventListener("message", async (e) => {
        await sleep(delays[0]);
        server.send(rid + "|" + e.data + "|" + request.headers.get("x-rid"));
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("ok " + rid);
  }
}

export default {
  async fetch(request, env, ctx) {
    active++;
    if (active > maxActive) maxActive = active;
    try {
      return await handle(request, env, ctx);
    } finally {
      active--;
    }
  },
};
