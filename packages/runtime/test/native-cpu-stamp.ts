import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// The x-sb-cpu-ms stamp is added to the handler's own Response (it used to build a second one),
// and request.cf's client IP skips the trusted-proxy work when no proxy is configured. What goes on
// the wire must not change: which responses are stamped, the headers and the body, the client IP.
const handler = `export default {fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/text") return new Response("hello");
  if (path === "/json") return new Response('{"a":1}', { status: 201, headers: { "content-type": "application/json", "x-a": "1" } });
  if (path === "/bytes") return new Response(new Uint8Array([1, 2, 3]));
  if (path === "/cookies") {
    const h = new Headers(); h.append("set-cookie", "a=1"); h.append("set-cookie", "b=2");
    return new Response("c", { headers: h });
  }
  if (path === "/own") return new Response("own", { headers: { "x-sb-cpu-ms": "mine" } });
  if (path === "/ip") return new Response(JSON.stringify({ ip: request.cf.clientIp, proto: request.cf.httpProtocol ?? null }));
  return new Response("not found", { status: 404 });
}};`;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-cpu-stamp-"));
const servers: ReturnType<typeof Bun.spawn>[] = [];
async function start(binary: string, env: Record<string, string>): Promise<number> {
  const port = freePort();
  const server = Bun.spawn([binary], {
    cwd: workdir,
    env: { ...process.env, ...env, PORT: String(port) },
    stdout: "ignore",
    stderr: "inherit",
  });
  servers.push(server);
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/text`, { signal: AbortSignal.timeout(500) });
      return port;
    } catch {
      if (server.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  throw new Error("compiled handler did not start");
}
try {
  const porffor = await ensurePorffor();
  const node = Bun.which("node");
  if (!node) throw new Error("native cpu stamp test needs node on PATH");
  const [core, broker] = await Promise.all([readFile(preludePath, "utf8"), readFile(transportPath("broker"), "utf8")]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const generated = join(workdir, "stamp.generated.js");
  const binary = join(workdir, "stamp-native");
  await writeFile(generated, wrapNativeFetchHandler(handler, core.replace(TRANSPORT_MARKER, broker)));
  const compile = Bun.spawn(
    [node, resolve(porffor, "runtime/index.js"), "native", generated, "-o", binary, "-s", "-O0"],
    {
      cwd: workdir,
      env: process.env,
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

  const port = await start(binary, {});
  const get = (path: string, headers: Record<string, string> = {}, p = port) =>
    fetch(`http://127.0.0.1:${p}${path}`, { headers });

  const text = await get("/text");
  assert.equal(await text.text(), "hello");
  assert.match(text.headers.get("x-sb-cpu-ms") ?? "", /^\d+\.\d{3}$/, "a string body is stamped");
  assert.equal(text.headers.get("content-type"), "text/plain;charset=UTF-8");

  const json = await get("/json");
  assert.equal(json.status, 201);
  assert.equal(await json.text(), '{"a":1}');
  assert.equal(json.headers.get("x-a"), "1");
  assert.equal(json.headers.get("content-type"), "application/json");
  assert.match(json.headers.get("x-sb-cpu-ms") ?? "", /^\d+\.\d{3}$/);

  const notFound = await get("/missing");
  assert.equal(notFound.status, 404);
  assert.match(notFound.headers.get("x-sb-cpu-ms") ?? "", /^\d+\.\d{3}$/);

  const bytes = await get("/bytes");
  assert.deepEqual([...new Uint8Array(await bytes.arrayBuffer())], [1, 2, 3]);
  assert.equal(bytes.headers.get("x-sb-cpu-ms"), null, "a binary body is not stamped");

  const cookies = await get("/cookies");
  assert.equal(await cookies.text(), "c");
  assert.deepEqual(cookies.headers.getSetCookie(), ["a=1", "b=2"]);
  assert.equal(cookies.headers.get("x-sb-cpu-ms"), null, "a Set-Cookie response is not stamped");

  const own = await get("/own");
  assert.match(own.headers.get("x-sb-cpu-ms") ?? "", /^\d+\.\d{3}$/, "the measured value replaces a handler-set one");

  for (let i = 0; i < 5; i++) assert.equal(await (await get("/text")).text(), "hello");

  // No trusted proxy: the peer is the client, forwarded headers do not count.
  const plain = await (await get("/ip", { "x-forwarded-for": "203.0.113.9", "x-sb-http-protocol": "h2" })).json();
  assert.deepEqual(plain, { ip: "127.0.0.1", proto: null });
  // The peer is a trusted proxy: the forwarded client and protocol count.
  const proxied = await start(binary, { SB_TRUSTED_PROXIES: "127.0.0.1" });
  const forwarded = await (
    await get("/ip", { "x-forwarded-for": "203.0.113.9", "x-sb-http-protocol": "h2" }, proxied)
  ).json();
  assert.deepEqual(forwarded, { ip: "203.0.113.9", proto: "h2" });
  console.log("Native x-sb-cpu-ms stamp and client IP: same responses on the wire, no second Response");
} finally {
  for (const server of servers) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
