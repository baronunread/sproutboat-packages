import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { createBroker, listen } from "../../wire/src/broker";
import { EMPTY_BINDINGS, preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// Service bindings on a standalone sprout. env.PEER.fetch() returns a promise and runs
// off the event loop (the broker transport's async threads), so the sprout keeps
// serving while a call is in flight: other requests answer at once, concurrent calls
// overlap, and a deployment that calls itself through a binding does not deadlock.
// Requests read like Fetch's: a URL object, a Request plus init, a stream body; every
// Set-Cookie of the reply survives, and a reply without a content type keeps none.
// From compatibility date 2026-10-22, redirects are followed as Fetch does. A stand-in
// edge plays the platform's.
const handler = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ping") return new Response("pong");
    if (url.pathname === "/requests") {
      const pending = env.PEER.fetch(new URL("https://peer/echo?u=1"));
      const isPromise = pending instanceof Promise;
      const viaUrl = await (await pending).json();
      const viaRequest = await (await env.PEER.fetch(new Request("https://peer/echo", { method: "PUT", headers: { "x-from": "request" }, body: "req body" }), { method: "PATCH" })).json();
      const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("streamed ")); c.enqueue(new TextEncoder().encode("body")); c.close(); } });
      const viaStream = await (await env.PEER.fetch("https://peer/echo", { method: "POST", body: stream, duplex: "half" })).json();
      const cookies = (await env.PEER.fetch("https://peer/cookies")).headers.getSetCookie();
      const bare = (await env.PEER.fetch("https://peer/bare")).headers.get("content-type");
      return Response.json({ isPromise, viaUrl, viaRequest, viaStream, cookies, bare });
    }
    if (url.pathname === "/redirects") {
      const followed = await (await env.PEER.fetch("https://peer/redirect?status=302&to=/echo?hop=1")).json();
      const manual = await env.PEER.fetch("https://peer/redirect?status=302&to=/echo", { redirect: "manual" });
      const post = (status, body) => env.PEER.fetch("https://peer/redirect?status=" + status + "&to=/typed", { method: "POST", body, headers: { "content-type": "text/plain" } });
      const seeOther = await (await post(303, "dropped")).json();
      const temporary = await (await post(307, "kept")).json();
      let refused = "";
      try {
        await env.PEER.fetch("https://peer/redirect?status=302&to=/echo", { redirect: "error" });
      } catch (e) {
        refused = e.name;
      }
      return Response.json({ followed, manual: [manual.status, manual.headers.get("location")], seeOther, temporary, refused });
    }
    if (url.pathname === "/slow") return new Response(await (await env.PEER.fetch("https://peer/slow" + url.search)).text());
    if (url.pathname === "/abort") {
      const outcome = async (signal) => {
        const t0 = Date.now();
        try {
          await env.PEER.fetch("https://peer/slow?ms=3000", { signal });
          return "answered";
        } catch (e) {
          return e.name + " " + (Date.now() - t0 < 1000 ? "fast" : "slow");
        }
      };
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      const aborted = await outcome(controller.signal);
      const timedOut = await outcome(AbortSignal.timeout(100));
      const already = await outcome(AbortSignal.abort());
      return Response.json({ aborted, timedOut, already });
    }
    if (url.pathname === "/self") {
      const depth = Number(url.searchParams.get("depth") || 0);
      if (depth >= 30) return new Response("bottom " + depth);
      return new Response(await (await env.SELF.fetch("https://self/self?depth=" + (depth + 1))).text());
    }
    if (url.pathname === "/whoami") {
      return Response.json({ url: request.url, internal: [...request.headers.keys()].filter((k) => k.startsWith("x-sb-")) });
    }
    if (url.pathname === "/boom") throw new RangeError("kaboom");
    if (url.pathname === "/callself") {
      const who = await (await env.SELF.fetch("https://self.example/whoami?q=1")).json();
      let thrown = null;
      try {
        await env.SELF.fetch("https://self.example/boom");
      } catch (e) {
        thrown = [e.name, e.message, e instanceof RangeError];
      }
      return Response.json({ who, thrown });
    }
    return new Response("no route", { status: 404 });
  },
};
`;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const port = freePort();
const EDGE_SECRET = "native-services-edge-secret";
const EDGE_TOKEN = "native-services-edge-token";
// Upstream requests whose client went away before the answer: a cancelled call must
// stop here, not only be ignored by the caller.
let slowAbandoned = 0;
// The platform's edge, reduced to what the broker forwards to it: routing by Host.
const edge = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const host = request.headers.get("host");
    if (host === "self.test") {
      // Vouch for the call as the platform's edge does: the broker's secret in, the
      // sprout's own token out, and the caller's URL passed along.
      const headers = new Headers(request.headers);
      for (const name of ["x-sb-edge-secret", "x-sb-edge-token", "x-sb-binding-call", "x-sb-url"]) headers.delete(name);
      if (request.headers.get("x-sb-edge-secret") === EDGE_SECRET) {
        headers.set("x-sb-binding-call", "1");
        headers.set("x-sb-edge-token", EDGE_TOKEN);
        const callerUrl = request.headers.get("x-sb-url");
        if (callerUrl) headers.set("x-sb-url", callerUrl);
      }
      return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { method: request.method, headers });
    }
    if (url.pathname === "/echo") {
      return Response.json({
        method: request.method,
        path: url.pathname + url.search,
        from: request.headers.get("x-from"),
        body: await request.text(),
      });
    }
    if (url.pathname === "/typed") {
      return Response.json({ method: request.method, type: request.headers.get("content-type"), body: await request.text() });
    }
    if (url.pathname === "/redirect") {
      const status = Number(url.searchParams.get("status"));
      return new Response(null, { status, headers: { location: url.searchParams.get("to") ?? "/" } });
    }
    if (url.pathname === "/bare") return new Response(null, { headers: { "x-bare": "1" } });
    if (url.pathname === "/slow") {
      request.signal.addEventListener("abort", () => slowAbandoned++);
      await Bun.sleep(Number(url.searchParams.get("ms") || 500));
      return new Response("slow done");
    }
    if (url.pathname === "/cookies") {
      const headers = new Headers();
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/");
      return new Response("cookies", { headers });
    }
    return new Response("edge: no route", { status: 404 });
  },
});

const workdir = await mkdtemp(join(tmpdir(), "sb-native-services-"));
const services = [
  { binding: "PEER", service: "peer" },
  { binding: "SELF", service: "self" },
];
const bindings = { ...EMPTY_BINDINGS, services };
const broker = createBroker({
  db: ":memory:",
  token: "native-services",
  bindings: { ...bindings, resources: {} },
  edgeUrl: `http://127.0.0.1:${edge.port}/`,
  edgeSecret: EDGE_SECRET,
  services: { PEER: "peer.test", SELF: "self.test" },
});
const brokerServer = listen(broker, "127.0.0.1", 0);
let server: ReturnType<typeof Bun.spawn> | undefined;
const get = async (path: string) => {
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(20_000) });
  return { status: res.status, text: await res.text(), ms: performance.now() - t0 };
};
try {
  const porffor = await ensurePorffor({ cacheRoot: workdir });
  const node = Bun.which("node");
  if (!node) throw new Error("native service-binding test needs node on PATH");
  const [core, transport] = await Promise.all([
    readFile(preludePath, "utf8"),
    readFile(transportPath("broker"), "utf8"),
  ]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const generated = join(workdir, "services.generated.js");
  const binary = join(workdir, "services-native");
  await writeFile(generated, wrapNativeFetchHandler(handler, core.replace(TRANSPORT_MARKER, transport), {}, bindings, undefined, "2026-10-22"));

  const compile = Bun.spawn([node, resolve(porffor, "runtime/index.js"), "native", generated, "-o", binary, "-s", "-O0"], {
    cwd: workdir,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    compile.exited,
    new Response(compile.stdout).text(),
    new Response(compile.stderr).text(),
  ]);
  assert.equal(exitCode, 0, `Porffor native compile failed:\n${stderr}\n${stdout}`);

  server = Bun.spawn([binary], {
    cwd: workdir,
    env: {
      ...process.env,
      PORT: String(port),
      SB_BROKER_PORT: String(brokerServer.port),
      SB_BROKER_TOKEN: "native-services",
      SB_EDGE_TOKEN: EDGE_TOKEN,
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  let started = false;
  for (let attempt = 0; attempt < 50 && !started; attempt++) {
    try {
      started = (await get("/ping")).text === "pong";
    } catch {
      if (server.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  assert(started, "compiled service-binding handler did not start");

  const requests = await get("/requests");
  assert.equal(requests.status, 200, requests.text);
  assert.deepEqual(JSON.parse(requests.text), {
    isPromise: true,
    viaUrl: { method: "GET", path: "/echo?u=1", from: null, body: "" },
    viaRequest: { method: "PATCH", path: "/echo", from: "request", body: "req body" },
    viaStream: { method: "POST", path: "/echo", from: null, body: "streamed body" },
    cookies: ["a=1; Path=/", "b=2; Path=/"],
    bare: null,
  });

  // Redirects (compatibility date 2026-10-22): followed through the binding by default,
  // returned under "manual", refused under "error"; a 303 turns a POST into a bodiless GET.
  const redirects = await get("/redirects");
  assert.equal(redirects.status, 200, redirects.text);
  assert.deepEqual(JSON.parse(redirects.text), {
    followed: { method: "GET", path: "/echo?hop=1", from: null, body: "" },
    manual: [302, "/echo"],
    seeOther: { method: "GET", type: null, body: "" },
    temporary: { method: "POST", type: "text/plain", body: "kept" },
    refused: "TypeError",
  });

  // A call in flight does not hold up other requests.
  const slow = get("/slow?ms=1500");
  await Bun.sleep(200);
  const ping = await get("/ping");
  assert.equal(ping.text, "pong");
  assert(ping.ms < 500, `/ping took ${Math.round(ping.ms)} ms behind a 1.5 s call`);
  assert.equal((await slow).text, "slow done");

  // Calls overlap.
  const t0 = performance.now();
  const all = await Promise.all(Array.from({ length: 8 }, () => get("/slow?ms=500")));
  const total = performance.now() - t0;
  assert(all.every((r) => r.text === "slow done"), JSON.stringify(all));
  assert(total < 1500, `8 concurrent 500 ms calls took ${Math.round(total)} ms`);

  // Cancellation: an aborted signal rejects at once, and the abort reaches the upstream
  // request (the broker drops it when the sprout closes the exchange's connection).
  const abandonedBefore = slowAbandoned;
  const aborts = await get("/abort");
  assert.equal(aborts.status, 200, aborts.text);
  assert.deepEqual(JSON.parse(aborts.text), { aborted: "AbortError fast", timedOut: "TimeoutError fast", already: "AbortError fast" });
  await Bun.sleep(300);
  assert.equal(slowAbandoned - abandonedBefore, 2, "both in-flight calls were stopped upstream");

  // A call the edge vouched for sees the caller's URL and none of the edge's headers,
  // and the callee's error is thrown in the caller, class and message intact.
  const callself = await get("/callself");
  assert.equal(callself.status, 200, callself.text);
  assert.deepEqual(JSON.parse(callself.text), {
    who: { url: "https://self.example/whoami?q=1", internal: [] },
    thrown: ["RangeError", "kaboom", true],
  });
  // A client cannot claim to be a binding call: no caller URL, no error marker.
  const forged = { "x-sb-binding-call": "1", "x-sb-edge-token": "guess", "x-sb-url": "https://forged.example/" };
  const spoofed = await fetch(`http://127.0.0.1:${port}/whoami`, { headers: forged });
  assert.equal((await spoofed.json()).url, `http://127.0.0.1:${port}/whoami`);
  const publicBoom = await fetch(`http://127.0.0.1:${port}/boom`, { headers: forged });
  assert.equal(publicBoom.status, 500);
  assert.equal(publicBoom.headers.get("x-sb-uncaught"), null);

  // A deployment calling itself, 30 levels deep: every level waits on the next at once.
  const self = await get("/self");
  assert.equal(self.text, "bottom 30");
  console.log(
    `Service bindings return promises and run off the loop: /ping ${Math.round(ping.ms)} ms during a call, ` +
      `8x500 ms in ${Math.round(total)} ms, self-recursion ok; URL, Request+init, stream bodies, Set-Cookie and missing content types preserved; redirects follow Fetch; aborted calls stop upstream; vouched calls see the caller's URL and rethrow the callee's errors`,
  );
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  brokerServer.stop();
  broker.close();
  edge.stop(true);
  await rm(workdir, { recursive: true, force: true });
}
