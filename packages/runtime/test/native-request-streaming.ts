import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// Streamed request bodies, from compatibility date 2026-10-27: the handler runs once the
// headers are in, request.body hands out chunks as they arrive, text()/json()/arrayBuffer()
// still read the whole body, and a large upload read through the stream keeps memory flat
// (the server pauses the socket while 1 MiB waits unread).
const handler = `export default {async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/timing") {
    const reader = request.body.getReader();
    let first = 0, last = 0, text = "", chunks = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      last = Date.now();
      if (!first) first = last;
      chunks++;
      text += new TextDecoder().decode(value);
    }
    return Response.json({ text, gapMs: last - first, chunks });
  }
  if (path === "/count") {
    const reader = request.body.getReader();
    let bytes = 0, sum = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      // Every 4096th byte of the whole body, wherever the server split it into chunks.
      for (let i = (4096 - (bytes % 4096)) % 4096; i < value.length; i += 4096) sum = (sum + value[i]) % 65521;
      bytes += value.length;
    }
    return Response.json({ bytes, sum });
  }
  if (path === "/text") { const t = await request.text(); return Response.json({ length: t.length, head: t.slice(0, 8) }); }
  if (path === "/json") return Response.json(await request.json());
  if (path === "/ab") { const b = new Uint8Array(await request.arrayBuffer()); return Response.json({ length: b.length, last: b[b.length - 1] }); }
  if (path === "/twice") { await request.text(); try { await request.text(); return new Response("read twice"); } catch (e) { return new Response(e.name); } }
  if (path === "/echo") return new Response(request.body);
  if (path === "/ignore") return new Response("ignored");
  return new Response("no route " + path, { status: 404 });
}};`;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

/** An upload of `total` bytes in 64 KiB chunks, as a stream (chunked transfer encoding). */
function upload(total: number, gapMs = 0): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    async pull(controller) {
      if (sent >= total) return controller.close();
      const n = Math.min(65536, total - sent);
      const chunk = new Uint8Array(n);
      for (let i = 0; i < n; i += 4096) chunk[i] = (sent + i) % 251;
      sent += n;
      controller.enqueue(chunk);
      if (gapMs) await Bun.sleep(gapMs);
    },
  });
}
const expectedSum = (total: number) => {
  let sum = 0;
  for (let at = 0; at < total; at += 65536) {
    const n = Math.min(65536, total - at);
    for (let i = 0; i < n; i += 4096) sum = (sum + ((at + i) % 251)) % 65521;
  }
  return sum;
};

const workdir = await mkdtemp(join(tmpdir(), "sb-native-request-streaming-"));
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  const porffor = await ensurePorffor();
  const node = Bun.which("node");
  if (!node) throw new Error("native request-streaming test needs node on PATH");
  const [core, broker] = await Promise.all([readFile(preludePath, "utf8"), readFile(transportPath("broker"), "utf8")]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const generated = join(workdir, "stream.generated.js");
  const binary = join(workdir, "stream-native");
  const source = wrapNativeFetchHandler(
    handler,
    core.replace(TRANSPORT_MARKER, broker),
    {},
    undefined,
    undefined,
    "2026-10-27",
  );
  await writeFile(generated, source);
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
  const linux = process.platform === "linux";
  server = Bun.spawn(linux ? [binary] : ["/usr/bin/time", "-l", binary], {
    cwd: workdir,
    env: { ...process.env, PORT: String(port), SB_REQUEST_BODY_MAX: String(256 * 1024 * 1024) },
    stdout: "ignore",
    stderr: "pipe",
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 50 && !ready; attempt++) {
    try {
      await fetch(`${base}/ignore`, { signal: AbortSignal.timeout(500) });
      ready = true;
    } catch {
      if (server.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  assert(ready, "compiled handler did not start");
  const post = (path: string, body: BodyInit, headers?: HeadersInit) => {
    const init: RequestInit & { duplex: string } = { method: "POST", body, headers, duplex: "half" };
    return fetch(`${base}${path}`, init);
  };

  // The handler sees the first chunk before the second is sent.
  const encoder = new TextEncoder();
  const timed = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode("first "));
      await Bun.sleep(500);
      controller.enqueue(encoder.encode("second"));
      controller.close();
    },
  });
  const timing = await (await post("/timing", timed)).json();
  assert.equal(timing.text, "first second");
  assert(timing.gapMs > 300, `the body arrived in parts (${timing.gapMs} ms apart)`);
  console.log(`request.body streams: the second chunk arrived ${timing.gapMs} ms after the first`);

  // Whole-body readers still work, on a fixed-length and on a chunked body.
  assert.deepEqual(await (await post("/text", "héllo wörld ✓")).json(), { length: 13, head: "héllo wö" });
  assert.deepEqual(await (await post("/json", JSON.stringify({ a: [1, "ü"] }))).json(), { a: [1, "ü"] });
  const big = new Uint8Array(3 * 1024 * 1024 + 7).fill(65);
  big[big.length - 1] = 66;
  assert.deepEqual(await (await post("/ab", big)).json(), { length: big.length, last: 66 });
  assert.deepEqual(await (await post("/ab", upload(5 * 1024 * 1024 + 1))).json(), {
    length: 5 * 1024 * 1024 + 1,
    last: (5 * 1024 * 1024) % 251,
  });
  assert.equal(await (await post("/twice", "x")).text(), "TypeError");
  assert.equal(await (await post("/echo", "echo me")).text(), "echo me");
  // A body the handler never reads doesn't stall the connection or the next request.
  assert.equal(await (await post("/ignore", new Uint8Array(4 * 1024 * 1024))).text(), "ignored");
  assert.equal(await (await post("/text", "after")).text(), JSON.stringify({ length: 5, head: "after" }));
  console.log("text(), json(), arrayBuffer(), echo and an unread body work");

  // Over the limit by Content-Length: 413 before the handler runs.
  // (Raw, since fetch() sets Content-Length from the body it actually sends.)
  const statusLine = await new Promise<string>((done, fail) => {
    let got = "";
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write(`POST /count HTTP/1.1\r\nHost: x\r\nContent-Length: ${300 * 1024 * 1024}\r\n\r\n`);
        },
        data(socket, data) {
          got += data.toString();
          if (got.includes("\r\n")) {
            socket.end();
            done(got.slice(0, got.indexOf("\r\n")));
          }
        },
        error(_socket, error) {
          fail(error);
        },
      },
    });
  });
  assert.equal(statusLine, "HTTP/1.1 413 Payload Too Large");
  console.log("a body over SB_REQUEST_BODY_MAX by Content-Length gets 413 before the handler runs");

  // Memory stays flat as the upload grows: 128 MiB read through the stream.
  const total = 128 * 1024 * 1024;
  const counted = await (await post("/count", upload(total))).json();
  assert.deepEqual(counted, { bytes: total, sum: expectedSum(total) });
  let peak = 0;
  if (linux) {
    const status = await readFile(`/proc/${server.pid}/status`, "utf8");
    peak = Number(/VmHWM:\s+(\d+) kB/.exec(status)?.[1] ?? 0) * 1024;
  }
  server.kill("SIGINT");
  const timingOut = linux ? "" : await new Response(server.stderr).text();
  await server.exited;
  server = undefined;
  if (!linux) peak = Number(/(\d+)\s+maximum resident set size/.exec(timingOut)?.[1] ?? 0);
  assert(peak > 0, "peak RSS was measured");
  // Buffered, the 128 MiB body alone took 128 MiB three times over.
  assert(peak < 64 * 1024 * 1024, `a 128 MiB streamed upload peaked at ${(peak / 1048576).toFixed(1)} MiB`);
  console.log(`a 128 MiB upload read through request.body peaks at ${(peak / 1048576).toFixed(1)} MiB RSS`);
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
