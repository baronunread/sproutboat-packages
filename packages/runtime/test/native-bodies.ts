import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// Bodies on the wire and the Fetch classes, against Bun: byte bodies go out as their bytes
// (a Uint8Array was sent as "104,105"), Blob and FormData bodies carry their type, and
// Request/Response/Blob follow the spec where Bun and workerd agree.
const handler = `export default {async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/u8") return new Response(new Uint8Array([104, 105, 0, 255]));
  if (path === "/ab") return new Response(new Uint8Array([1, 2, 3]).buffer);
  if (path === "/blob") return new Response(new Blob(["hé", new Uint8Array([33])], { type: "text/x-test" }));
  if (path === "/stream") return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("he")); c.enqueue(new Uint8Array([108, 108, 111])); c.close(); } }));
  if (path === "/stream-async") { await null; return new Response(new ReadableStream({ async pull(c) { await new Promise((r) => setTimeout(r, 5)); c.enqueue(new Uint8Array([0, 255])); c.close(); } }).pipeThrough(new TransformStream())); }
  if (path === "/stream-strings") return new Response(new ReadableStream({ start(c) { c.enqueue("text"); c.close(); } }));
  if (path === "/form") { const f = new FormData(); f.append("a", "1"); f.append("f", new Blob(["xy"]), "n.txt"); return new Response(f); }
  const cases = [
    // HTMLRewriter, against Bun's (lol-html, as in workerd): the W2 cases and more.
    () => typeof HTMLRewriter,
    () => new HTMLRewriter().on("h1", { element(e) { e.setInnerContent("x"); } }).transform(new Response("<h1>a</h1><p>b</p>")).text(),
    () => new HTMLRewriter().on("a", { element(e) { e.setAttribute("href", "/n"); } }).transform(new Response('<a href="/o" data-x=1>l</a>')).text(),
    () => new HTMLRewriter().on("script", { element(e) { e.remove(); } }).transform(new Response("<p>a</p><script>if (a < b) x()</script>")).text(),
    async () => { let t = ""; await new HTMLRewriter().on("p", { text(c) { t += c.text + (c.lastInTextNode ? "|" : ""); } }).transform(new Response("<p>hi <b>there</b></p>")).text(); return t; },
    () => new HTMLRewriter().on("body", { element(e) { e.append("<i>z</i>", { html: true }).prepend("<&>"); } }).transform(new Response("<body>a</body>")).text(),
    () => new HTMLRewriter().on("div > span.k, #m", { element(e) { e.replace("R"); } }).on("p", { comments(c) { c.remove(); } }).transform(new Response('<div><span class="k">1</span><p><!--c-->2<span class="k">3</span></p></div><i id="m">4</i>')).text(),
    () => new HTMLRewriter().on("li", { async element(e) { await null; e.removeAndKeepContent(); } }).onDocument({ end(d) { d.append("<!--e-->", { html: true }); } }).transform(new Response("<ul><li>a</li><li>b</li></ul>")).text(),
    // CompressionStream and DecompressionStream: our output round-trips, and zlib's decodes.
    async () => { const out = []; for (const f of ["gzip", "deflate", "deflate-raw"]) out.push(await new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("hello ".repeat(200))); c.close(); } }).pipeThrough(new CompressionStream(f)).pipeThrough(new DecompressionStream(f))).text() === "hello ".repeat(200)); return out.join(","); },
    async () => new Response(new ReadableStream({ start(c) { c.enqueue(Uint8Array.from(atob("H4sIAAAAAAACEysuKMovLUnKTyxRKB5uTACdCbks3AAAAA=="), (ch) => ch.charCodeAt(0))); c.close(); } }).pipeThrough(new DecompressionStream("gzip"))).text(),
    async () => new Response(new ReadableStream({ start(c) { c.enqueue(Uint8Array.from(atob("eJxLqcxLzM1MVsgoTUvLTcxTSBnlj4ZHJv3SQ2peCgCxCfLI"), (ch) => ch.charCodeAt(0))); c.close(); } }).pipeThrough(new DecompressionStream("deflate"))).text(),
    async () => { const s = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("hello hello")); c.close(); } }).pipeThrough(new CompressionStream("gzip")).pipeThrough(new DecompressionStream("gzip")).pipeThrough(new TextDecoderStream()); let t = ""; for (const r = s.getReader(); ;) { const { value, done } = await r.read(); if (done) break; t += value; } return t; },
    // workerd knows gzip, deflate and deflate-raw; Bun (the reference) also brotli.
    () => { try { new CompressionStream("brotli"); return "workerd:no throw"; } catch (e) { return "workerd:" + e.name; } },
    // A ReadableStream body is read to its end by text(), arrayBuffer(), json() and blob().
    async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("hé")); c.enqueue(new Uint8Array([33])); c.close(); } })).text(),
    async () => Array.from(new Uint8Array(await new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.close(); } })).arrayBuffer())).join(","),
    async () => JSON.stringify(await new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"a":[1]}')); c.close(); } })).json()),
    async () => (await new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([120])); c.close(); } })).blob()).size,
    async () => new Request("http://a.test", { method: "POST", body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("req")); c.close(); } }), duplex: "half" }).text(),
    // Chunks must be bytes: workerd throws a TypeError, where Bun (the reference below) reads a
    // string chunk as text. "workerd:" marks the answer to expect from workerd instead.
    async () => { try { await new Response(new ReadableStream({ start(c) { c.enqueue("s"); c.close(); } })).text(); return "workerd:no throw"; } catch (e) { return "workerd:" + e.name; } },
    () => new Request("http://a.test/a/../b?x=1#f").url,
    async () => { const r = new Request("http://a.test", { method: "POST", body: "x" }); await r.text(); try { await r.text(); return "no throw"; } catch (e) { return r.bodyUsed + ":" + e.name; } },
    () => new Request("http://a.test").redirect,
    () => { try { new Request("/relative"); return "no throw"; } catch (e) { return e.name; } },
    () => new Response("x", { status: 201, statusText: "Made" }).statusText,
    () => { try { new Response("x", { status: 99 }); return "no throw"; } catch (e) { return e.name; } },
    () => Response.error().type + ":" + Response.error().status,
    async () => Array.from(new Uint8Array(await new Response(new Uint8Array([1, 2, 3])).arrayBuffer())).join(),
    async () => (await new Response("abc").blob()).size,
    () => { const b = new Blob(["abcdef"], { type: "Text/Plain" }); return b.size + ":" + b.type; },
    async () => new Blob(["abcdef"]).slice(-2).text(),
    async () => { const f = new FormData(); f.append("f", new Blob(["x"]), "n.txt"); const v = f.get("f"); return v.name + ":" + v.size; },
    async () => (await new Response(new URLSearchParams({ a: "1" })).text()) + "|" + new Response(new URLSearchParams("a=1")).headers.get("content-type"),
  ];
  const out = [];
  for (const run of cases) { try { out.push(String(await run())); } catch (e) { out.push("THROWS " + (e && e.name)); } }
  return new Response(JSON.stringify(out));
}};`;
const CASE_SOURCES = handler.slice(handler.indexOf("const cases = ["), handler.indexOf("  ];") + 4);

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-bodies-"));
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  const porffor = await ensurePorffor();
  const node = Bun.which("node");
  if (!node) throw new Error("native streams test needs node on PATH");

  const [core, broker] = await Promise.all([
    readFile(preludePath, "utf8"),
    readFile(transportPath("broker"), "utf8"),
  ]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const prelude = core.replace(TRANSPORT_MARKER, broker);
  const generated = join(workdir, "bodies.generated.js");
  const binary = join(workdir, "bodies-native");
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
  const bytes = async (path: string) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    return { type: r.headers.get("content-type"), bytes: Array.from(new Uint8Array(await r.arrayBuffer())) };
  };
  assert.deepEqual(await bytes("/u8"), { type: null, bytes: [104, 105, 0, 255] });
  assert.deepEqual(await bytes("/ab"), { type: null, bytes: [1, 2, 3] });
  assert.deepEqual(await bytes("/blob"), { type: "text/x-test", bytes: [104, 195, 169, 33] });
  assert.deepEqual(await bytes("/stream"), { type: null, bytes: [104, 101, 108, 108, 111] });
  assert.deepEqual(await bytes("/stream-async"), { type: null, bytes: [0, 255] });
  // A stream of strings is not a body (TypeError, as in workerd). Streamed, the status line is
  // already out when the first chunk is read, so the response ends empty instead of a 500.
  const strings = await fetch(`http://127.0.0.1:${port}/stream-strings`);
  assert.equal(await strings.text(), "", "a stream of strings sends no body");
  const form = await fetch(`http://127.0.0.1:${port}/form`);
  const boundary = (form.headers.get("content-type") || "").split("boundary=")[1];
  assert(boundary, "multipart content type");
  const parsed = await new Response(await form.arrayBuffer(), { headers: { "content-type": `multipart/form-data; boundary=${boundary}` } }).formData();
  assert.equal(parsed.get("a"), "1");
  const file = parsed.get("f");
  assert(file instanceof File, "the file part parses back as a File");
  assert.equal(await file.text(), "xy");
  assert.equal(file.name, "n.txt");
  // SAFETY: the handler above is the only producer of this body: a JSON array with one
  // string per case.
  const got = JSON.parse(await (await fetch(`http://127.0.0.1:${port}/cases`)).text()) as string[];
  const want: string[] = [];
  // SAFETY: CASE_SOURCES is the handler's own literal list of case functions.
  const reference = new Function(`return (() => { ${CASE_SOURCES} return cases; })()`)() as Array<() => Promise<string> | string>;
  for (const run of reference) {
    try { want.push(String(await run())); } catch (e) { want.push("THROWS " + (e instanceof Error ? e.name : String(e))); }
  }
  assert.deepEqual(got, want.map((w) => (w.startsWith("workerd:") ? "workerd:TypeError" : w)));
  console.log(`Native bodies are sent as bytes and ${want.length} Fetch class cases match Bun`);
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
