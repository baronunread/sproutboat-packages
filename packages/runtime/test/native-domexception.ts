import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// DOMException in a compiled handler, compared with Bun. Porffor ships a stub global that
// cannot be constructed; the prelude replaces it (found while testing third-party packages).
const CASES = [
  `(() => { const e = new DOMException("m", "AbortError"); return [e.name, e.message, e.code, e instanceof Error, e instanceof DOMException].join(); })()`,
  `(() => { const e = new DOMException(); return [e.name, JSON.stringify(e.message), e.code].join(); })()`,
  `(() => { const e = new DOMException("m", { name: "TimeoutError", cause: "c" }); return [e.name, e.code, e.cause].join(); })()`,
  `(() => { const e = new DOMException("x", "CustomName"); return [e.name, e.code].join(); })()`,
  `[DOMException.ABORT_ERR, DOMException.TIMEOUT_ERR, DOMException.DATA_CLONE_ERR, DOMException.NOT_SUPPORTED_ERR, DOMException.INVALID_STATE_ERR].join()`,
  `(() => { const r = AbortSignal.abort().reason; return [r instanceof DOMException, r.name, r.code].join(); })()`,
  `(() => { const c = new AbortController(); c.abort(); try { c.signal.throwIfAborted(); return "no throw"; } catch (e) { return [e instanceof DOMException, e.name].join(); } })()`,
  `(() => { try { throw new DOMException("boom", "InvalidStateError"); } catch (e) { return String(e); } })()`,
];
const handler = `export default {async fetch() {
  const cases = [
${CASES.map((c) => `    () => (${c}),`).join("\n")}
  ];
  const out = [];
  for (const run of cases) {
    try { out.push(String(await run())); } catch (e) { out.push("THROWS " + (e && e.message)); }
  }
  return new Response(JSON.stringify(out));
}};`;
const want = await Promise.all(
  CASES.map(async (c) => {
    try {
      return String(await new Function("return " + c)());
    } catch (e) {
      return "THROWS " + (e instanceof Error ? e.message : String(e));
    }
  }),
);

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-domexception-"));
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  const porffor = await ensurePorffor();
  const node = Bun.which("node");
  if (!node) throw new Error("native streams test needs node on PATH");

  const [core, broker] = await Promise.all([readFile(preludePath, "utf8"), readFile(transportPath("broker"), "utf8")]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const prelude = core.replace(TRANSPORT_MARKER, broker);
  const generated = join(workdir, "domexception.generated.js");
  const binary = join(workdir, "domexception-native");
  await writeFile(generated, wrapNativeFetchHandler(handler, prelude));
  await rm(binary, { force: true });

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
  const diffs = CASES.flatMap((c, i) =>
    got[i] === want[i] ? [] : [`${c}\n    want ${JSON.stringify(want[i])}\n    got  ${JSON.stringify(got[i])}`],
  );
  assert.deepEqual(
    diffs,
    [],
    `DOMException results differ from Bun in ${diffs.length} of ${CASES.length} cases:\n${diffs.join("\n")}`,
  );
  console.log(`Native DOMException matches Bun in all ${CASES.length} cases`);
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
