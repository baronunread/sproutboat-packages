import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// ctx.waitUntil work runs after the response, as in workerd: the response does not wait
// for it, the work still finishes, and its 25 s cap leaves no timer behind once it is done.
const handler = `export default {async fetch(request, env, ctx) {
  const path = new URL(request.url).pathname;
  if (path === "/later") {
    globalThis.__done = "pending";
    ctx.waitUntil(new Promise((resolve) => setTimeout(() => { globalThis.__done = "done"; resolve(); }, 400)));
    return new Response("scheduled");
  }
  if (path === "/state") return new Response(String(globalThis.__done));
  if (path === "/cron") return new Response(String(globalThis.__cron));
  return new Response("ok");
},
async scheduled(event, env, ctx) {
  ctx.waitUntil(new Promise((resolve) => setTimeout(() => { globalThis.__cron = event.cron; resolve(); }, 50)));
}};`;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-waituntil-"));
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
  const generated = join(workdir, "waituntil.generated.js");
  const binary = join(workdir, "waituntil-native");
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
    env: { ...process.env, PORT: String(port), SB_BROKER_TOKEN: "native-test-token" },
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
  const first = await (await fetch(`http://127.0.0.1:${port}/later`)).text();
  const elapsed = performance.now() - t0;
  assert.equal(first, "scheduled");
  assert(elapsed < 300, `the response waited ${Math.round(elapsed)} ms for its waitUntil work`);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/state`)).text(), "pending");
  await Bun.sleep(700);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/state`)).text(), "done");
  // A trigger answers 204 with no body. new Response("", { status: 204 }) throws under the
  // Fetch-spec Response, and the prelude used it: the first cron or alarm took the server down.
  const cron = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "x-sb-trigger": "scheduled", "x-sb-token": "native-test-token", "content-type": "application/json" },
    body: JSON.stringify({ cron: "*/5 * * * *", scheduledTime: Date.now() }),
  });
  assert.equal(cron.status, 204);
  assert.equal(await cron.text(), "");
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/cron`)).text(), "*/5 * * * *");
  assert.equal(server.exitCode, null, "the server exited after a scheduled trigger");
  console.log(`Native waitUntil runs after the response (${Math.round(elapsed)} ms) and completes; scheduled() answers 204`);
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
