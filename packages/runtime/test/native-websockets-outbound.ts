import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Outbound WebSockets, from compatibility date 2026-11-01: new WebSocket(url) and fetch() with
// Upgrade: websocket, on the embedded transport (standalone sprouts, sproutd). An upstream
// server in this process (Bun) answers them; the handler's answers are what workerd gives for
// the same code.
interface UpstreamData {
  readonly path: string;
}
const upstream = Bun.serve<UpstreamData>({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === "/refuse") return new Response("no sockets", { status: 426, headers: { "x-why": "test" } });
    const ok = server.upgrade(request, {
      data: { path },
      headers: path === "/proto" ? { "sec-websocket-protocol": "chat" } : undefined,
    });
    return ok ? undefined : new Response("expected websocket", { status: 426 });
  },
  websocket: {
    open(ws) {
      if (ws.data.path === "/hello") ws.send("hello from upstream");
      if (ws.data.path === "/bye") ws.close(4003, "upstream bye");
    },
    message(ws, message) {
      if (message === "close-me") ws.close(4004, "asked");
      else if (message instanceof Buffer) ws.send(message);
      else ws.send(`echo:${message}`);
    },
    maxPayloadLength: 64 * 1024 * 1024,
  },
});

const handler = `export default {async fetch(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const up = "ws://127.0.0.1:${upstream.port}";
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (cond, ms) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await tick(10); return cond(); };
  if (path === "/ctor") {
    const log = [];
    const ws = new WebSocket(up + "/proto", ["other", "chat"]);
    log.push("state " + ws.readyState + " " + ws.url.replace(/:\\d+/, ":PORT"));
    ws.addEventListener("open", () => { log.push("open " + ws.protocol + " " + ws.readyState); ws.send("hi"); ws.send(new Uint8Array([1, 2, 3])); });
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (e) => {
      log.push(typeof e.data === "string" ? "m:" + e.data : "b:" + Array.from(new Uint8Array(e.data)).join(","));
      if (log.filter((l) => l[0] === "m" || l[0] === "b").length === 2) ws.close(1000, "done");
    });
    ws.addEventListener("close", (e) => log.push("close " + e.code + " " + e.reason + " " + e.wasClean + " " + ws.readyState));
    await waitFor(() => log.some((l) => l.indexOf("close") === 0), 5000);
    return Response.json(log);
  }
  if (path === "/ctor-early") {
    // send() while CONNECTING throws; a greeting from the server arrives; the server's close reaches us.
    const log = [];
    const ws = new WebSocket(up + "/hello");
    try { ws.send("too early"); } catch (e) { log.push(e.name); }
    ws.addEventListener("message", (e) => { log.push(e.data); ws.send("close-me"); });
    ws.addEventListener("close", (e) => log.push("close " + e.code + " " + e.reason + " " + e.wasClean));
    await waitFor(() => log.some((l) => l.indexOf("close") === 0), 5000);
    return Response.json(log);
  }
  if (path === "/serverclose") {
    const log = [];
    const ws = new WebSocket(up + "/bye");
    ws.addEventListener("close", (e) => log.push("close " + e.code + " " + e.reason + " " + e.wasClean));
    await waitFor(() => log.length > 0, 5000);
    return Response.json(log);
  }
  if (path === "/big") {
    const ws = new WebSocket(up + "/echo");
    const big = "y".repeat(3 * 1024 * 1024);
    let got = 0;
    ws.addEventListener("open", () => ws.send(big));
    ws.addEventListener("message", (e) => { got = e.data.length; ws.close(1000); });
    await waitFor(() => got > 0, 10000);
    return Response.json({ got, sent: big.length });
  }
  if (path === "/fetch") {
    const res = await fetch("http://127.0.0.1:${upstream.port}/echo", { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket;
    const log = [res.status, ws !== null, res.headers.get("upgrade")];
    ws.accept();
    ws.addEventListener("message", (e) => log.push(e.data));
    ws.send("one");
    ws.send("two");
    await waitFor(() => log.length >= 5, 5000);
    ws.close(1000, "bye");
    await tick(100);
    log.push("state " + ws.readyState);
    return Response.json(log);
  }
  if (path === "/refused") {
    const res = await fetch("http://127.0.0.1:${upstream.port}/refuse", { headers: { Upgrade: "websocket" } });
    return Response.json([res.status, res.webSocket, res.headers.get("x-why"), await res.text()]);
  }
  if (path === "/proxy") {
    // The handler returns the upstream's upgrade response: the client's socket is relayed to it.
    return fetch("http://127.0.0.1:${upstream.port}/proto", request);
  }
  if (path === "/badurl") {
    const out = [];
    try { new WebSocket("ftp://example.com/"); } catch (e) { out.push(e.name); }
    try { new WebSocket("not a url"); } catch (e) { out.push(e.name); }
    try { new WebSocket("ws://example.com/#frag"); } catch (e) { out.push(e.name); }
    try { new WebSocket("ws://example.com/", ["a", "a"]); } catch (e) { out.push(e.name); }
    return Response.json(out);
  }
  if (path === "/unreachable") {
    const log = [];
    const ws = new WebSocket("ws://127.0.0.1:1/nothing");
    ws.addEventListener("error", () => log.push("error"));
    ws.addEventListener("close", (e) => log.push("close " + e.code + " " + e.wasClean));
    await waitFor(() => log.length >= 2, 8000);
    return Response.json(log);
  }
  return new Response("no route " + path, { status: 404 });
}};`;

const cli = process.env.SB_CLI;
if (!cli) {
  console.log("skipped: set SB_CLI to a sproutboat-cli checkout linked to this checkout (it builds the sprouts)");
  process.exit(0);
}

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = mkdtempSync(join(tmpdir(), "sb-native-websockets-out-"));
const servers: ReturnType<typeof Bun.spawn>[] = [];
// A standalone sprout built by the CLI (the embedded transport) at each compatibility date.
const start = async (date: string) => {
  const slug = `wsout-${date}`;
  const project = join(workdir, slug);
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src/index.js"), handler);
  writeFileSync(
    join(project, "sproutboat.jsonc"),
    JSON.stringify({ name: slug, main: "src/index.js", compatibility_date: date }),
  );
  const built = Bun.spawnSync(["bun", join(cli, "src/main.ts"), "build", "--standalone", "--target", "host"], {
    cwd: project,
    stdout: "inherit",
    stderr: "inherit",
  });
  assert.equal(built.exitCode, 0, "the CLI could not build the sprout");
  const port = freePort();
  const server = Bun.spawn([join(project, "dist", slug)], {
    cwd: project,
    env: { ...process.env, PORT: String(port), SB_EGRESS_ALLOW: "127.0.0.1", SB_DATA_DIR: join(project, "data") },
    stdout: "ignore",
    stderr: "inherit",
  });
  servers.push(server);
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(`${base}/badurl`, { signal: AbortSignal.timeout(500) });
      return base;
    } catch {
      if (server.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  throw new Error("compiled handler did not start");
};

try {
  const now = await start("2026-11-01");
  const get = async (path: string) => (await fetch(`${now}${path}`)).json();

  assert.deepEqual(await get("/badurl"), ["SyntaxError", "SyntaxError", "SyntaxError", "SyntaxError"]);
  assert.deepEqual(await get("/ctor"), [
    "state 0 ws://127.0.0.1:PORT/proto",
    "open chat 1",
    "m:echo:hi",
    "b:1,2,3",
    "close 1000 done true 3",
  ]);
  assert.deepEqual(await get("/ctor-early"), ["InvalidStateError", "hello from upstream", "close 4004 asked true"]);
  assert.deepEqual(await get("/serverclose"), ["close 4003 upstream bye true"]);
  assert.deepEqual(await get("/big"), { got: 3 * 1024 * 1024 + 5, sent: 3 * 1024 * 1024 });
  assert.deepEqual(await get("/fetch"), [101, true, "websocket", "echo:one", "echo:two", "state 3"]);
  assert.deepEqual(await get("/refused"), [426, null, "test", "no sockets"]);
  assert.deepEqual(await get("/unreachable"), ["error", "close 1006 false"]);
  console.log("new WebSocket(url) and fetch() upgrades connect, exchange text and bytes, and close with their codes");

  // The handler returns the upstream's upgrade response: a client of the sprout talks to the upstream.
  const ws = new WebSocket(`${now.replace("http:", "ws:")}/proxy`, "chat");
  ws.binaryType = "arraybuffer";
  const events: string[] = [];
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error("proxy timed out: " + events.join("|"))), 10000);
    ws.addEventListener("open", () => ws.send("via proxy"));
    ws.addEventListener("message", (e) => {
      events.push(String(e.data));
      ws.close(1000, "done");
    });
    ws.addEventListener("close", (e) => {
      events.push(`close ${e.code}`);
      clearTimeout(timer);
      done();
    });
  });
  assert.deepEqual(events, ["echo:via proxy", "close 1000"]);
  console.log("a handler that returns an upstream upgrade relays the client's socket to it");

  // Before the date the CLI refuses `new WebSocket(url)` at build time.
  const old = join(workdir, "old");
  mkdirSync(join(old, "src"), { recursive: true });
  writeFileSync(join(old, "src/index.js"), handler);
  writeFileSync(
    join(old, "sproutboat.jsonc"),
    JSON.stringify({ name: "wsold", main: "src/index.js", compatibility_date: "2026-10-30" }),
  );
  const refused = Bun.spawnSync(["bun", join(cli, "src/main.ts"), "check"], {
    cwd: old,
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.notEqual(refused.exitCode, 0);
  assert.match(
    refused.stdout.toString() + refused.stderr.toString(),
    /WebSocket\(\) needs compatibility_date 2026-11-01/,
  );
  console.log("before 2026-11-01 the build refuses new WebSocket(url)");
} finally {
  for (const server of servers) {
    server.kill(9);
    await server.exited;
  }
  upstream.stop(true);
  rmSync(workdir, { recursive: true, force: true });
}
