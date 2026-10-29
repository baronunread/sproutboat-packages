import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// crypto.getRandomValues on wider integer views, in a compiled handler, compared with Bun. It filled only the
// low byte of each element (found while testing third-party packages).
const CASES = [
  `(() => { const b = new Uint32Array(256); crypto.getRandomValues(b); return [b.some((x) => x > 65535), b.some((x) => x > 16777215), b.length].join(); })()`,
  `(() => { const b = new Uint16Array(512); crypto.getRandomValues(b); return b.some((x) => x > 255); })()`,
  `(() => { const b = new BigUint64Array(64); crypto.getRandomValues(b); return b.some((x) => x > 4294967295n); })()`,
  `(() => { const b = new Int32Array(256); crypto.getRandomValues(b); return b.some((x) => x < 0); })()`,
  `(() => { const c = new Array(37).fill(0); const b = new Uint32Array(1); for (let i = 0; i < 3700; i++) { crypto.getRandomValues(b); c[Math.floor((b[0] / 2 ** 32) * 37)]++; } return c.filter((n) => n > 0).length > 30; })()`,
  `(() => { const buf = new Uint8Array(16); const view = new Uint32Array(buf.buffer, 4, 2); crypto.getRandomValues(view); return [buf.slice(0, 4).every((x) => x === 0), buf.slice(12).every((x) => x === 0), buf.slice(4, 12).some((x) => x > 0)].join(); })()`,
  `(() => { const b = new Uint8Array(8); return crypto.getRandomValues(b) === b; })()`,
  `(() => { try { crypto.getRandomValues(new Float32Array(2)); return "no throw"; } catch (e) { return e.name; } })()`,
  `(() => { try { crypto.getRandomValues(new DataView(new ArrayBuffer(4))); return "no throw"; } catch (e) { return e.name; } })()`,
  `(() => { try { crypto.getRandomValues([1, 2]); return "no throw"; } catch (e) { return e.name; } })()`,
  `(() => { const b = new Uint8Array(0); return crypto.getRandomValues(b).length; })()`,
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

const workdir = await mkdtemp(join(tmpdir(), "sb-native-getrandomvalues-"));
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  const porffor = await ensurePorffor();
  const node = Bun.which("node");
  if (!node) throw new Error("native streams test needs node on PATH");

  const [core, broker] = await Promise.all([readFile(preludePath, "utf8"), readFile(transportPath("broker"), "utf8")]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const prelude = core.replace(TRANSPORT_MARKER, broker);
  const generated = join(workdir, "getrandomvalues.generated.js");
  const binary = join(workdir, "getrandomvalues-native");
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
    `getRandomValues results differ from Bun in ${diffs.length} of ${CASES.length} cases:\n${diffs.join("\n")}`,
  );
  console.log(`Native getRandomValues matches Bun in all ${CASES.length} cases`);
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
