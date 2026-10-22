import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { createBroker, listen } from "../../wire/src/broker";
import { EMPTY_BINDINGS, preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// fetch(Request), fetch(Request, init) and new Request(request, init) on a compiled sprout,
// through the broker transport, against what workerd does (the platform's
// tests/service-bindings suite holds workerd's answers). The same handler is compiled at
// compatibility date 2026-10-23, where Request follows Fetch as workerd does, and at
// 2026-10-22, where an app keeps the older behaviour: a copied Request shares its body,
// headers stay mutable and any method name passes.
const handler = `
const textStream = (...parts) =>
  new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(new TextEncoder().encode(p));
      c.close();
    },
  });
const attempt = async (step) => {
  try {
    return await step();
  } catch (e) {
    return e.name + ": " + e.message;
  }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const up = url.searchParams.get("up");
    const echo = async (res) => res.json();
    if (url.pathname === "/ping") return new Response("pong");
    if (url.pathname === "/fetch") {
      const viaRequest = await echo(await fetch(new Request(up + "/echo", { method: "PUT", headers: { "x-from": "request" }, body: "req body" })));
      const plusInit = await echo(
        await fetch(new Request(up + "/echo", { method: "PUT", headers: { "x-from": "request" }, body: "req body" }), { method: "PATCH", headers: { "x-from": "init" } }),
      );
      const initBody = await echo(await fetch(new Request(up + "/echo", { method: "PUT", body: "req body" }), { body: "init body" }));
      const stream = await echo(await fetch(new Request(up + "/echo", { method: "POST", body: textStream("in ", "a request"), duplex: "half" })));
      const initStream = await echo(await fetch(up + "/echo", { method: "POST", body: textStream("in ", "init"), duplex: "half" }));
      const initRequest = new Request("https://other/", { method: "POST", headers: { "x-from": "init-request" }, body: "init req" });
      const asInit = { ...(await echo(await fetch(up + "/echo", initRequest))), initUsed: initRequest.bodyUsed };
      const manual = (await fetch(new Request(up + "/redirect", { redirect: "manual" }))).status;
      const aborted = await attempt(() => fetch(new Request(up + "/echo", { signal: AbortSignal.abort() })).then((r) => r.status));
      const once = new Request(up + "/echo", { method: "POST", body: "once" });
      const first = (await echo(await fetch(once))).body;
      const usedUp = once.bodyUsed;
      const again = await attempt(() => fetch(once).then(echo).then((e) => e.body));
      const getBody = await attempt(() => fetch(up + "/echo", { body: "x" }).then((r) => r.status));
      return Response.json({ viaRequest, plusInit, initBody, stream, initStream, asInit, manual, aborted, first, usedUp, again, getBody });
    }
    if (url.pathname === "/forward") {
      // The incoming request's raw bytes reach the upstream intact.
      const copied = await echo(await fetch(new Request(up + "/echo", request)));
      return Response.json({ copied, incomingUsed: request.bodyUsed });
    }
    if (url.pathname === "/request") {
      const a = new Request("https://peer/a", { method: "POST", headers: { "x-a": "1" }, body: "abc" });
      const b = new Request(a, { headers: { "x-b": "2" } });
      const copy = { aUsed: a.bodyUsed, aRead: await attempt(() => a.text()), b: await b.text(), headers: [...b.headers] };
      const s = new Request("https://peer/s", { method: "POST", body: textStream("tee ", "me"), duplex: "half" });
      const t = s.clone();
      const tee = [await t.text(), await s.text()];
      const controller = new AbortController();
      const signalled = new Request(new Request("https://peer/", { signal: controller.signal }));
      controller.abort();
      const res = await fetch(url.searchParams.get("up") + "/echo");
      await res.text();
      return Response.json({
        copy,
        tee,
        signal: [signalled.signal.aborted, new Request("https://peer/").signal.aborted],
        getBody: await attempt(() => new Request("https://peer/", { body: "" }).method),
        method: await attempt(() => new Request("https://peer/", { method: "custom" }).method),
        redirect: await attempt(() => new Request("https://peer/", { redirect: "error" }).redirect),
        incoming: await attempt(() => (request.headers.set("x-t", "1"), "mutable")),
        fetched: await attempt(() => (res.headers.set("x-t", "1"), "mutable")),
        copiedResponse: await attempt(() => (new Response(null, res).headers.set("x-t", "1"), "mutable")),
        incomingBody: request.body === null ? "none" : typeof request.body,
      });
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

const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: "/echo?hop=1" } });
    const bytes = new Uint8Array(await request.arrayBuffer());
    let binaryIntact = bytes.length === 256;
    for (let i = 0; binaryIntact && i < 256; i++) binaryIntact = bytes[i] === i;
    return Response.json({
      method: request.method,
      from: request.headers.get("x-from"),
      type: request.headers.get("content-type"),
      body: binaryIntact ? "bytes 0-255" : new TextDecoder().decode(bytes),
    });
  },
});
const up = `http://127.0.0.1:${upstream.port}`;
const workdir = await mkdtemp(join(tmpdir(), "sb-native-fetch-request-"));
const broker = createBroker({
  db: ":memory:",
  token: "native-fetch-request",
  bindings: { ...EMPTY_BINDINGS, resources: {} },
  egressAllow: ["127.0.0.1"],
});
const brokerServer = listen(broker, "127.0.0.1", 0);
const servers: ReturnType<typeof Bun.spawn>[] = [];

// Compiles the handler at `date` and starts it; resolves to a GET helper for it.
async function start(porffor: string, node: string, source: string, date: string) {
  const port = freePort();
  const generated = join(workdir, `fetch-request-${date}.generated.js`);
  const binary = join(workdir, `fetch-request-${date}`);
  await writeFile(generated, wrapNativeFetchHandler(handler, source, {}, EMPTY_BINDINGS, undefined, date));
  const compile = Bun.spawn(
    [node, resolve(porffor, "runtime/index.js"), "native", generated, "-o", binary, "-s", "-O0"],
    {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stderr] = await Promise.all([compile.exited, new Response(compile.stderr).text()]);
  assert.equal(exitCode, 0, `Porffor native compile at ${date} failed:\n${stderr}`);
  const server = Bun.spawn([binary], {
    cwd: workdir,
    env: {
      ...process.env,
      PORT: String(port),
      SB_BROKER_PORT: String(brokerServer.port),
      SB_BROKER_TOKEN: "native-fetch-request",
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  servers.push(server);
  const call = async (path: string, init?: RequestInit) => {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`http://127.0.0.1:${port}${path}${sep}up=${encodeURIComponent(up)}`, {
      ...init,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    assert.equal(res.status, 200, `${date} ${path}: ${text}`);
    return JSON.parse(text);
  };
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ping`);
      if ((await res.text()) === "pong") return call;
    } catch {
      if (server.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  throw new Error(`compiled handler at ${date} did not start`);
}

try {
  const porffor = await ensurePorffor({ cacheRoot: workdir });
  const node = Bun.which("node");
  if (!node) throw new Error("native fetch-request test needs node on PATH");
  const [core, transport] = await Promise.all([
    readFile(preludePath, "utf8"),
    readFile(transportPath("broker"), "utf8"),
  ]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const source = core.replace(TRANSPORT_MARKER, transport);
  const [strict, legacy] = await Promise.all([
    start(porffor, node, source, "2026-10-23"),
    start(porffor, node, source, "2026-10-22"),
  ]);

  const echo = (method: string, from: string | null, type: string | null, body: string) => ({
    method,
    from,
    type,
    body,
  });
  const plain = "text/plain;charset=UTF-8";
  const bytes = new Uint8Array(256).map((_, i) => i);

  // From 2026-10-23: fetch() is fetch(new Request(input, init)), as in workerd.
  assert.deepEqual(await strict("/fetch"), {
    viaRequest: echo("PUT", "request", plain, "req body"),
    plusInit: echo("PATCH", "init", null, "req body"),
    initBody: echo("PUT", null, plain, "init body"),
    stream: echo("POST", null, null, "in a request"),
    initStream: echo("POST", null, null, "in init"),
    asInit: { ...echo("POST", "init-request", plain, "init req"), initUsed: true },
    manual: 302,
    aborted: "AbortError: The operation was aborted",
    first: "once",
    usedUp: true,
    again: "TypeError: Cannot reconstruct a Request with a used body.",
    getBody: "TypeError: Request with a GET or HEAD method cannot have a body.",
  });
  assert.deepEqual(await strict("/forward", { method: "POST", body: bytes, headers: { "x-from": "client" } }), {
    copied: echo("POST", "client", null, "bytes 0-255"),
    incomingUsed: true,
  });
  assert.deepEqual(await strict("/request"), {
    copy: {
      aUsed: true,
      aRead:
        "TypeError: Body has already been used. It can only be used once. Use tee() first if you need to read it twice.",
      b: "abc",
      headers: [["x-b", "2"]],
    },
    tee: ["tee me", "tee me"],
    signal: [true, false],
    getBody: "TypeError: Request with a GET or HEAD method cannot have a body.",
    method: "TypeError: Invalid HTTP method string: custom",
    redirect:
      'TypeError: Invalid redirect value, must be one of "follow" or "manual" ("error" won\'t be implemented since it does not make sense at the edge; use "manual" and check the response status code).',
    incoming: "TypeError: Can't modify immutable headers.",
    fetched: "TypeError: Can't modify immutable headers.",
    copiedResponse: "mutable",
    incomingBody: "none",
  });

  // Before it: the Request's method, headers and body still reach the upstream (fixed at
  // every date, as are stream bodies and raw bytes), but a Request can be sent twice, a
  // copy leaves the source readable, and headers, methods and redirect modes are not checked.
  const old = await legacy("/fetch");
  assert.deepEqual(
    {
      viaRequest: old.viaRequest,
      plusInit: old.plusInit,
      stream: old.stream,
      initStream: old.initStream,
      manual: old.manual,
      again: old.again,
    },
    {
      viaRequest: echo("PUT", "request", plain, "req body"),
      plusInit: echo("PATCH", "init", null, "req body"),
      stream: echo("POST", null, null, "in a request"),
      initStream: echo("POST", null, null, "in init"),
      manual: 302,
      again: "once",
    },
  );
  assert.deepEqual(await legacy("/forward", { method: "POST", body: bytes, headers: { "x-from": "client" } }), {
    copied: echo("POST", "client", null, "bytes 0-255"),
    incomingUsed: false,
  });
  const oldRequest = await legacy("/request");
  assert.deepEqual(
    {
      aUsed: oldRequest.copy.aUsed,
      aRead: oldRequest.copy.aRead,
      tee: oldRequest.tee,
      signal: oldRequest.signal,
      method: oldRequest.method,
      redirect: oldRequest.redirect,
      incoming: oldRequest.incoming,
      fetched: oldRequest.fetched,
      incomingBody: oldRequest.incomingBody,
    },
    {
      aUsed: false,
      aRead: "abc",
      tee: ["tee me", "tee me"],
      signal: [true, false],
      method: "CUSTOM",
      redirect: "error",
      incoming: "mutable",
      fetched: "mutable",
      incomingBody: "object",
    },
  );

  console.log(
    "fetch(Request) and new Request(request, init) follow workerd from 2026-10-23 (body used up, init merging, " +
      "GET/HEAD bodies, methods, redirect modes, signals, immutable headers); stream bodies, clone() tees and raw bytes at every date; " +
      "2026-10-22 keeps the older Request semantics",
  );
} finally {
  for (const server of servers) {
    server.kill(9);
    await server.exited;
  }
  brokerServer.stop();
  broker.close();
  upstream.stop(true);
  await rm(workdir, { recursive: true, force: true });
}
