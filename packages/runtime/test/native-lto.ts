import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileNative } from "./native-compile";
import { standaloneChannel } from "../../toolchain/src/a21/standalone-channel";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// A standalone server built the way the CLI's host and release builds are: `-flto -O3`. Every other native test
// compiles without LTO, and that hid a bug on Porffor alpha 23 for macOS arm64: the bridge called the generated
// main (`p__main__23main`) as a plain C function while the definition is swiftcall, which is harmless across
// object files and, once LTO sees both, becomes `unreachable`. The binary died with SIGTRAP before it listened.
// The server must start and answer through every way the host C enters generated code: startup, a request,
// a timer, a settled promise.
const handler = `export default {async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/timer") { await new Promise((done) => setTimeout(done, 20)); return new Response("timer ok"); }
  if (url.pathname === "/echo") return new Response("echo:" + (await request.text()));
  if (url.pathname === "/json") return Response.json({ n: [1, 2, 3], s: "é" });
  return new Response("hello");
}};`;

if (standaloneChannel() === "alpha-19") {
  console.log(
    "SKIPPED: the alpha 19 fallback compiles through the compiler's own native build, which has no -flto switch here",
  );
  process.exit(0);
}

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-lto-"));
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  const [core, broker] = await Promise.all([readFile(preludePath, "utf8"), readFile(transportPath("broker"), "utf8")]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const prelude = core.replace(TRANSPORT_MARKER, broker);
  const generated = join(workdir, "lto.generated.js");
  const binary = join(workdir, "lto-native");
  await writeFile(generated, wrapNativeFetchHandler(handler, prelude));

  await compileNative({ generated, binary, dir: workdir, flto: true, optimize: 3 });

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
  assert(ready, `the -flto -O3 binary did not start (exit ${server.exitCode}, signal ${server.signalCode})`);
  const base = `http://127.0.0.1:${port}`;
  assert.equal(await (await fetch(`${base}/`)).text(), "hello");
  assert.equal(await (await fetch(`${base}/timer`)).text(), "timer ok");
  assert.equal(await (await fetch(`${base}/echo`, { method: "POST", body: "abc" })).text(), "echo:abc");
  assert.deepEqual(await (await fetch(`${base}/json`)).json(), { n: [1, 2, 3], s: "é" });
  assert.equal(server.exitCode, null, "the server stayed up");
  console.log("A -flto -O3 standalone build starts and answers: startup, request, timer, promise, body");
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
