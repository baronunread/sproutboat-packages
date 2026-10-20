import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// new Request(request, init) and fetch-style Request copies, compared with Bun: the copy
// keeps method, URL, headers and body, and init overrides them field by field (W1).
const CASES = [
  `new Request(new Request("http://a.test/x", { method: "PUT" })).method`,
  `new Request(new Request("http://a.test/x?q=1")).url`,
  `new Request(new Request("http://a.test/x", { method: "PUT" }), { method: "DELETE" }).method`,
  `new Request(new Request("http://a.test/x", { headers: { a: "1" } })).headers.get("a")`,
  `[...new Request(new Request("http://a.test/x", { headers: { a: "1" } }), { headers: { b: "2" } }).headers].join(";")`,
  `new Request(new Request("http://a.test/x", { method: "POST", body: "hi" })).text()`,
  `new Request(new Request("http://a.test/x", { method: "POST", body: "hi" }), { body: "yo" }).text()`,
  `new Request(new URL("http://a.test/u")).url`,
  `new Request("http://a.test/x", { method: "post" }).method`,
];
const handler = `export default {async fetch(request) {
  // The incoming request: its body is a ReadableStream, and text() still reads it.
  if (request.method === "POST") return new Response((request.body instanceof ReadableStream) + ":" + (await request.text()));
  const cases = [
${CASES.map((c) => `    () => (${c}),`).join("\n")}
  ];
  const out = [];
  for (const run of cases) {
    try { out.push(String(await run())); } catch (e) { out.push("THROWS " + (e && e.message)); }
  }
  return new Response(JSON.stringify(out));
}};`;
const want = await Promise.all(CASES.map(async (c) => { try { return String(await new Function("return " + c)()); } catch (e) { return "THROWS " + (e instanceof Error ? e.message : String(e)); } }));

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-request-"));
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
  const generated = join(workdir, "request.generated.js");
  const binary = join(workdir, "request-native");
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
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
      ready = true;
    } catch {
      if (server.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  assert(ready, "compiled handler did not start");
  // SAFETY: the handler above is the only producer of this body: a JSON array with one
  // string per case; the comparison below reports any entry that differs.
  const got = JSON.parse(await (await fetch(`http://127.0.0.1:${port}/`)).text()) as string[];
  const diffs = CASES.flatMap((c, i) => (got[i] === want[i] ? [] : [`${c}\n    want ${JSON.stringify(want[i])}\n    got  ${JSON.stringify(got[i])}`]));
  assert.deepEqual(diffs, [], `Request copies differ from Bun in ${diffs.length} of ${CASES.length} cases:\n${diffs.join("\n")}`);
  const posted = await (await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "posted é" })).text();
  assert.equal(posted, "true:posted é", "the incoming request body is a stream and text() reads it");
  console.log(`Native Request copies match Bun in all ${CASES.length} cases; the incoming body is a stream`);
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
