import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// WebSockets from compatibility date 2026-10-30: a WebSocketPair whose ends both stay in
// the worker is plain JavaScript and works on every host; a 101 response needs a host that
// carries client sockets (sproutd), so a standalone sprout answers it with a 501. Before the
// date nothing is defined. The answers below are workerd's (1.20260730.1) for the same code.
const handler = `const closes = [];
export default {async fetch(request) {
  const path = new URL(request.url).pathname;
  const tick = () => new Promise((r) => setTimeout(r, 10));
  if (path === "/shape") return Response.json([typeof WebSocketPair, typeof WebSocket, typeof WebSocketRequestResponsePair, new Response("x").webSocket]);
  if (path === "/pair") {
    const [client, server] = Object.values(new WebSocketPair());
    const log = [];
    server.accept();
    client.accept();
    server.binaryType = "arraybuffer";
    client.binaryType = "arraybuffer";
    server.addEventListener("message", (e) => {
      log.push("s:" + (typeof e.data === "string" ? e.data : "bytes " + new Uint8Array(e.data).join(",")));
      server.send(typeof e.data === "string" ? "echo:" + e.data : e.data);
    });
    client.addEventListener("message", (e) => log.push("c:" + (typeof e.data === "string" ? e.data : "bytes " + new Uint8Array(e.data).join(","))));
    client.addEventListener("close", (e) => log.push("client close " + e.code + " " + e.reason + " " + e.wasClean));
    server.addEventListener("close", (e) => log.push("server close " + e.code + " " + e.reason + " " + e.wasClean));
    client.send("hi");
    client.send(new Uint8Array([1, 2, 3]));
    await tick();
    let badCode = "";
    try { server.close(999); } catch (e) { badCode = e.name; }
    client.close(4001, "bye");
    await tick();
    let after = "";
    try { client.send("x"); } catch (e) { after = e.message; }
    return Response.json({ log, badCode, after, states: [client.readyState, server.readyState] });
  }
  if (path === "/blob") {
    // Binary messages are Blobs unless binaryType says otherwise.
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    client.accept();
    const got = [server.binaryType];
    server.addEventListener("message", async (e) => got.push(e.data instanceof Blob, Array.from(new Uint8Array(await e.data.arrayBuffer()))));
    client.send(new Uint8Array([7, 8]));
    await tick();
    let reason = "";
    try { server.close(1000, "x".repeat(124)); } catch (e) { reason = e.name; }
    return Response.json([...got, reason]);
  }
  if (path === "/queued") {
    // Messages sent before the other end accepts wait for it.
    const pair = new WebSocketPair();
    const server = pair[1];
    const client = pair[0];
    client.accept();
    client.send("early");
    await tick();
    const got = [];
    server.addEventListener("message", (e) => got.push(e.data));
    server.accept();
    await tick();
    return Response.json(got);
  }
  if (path === "/unaccepted") {
    const pair = new WebSocketPair();
    try { pair[0].send("x"); return new Response("sent"); } catch (e) { return new Response(e.name + ": " + e.message); }
  }
  if (path === "/echo" || path === "/hello" || path === "/proto" || path === "/serverclose") {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    if (path === "/hello") server.send("hello");
    if (path === "/serverclose") server.close(4002, "server says bye");
    if (path === "/echo") {
      server.binaryType = "arraybuffer";
      server.addEventListener("message", (e) => server.send(typeof e.data === "string" ? "echo:" + e.data : e.data));
      server.addEventListener("close", (e) => closes.push([e.code, e.reason, e.wasClean]));
    }
    return new Response(null, { status: 101, webSocket: client, headers: path === "/proto" ? { "Sec-WebSocket-Protocol": "chat" } : {} });
  }
  if (path === "/closes") return Response.json(closes);
  if (path === "/upgrade") {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    return new Response(null, { status: 101, webSocket: client });
  }
  if (path === "/bad101") {
    try { new Response(null, { status: 101 }); return new Response("made"); } catch (e) { return new Response(e.name); }
  }
  return new Response("no route " + path, { status: 404 });
}};`;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-websockets-"));
const servers: ReturnType<typeof Bun.spawn>[] = [];
try {
  const porffor = await ensurePorffor();
  const node = Bun.which("node");
  if (!node) throw new Error("native WebSocket test needs node on PATH");
  const [core, broker] = await Promise.all([readFile(preludePath, "utf8"), readFile(transportPath("broker"), "utf8")]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const start = async (date: string) => {
    const generated = join(workdir, `ws-${date}.generated.js`);
    const binary = join(workdir, `ws-${date}`);
    await writeFile(
      generated,
      wrapNativeFetchHandler(handler, core.replace(TRANSPORT_MARKER, broker), {}, undefined, undefined, date),
    );
    const compile = Bun.spawn(
      [node, resolve(porffor, "runtime/index.js"), "native", generated, "-o", binary, "-s", "-O0"],
      {
        cwd: workdir,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      compile.exited,
      new Response(compile.stdout).text(),
      new Response(compile.stderr).text(),
    ]);
    assert.equal(exitCode, 0, `Porffor native compile failed:\n${stderr}\n${stdout}`);
    const port = freePort();
    const server = Bun.spawn([binary], {
      cwd: workdir,
      env: { ...process.env, PORT: String(port) },
      stdout: "ignore",
      stderr: "inherit",
    });
    servers.push(server);
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await fetch(`${base}/bad101`, { signal: AbortSignal.timeout(500) });
        return base;
      } catch {
        if (server.exitCode !== null) break;
        await Bun.sleep(100);
      }
    }
    throw new Error("compiled handler did not start");
  };
  const [now, before, hosted] = await Promise.all([start("2026-10-30"), start("2026-10-29"), start("2026-11-01")]);

  assert.deepEqual(await (await fetch(`${now}/shape`)).json(), ["function", "function", "function", null]);
  assert.deepEqual(await (await fetch(`${before}/shape`)).json(), ["undefined", "undefined", "undefined", null]);
  console.log("WebSocketPair, WebSocket and WebSocketRequestResponsePair exist from 2026-10-30 only");

  assert.deepEqual(await (await fetch(`${now}/pair`)).json(), {
    log: [
      "s:hi",
      "c:echo:hi",
      "s:bytes 1,2,3",
      "c:bytes 1,2,3",
      "server close 4001 bye true",
      "client close 4001 bye true",
    ],
    badCode: "InvalidAccessError",
    after: "Can't call WebSocket send() after close().",
    states: [3, 3],
  });
  assert.deepEqual(await (await fetch(`${now}/queued`)).json(), ["early"]);
  assert.deepEqual(await (await fetch(`${now}/blob`)).json(), ["blob", true, [7, 8], "SyntaxError"]);
  assert.equal(
    await (await fetch(`${now}/unaccepted`)).text(),
    "TypeError: You must call one of accept() or state.acceptWebSocket() on this WebSocket before sending messages.",
  );
  console.log("a pair passes text, bytes and close codes, and queues messages until accept()");

  const upgrade = await fetch(`${now}/upgrade`);
  assert.equal(upgrade.status, 501);
  assert.equal(await upgrade.text(), "WebSockets are not supported by this host yet");
  assert.equal(await (await fetch(`${now}/bad101`)).text(), "RangeError");
  assert.equal(await (await fetch(`${before}/bad101`)).text(), "RangeError");
  console.log("a standalone sprout answers a 101 response with 501 before 2026-11-01; status 101 needs a WebSocket");

  // From 2026-11-01 the server carries the client end: a real WebSocket.
  const wsBase = hosted.replace("http:", "ws:");
  const open = (url: string, protocols?: string | string[]) =>
    new Promise<WebSocket>((ok, fail) => {
      const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
      ws.binaryType = "arraybuffer";
      ws.addEventListener("open", () => ok(ws), { once: true });
      ws.addEventListener("error", () => fail(new Error("WebSocket error for " + url)), { once: true });
    });
  const nextMessage = (ws: WebSocket) =>
    new Promise<MessageEvent["data"]>((ok, fail) => {
      const t = setTimeout(() => fail(new Error("timed out waiting for a message")), 5000);
      ws.addEventListener(
        "message",
        (e) => {
          clearTimeout(t);
          ok(e.data);
        },
        { once: true },
      );
    });
  const closedWith = (ws: WebSocket) =>
    new Promise<[number, string]>((ok) => ws.addEventListener("close", (e) => ok([e.code, e.reason]), { once: true }));

  const echo = await open(`${wsBase}/echo`);
  echo.send("hi");
  assert.equal(await nextMessage(echo), "echo:hi");
  echo.send(new Uint8Array([0, 1, 2, 255]));
  assert.deepEqual(Array.from(new Uint8Array(await nextMessage(echo))), [0, 1, 2, 255]);
  for (let i = 0; i < 200; i++) echo.send(String(i));
  const many: string[] = [];
  await new Promise<void>((done) =>
    echo.addEventListener("message", (e) => {
      many.push(String(e.data));
      if (many.length === 200) done();
    }),
  );
  assert.deepEqual(
    many,
    Array.from({ length: 200 }, (_, i) => "echo:" + i),
  );
  const big = "x".repeat(3 * 1024 * 1024);
  echo.send(big);
  const bigEcho = await nextMessage(echo);
  assert.equal(bigEcho.length, big.length + 5);
  const gone = closedWith(echo);
  echo.close(4001, "bye");
  assert.deepEqual(await gone, [4001, "bye"]);
  await Bun.sleep(100);
  assert.deepEqual(await (await fetch(`${hosted}/closes`)).json(), [[4001, "bye", true]]);
  console.log("a client socket echoes text, bytes, 200 queued messages and a 3 MiB message, and closes with its code");

  const hello = await open(`${wsBase}/hello`);
  assert.equal(await nextMessage(hello), "hello");
  hello.close();
  const proto = await open(`${wsBase}/proto`, ["other", "chat"]);
  assert.equal(proto.protocol, "chat");
  proto.close();
  const bye = await open(`${wsBase}/serverclose`);
  assert.deepEqual(await closedWith(bye), [4002, "server says bye"]);
  console.log("a message sent before the 101 arrives first, the app picks the protocol, and the app can close");

  assert.equal((await fetch(`${hosted}/echo`)).status, 426);
  const plain = await fetch(`${hosted}/upgrade`);
  assert.equal(plain.status, 500);
  assert.equal(await plain.text(), "WebSocket response to a request that is not an upgrade");
  console.log("a plain request is not upgraded, and a 101 to one is a 500");
} finally {
  for (const server of servers) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
