import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// The native HTTP server's wire behaviour with raw sockets: keep-alive, pipelining (responses in
// order, also when a request arrives in pieces), a response bigger than the socket buffer to a slow
// reader (partial writes), a large request body, and many connections at once. Run once with a
// collection after every request (SB_GC_EVERY=1) and once with the default interval, so the
// collection schedule is shown not to disturb any of it.
const handler = `export default {async fetch(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path.startsWith("/n/")) return new Response("n=" + path.slice(3), { headers: { "x-n": path.slice(3) } });
  if (path === "/echo") { const b = await request.arrayBuffer(); return new Response("len=" + b.byteLength + " first=" + (b.byteLength ? new Uint8Array(b)[0] : -1) + " last=" + (b.byteLength ? new Uint8Array(b)[b.byteLength - 1] : -1)); }
  if (path === "/big") {
    const size = Number(url.searchParams.get("size"));
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i++) out[i] = (i * 31 + 7) & 255;
    return new Response(out);
  }
  if (path === "/garbage") { const rows = []; for (let i = 0; i < 2000; i++) rows.push({ i, s: "x".repeat(i % 50) }); return new Response(JSON.stringify(rows).length + ""); }
  return new Response("not found", { status: 404 });
}};`;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

type Parsed = { status: number; headers: Map<string, string>; body: Buffer };

// Parses as many whole Content-Length responses as `buffer` holds; returns them and the rest.
type ParsedBatch = { done: Parsed[]; rest: Buffer };
function parseResponses(buffer: Buffer): ParsedBatch {
  const done: Parsed[] = [];
  let rest = buffer;
  for (;;) {
    const end = rest.indexOf("\r\n\r\n");
    if (end < 0) break;
    const head = rest.subarray(0, end).toString("latin1").split("\r\n");
    const status = Number(head[0].split(" ")[1]);
    const headers = new Map<string, string>();
    for (const line of head.slice(1)) {
      const at = line.indexOf(":");
      headers.set(line.slice(0, at).toLowerCase(), line.slice(at + 1).trim());
    }
    const length = Number(headers.get("content-length") ?? 0);
    if (rest.length < end + 4 + length) break;
    done.push({ status, headers, body: rest.subarray(end + 4, end + 4 + length) });
    rest = rest.subarray(end + 4 + length);
  }
  return { done, rest };
}

// Writes `chunks` (with `gapMs` between them), then reads until `want` responses arrived.
// `readDelayMs` holds the socket paused first, so the server's send buffer fills.
async function exchange(
  port: number,
  chunks: Buffer[],
  want: number,
  opts: { gapMs?: number; readDelayMs?: number; timeoutMs?: number } = {},
): Promise<Parsed[]> {
  return new Promise((resolveExchange, reject) => {
    const socket = connect(port, "127.0.0.1");
    let pending = Buffer.alloc(0);
    const responses: Parsed[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out with ${responses.length} of ${want} responses`));
    }, opts.timeoutMs ?? 30_000);
    socket.on("error", reject);
    socket.on("data", (data) => {
      pending = Buffer.concat([pending, data]);
      const { done, rest } = parseResponses(pending);
      pending = rest;
      responses.push(...done);
      if (responses.length >= want) {
        clearTimeout(timer);
        socket.destroy();
        resolveExchange(responses);
      }
    });
    socket.on("connect", async () => {
      if (opts.readDelayMs) {
        socket.pause();
        setTimeout(() => socket.resume(), opts.readDelayMs);
      }
      for (const chunk of chunks) {
        socket.write(chunk);
        if (opts.gapMs) await Bun.sleep(opts.gapMs);
      }
    });
  });
}

const get = (path: string, close = false) =>
  Buffer.from(`GET ${path} HTTP/1.1\r\nHost: t\r\n${close ? "Connection: close\r\n" : ""}\r\n`);
const post = (path: string, body: Buffer) =>
  Buffer.concat([Buffer.from(`POST ${path} HTTP/1.1\r\nHost: t\r\nContent-Length: ${body.length}\r\n\r\n`), body]);

async function suite(port: number, label: string) {
  // Keep-alive: sequential requests on one connection, each answered before the next is sent.
  {
    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((r) => socket.once("connect", () => r()));
    let pending = Buffer.alloc(0);
    for (let i = 0; i < 5; i++) {
      socket.write(get(`/n/${i}`));
      let got: Parsed | undefined;
      while (!got) {
        const data = await new Promise<Buffer>((r) => socket.once("data", r));
        pending = Buffer.concat([pending, data]);
        const parsed = parseResponses(pending);
        pending = parsed.rest;
        got = parsed.done[0];
      }
      assert.equal(got.body.toString(), `n=${i}`, `${label}: keep-alive response ${i}`);
    }
    socket.destroy();
  }

  // Pipelining: 60 requests in one write come back complete and in order.
  {
    const all = Buffer.concat(Array.from({ length: 60 }, (_, i) => get(`/n/${i}`)));
    const got = await exchange(port, [all], 60);
    assert.deepEqual(
      got.map((r) => r.body.toString()),
      Array.from({ length: 60 }, (_, i) => `n=${i}`),
      `${label}: pipelined order`,
    );
  }

  // Pipelining with requests cut at every awkward place: one byte at a time for the first two.
  {
    const bytes = Buffer.concat([get("/n/a"), post("/echo", Buffer.from("hello")), get("/n/b")]);
    const chunks: Buffer[] = [];
    for (let i = 0; i < 40; i++) chunks.push(bytes.subarray(i, i + 1));
    chunks.push(bytes.subarray(40));
    const got = await exchange(port, chunks, 3, { gapMs: 2 });
    assert.deepEqual(
      got.map((r) => r.body.toString()),
      ["n=a", "len=5 first=104 last=111", "n=b"],
      `${label}: pipelined requests split across packets`,
    );
  }

  // A POST whose body arrives in pieces, followed by a pipelined GET.
  {
    const body = Buffer.alloc(300_000, 0x61);
    body[0] = 0x62;
    const request = Buffer.concat([post("/echo", body), get("/n/after")]);
    const chunks: Buffer[] = [];
    for (let at = 0; at < request.length; at += 40_000) chunks.push(request.subarray(at, at + 40_000));
    const got = await exchange(port, chunks, 2, { gapMs: 3 });
    assert.equal(got[0].body.toString(), "len=300000 first=98 last=97", `${label}: large request body`);
    assert.equal(got[1].body.toString(), "n=after", `${label}: request after a large body`);
  }

  // Partial writes: 12 MB to a reader that does not read for 400 ms, then a pipelined small response
  // that must still arrive after it, in order.
  {
    const size = 12 * 1024 * 1024;
    const got = await exchange(port, [get(`/big?size=${size}`), get("/n/last")], 2, {
      readDelayMs: 400,
      timeoutMs: 60_000,
    });
    assert.equal(got[0].body.length, size, `${label}: big body length`);
    const expected = Buffer.alloc(size);
    for (let i = 0; i < size; i++) expected[i] = (i * 31 + 7) & 255;
    assert.equal(
      createHash("sha256").update(got[0].body).digest("hex"),
      createHash("sha256").update(expected).digest("hex"),
      `${label}: big body bytes`,
    );
    assert.equal(got[1].body.toString(), "n=last", `${label}: response after a partial write`);
  }

  // Connection: close ends the connection after the response.
  {
    const got = await exchange(port, [get("/n/close", true)], 1);
    assert.equal(got[0].body.toString(), "n=close");
  }

  // 150 connections at once, 4 pipelined requests each, with garbage-heavy requests mixed in.
  {
    const results = await Promise.all(
      Array.from({ length: 150 }, async (_, c) => {
        const chunks = [get(`/n/${c}-0`), get("/garbage"), get(`/n/${c}-2`), get(`/n/${c}-3`)];
        return exchange(port, [Buffer.concat(chunks)], 4);
      }),
    );
    results.forEach((got, c) => {
      assert.deepEqual(
        [got[0].body.toString(), got[2].body.toString(), got[3].body.toString()],
        [`n=${c}-0`, `n=${c}-2`, `n=${c}-3`],
        `${label}: connection ${c}`,
      );
      assert.equal(got[1].status, 200);
    });
  }
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-http-"));
const servers: Array<ReturnType<typeof Bun.spawn>> = [];
try {
  const porffor = await ensurePorffor();
  const node = Bun.which("node");
  if (!node) throw new Error("native http test needs node on PATH");
  const [core, broker] = await Promise.all([readFile(preludePath, "utf8"), readFile(transportPath("broker"), "utf8")]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const generated = join(workdir, "http.generated.js");
  const binary = join(workdir, "http-native");
  await writeFile(
    generated,
    wrapNativeFetchHandler(
      handler,
      core.replace(TRANSPORT_MARKER, broker),
      undefined,
      undefined,
      undefined,
      "2026-10-21",
    ),
  );
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

  for (const every of ["1", "8"]) {
    const port = freePort();
    const server = Bun.spawn([binary], {
      cwd: workdir,
      env: { ...process.env, PORT: String(port), SB_GC_EVERY: every },
      stdout: "ignore",
      stderr: "inherit",
    });
    servers.push(server);
    let ready = false;
    for (let attempt = 0; attempt < 50 && !ready; attempt++) {
      try {
        await fetch(`http://127.0.0.1:${port}/n/0`, { signal: AbortSignal.timeout(500) });
        ready = true;
      } catch {
        if (server.exitCode !== null) break;
        await Bun.sleep(100);
      }
    }
    assert(ready, "compiled handler did not start");
    await suite(port, `SB_GC_EVERY=${every}`);
    // The server is still answering after all of it.
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/n/z`)).text(), "n=z");
  }
  console.log(
    "Native HTTP: keep-alive, pipelining, split requests, large bodies, partial writes and 150 connections hold at SB_GC_EVERY=1 and 8",
  );
} finally {
  for (const server of servers) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
