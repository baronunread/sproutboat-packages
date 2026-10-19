import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// What workerd answers for the same handler (checked 2026-10-19, workerd 2026-10-16).
const expected = {
  "/text": { type: "text/plain;charset=UTF-8" },
  "/typed": { type: "text/html" },
  "/json": { type: "application/json" },
  "/null": { type: null },
  "/bytes": { type: null },
  "/redirect": { type: null, location: "https://example.com/" },
  "/throw": { type: null },
} satisfies Record<string, { type: string | null; location?: string }>;
const handler = `export default {fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/text") return new Response("hello");
  if (path === "/typed") return new Response("<p>hi</p>", { headers: { "content-type": "text/html" } });
  if (path === "/json") return Response.json({ a: 1 });
  if (path === "/null") return new Response(null, { status: 204 });
  if (path === "/bytes") return new Response(new Uint8Array([1, 2, 3]));
  if (path === "/redirect") return Response.redirect("https://example.com", 301);
  if (path === "/throw") throw new Error("boom");
  return new Response("not found", { status: 404 });
}};`;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-response-defaults-"));
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
  const generated = join(workdir, "response.generated.js");
  const binary = join(workdir, "response-native");
  await writeFile(generated, wrapNativeFetchHandler(handler, prelude));
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
      await fetch(`http://127.0.0.1:${port}/text`, { signal: AbortSignal.timeout(500) });
      ready = true;
    } catch {
      if (server.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  assert(ready, "compiled handler did not start");
  for (const [path, want] of Object.entries(expected)) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual" });
    assert.equal(response.headers.get("content-type"), want.type, `${path} content-type`);
    if ("location" in want) assert.equal(response.headers.get("location"), want.location, `${path} location`);
  }
  console.log("Native Response defaults match workerd: text/plain for strings, application/json, normalized redirects");
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
