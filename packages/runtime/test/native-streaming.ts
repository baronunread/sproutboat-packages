import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// A ReadableStream response body is streamed (B19): each chunk reaches the client when the
// handler produces it, over chunked encoding, with the handler's headers and no internal
// marker; a client that goes away does not take the server down.
const handler = `export default {async fetch(request) {
  const path = new URL(request.url).pathname;
  const enc = new TextEncoder();
  if (path === "/slow") {
    let n = 0;
    return new Response(new ReadableStream({ async pull(c) {
      if (n === 3) { c.close(); return; }
      if (n > 0) await new Promise((r) => setTimeout(r, 300));
      c.enqueue(enc.encode("chunk" + n + "\\n")); n++;
    } }), { headers: { "content-type": "text/event-stream" } });
  }
  if (path === "/forever") {
    let n = 0;
    return new Response(new ReadableStream({ async pull(c) { await new Promise((r) => setTimeout(r, 50)); c.enqueue(enc.encode("tick " + n++ + "\\n")); } }));
  }
  return new Response("ok");
}};`;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-streaming-"));
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  const porffor = await ensurePorffor();
  const node = Bun.which("node");
  if (!node) throw new Error("native streaming test needs node on PATH");

  const [core, broker] = await Promise.all([
    readFile(preludePath, "utf8"),
    readFile(transportPath("broker"), "utf8"),
  ]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const prelude = core.replace(TRANSPORT_MARKER, broker);
  const generated = join(workdir, "streaming.generated.js");
  const binary = join(workdir, "streaming-native");
  await writeFile(generated, wrapNativeFetchHandler(handler, prelude, undefined, undefined, undefined, "2026-10-01"));
  await rm(binary, { force: true });

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

  const port = freePort();
  server = Bun.spawn([binary], {
    cwd: workdir,
    env: { ...process.env, PORT: String(port) },
    stdout: "ignore",
    stderr: "inherit",
  });
  let ready = false;
  for (let attempt = 0; attempt < 50 && !ready; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
      ready = true;
    } catch {
      if (server.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  assert(ready, "compiled handler did not start");

  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${port}/slow`);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(res.headers.get("x-sb-stream"), null, "the internal stream marker is never sent");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const arrivals: { ms: number; text: string }[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    arrivals.push({ ms: performance.now() - t0, text: decoder.decode(value) });
  }
  assert.equal(arrivals.map((a) => a.text).join(""), "chunk0\nchunk1\nchunk2\n");
  // Buffered, everything would arrive together after ~600 ms.
  assert(arrivals[0].ms < 250, `the first chunk took ${Math.round(arrivals[0].ms)} ms`);
  assert(arrivals[arrivals.length - 1].ms - arrivals[0].ms > 400, "chunks arrived together, not as produced");

  const abort = new AbortController();
  const forever = await fetch(`http://127.0.0.1:${port}/forever`, { signal: abort.signal });
  assert.equal(decoder.decode((await forever.body!.getReader().read()).value), "tick 0\n");
  abort.abort();
  await Bun.sleep(300);
  assert.equal(server.exitCode, null, "a client that went away took the server down");
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "ok");
  console.log(`Native streamed body: chunks at ${arrivals.map((a) => Math.round(a.ms)).join(", ")} ms`);
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
