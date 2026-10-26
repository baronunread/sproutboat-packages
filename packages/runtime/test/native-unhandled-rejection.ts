import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// A promise that rejects with nobody waiting on it (a binding call that failed and was never
// awaited, say a D1 run() that broke a foreign key) must not take the process down, whatever
// the compatibility date. As on Workers it is logged, an "unhandledrejection" listener hears
// it, and the next request is served.
const handler = `addEventListener("unhandledrejection", (event) => {
  globalThis.__heard = (globalThis.__heard || []).concat(String(event.reason && event.reason.message));
});
export default {async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/reject") {
    try {
      Promise.reject(new Error("D1_ERROR: FOREIGN KEY constraint failed"));
    } catch (error) {
      return new Response("caught", { status: 500 });
    }
    return new Response("fired");
  }
  if (path === "/promise") {
    try {
      new Promise(function (resolve, reject) { reject(new Error("kv failed")); });
    } catch (error) {
      return new Response("caught", { status: 500 });
    }
    return new Response("fired");
  }
  if (path === "/async") {
    async function failNow() { throw new Error("async function failed"); }
    failNow();
    return new Response("fired");
  }
  if (path === "/heard") return new Response(JSON.stringify(globalThis.__heard || []));
  return new Response("pong");
}};`;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

for (const date of ["2026-09-28", "2026-10-24"]) {
  const workdir = await mkdtemp(join(tmpdir(), "sb-native-unhandled-"));
  let server: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const porffor = await ensurePorffor();
    const node = Bun.which("node");
    if (!node) throw new Error("native unhandled rejection test needs node on PATH");
    const [core, broker] = await Promise.all([
      readFile(preludePath, "utf8"),
      readFile(transportPath("broker"), "utf8"),
    ]);
    assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
    const generated = join(workdir, "unhandled.generated.js");
    const binary = join(workdir, "unhandled-native");
    await writeFile(
      generated,
      wrapNativeFetchHandler(handler, core.replace(TRANSPORT_MARKER, broker), undefined, undefined, undefined, date),
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

    const port = freePort();
    server = Bun.spawn([binary], {
      cwd: workdir,
      env: { ...process.env, PORT: String(port), SB_BROKER_TOKEN: "native-test-token" },
      stdout: "ignore",
      stderr: "pipe",
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
    assert(ready, `compiled handler did not start (${date})`);
    const get = async (path: string) => (await fetch(`http://127.0.0.1:${port}${path}`)).text();

    assert.equal(await get("/reject"), "fired");
    assert.equal(await get("/pong"), "pong", `the request after an unhandled rejection failed (${date})`);
    assert.equal(await get("/promise"), "fired");
    assert.equal(await get("/async"), "fired");
    await Bun.sleep(300);
    assert.equal(await get("/pong"), "pong", `the request after a rejected promise failed (${date})`);
    assert.equal(server.exitCode, null, `the server exited on an unhandled rejection (${date})`);
    assert.equal(await get("/pong"), "pong", `the request after an unawaited async function threw failed (${date})`);
    const heard = JSON.parse(await get("/heard"));
    assert(
      heard.some((message: string) => message.includes("FOREIGN KEY")),
      `no unhandledrejection event for the rejected promise (${date}): ${JSON.stringify(heard)}`,
    );
    assert(
      heard.some((message: string) => message.includes("async function failed")),
      `no unhandledrejection event for the async function (${date}): ${JSON.stringify(heard)}`,
    );
    server.kill(9);
    await server.exited;
    const log = await new Response(server.stderr).text();
    assert(log.includes("Uncaught (in promise)"), `the rejection was not logged (${date}): ${log}`);
    server = undefined;
    console.log(`Native unhandled rejections are reported, not fatal (${date})`);
  } finally {
    if (server) {
      server.kill(9);
      await server.exited;
    }
    await rm(workdir, { recursive: true, force: true });
  }
}
