import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// JSON.stringify as the spec defines it (Bun is the reference): toJSON on Date, URL and
// user objects, nested and in arrays, and a toJSON that returns undefined.
const CASES = [
  `JSON.stringify({ at: new Date(0) })`,
  `JSON.stringify([new Date(86400000), 1])`,
  `JSON.stringify(new Date(1700000000000))`,
  `JSON.stringify({ u: new U("https://a.com/x?y=1") })`,
  `JSON.stringify({ a: { toJSON() { return { b: 2 }; } } })`,
  `JSON.stringify({ a: 1, gone: { toJSON() { return undefined; } } })`,
  `JSON.stringify({ n: { toJSON() { return 42; } } })`,
  `JSON.stringify({ nested: { at: new Date(0), list: [new Date(0)] } })`,
  `JSON.stringify({ plain: { x: 1 } })`,
  // The reviver: children first, undefined deletes, `this` is the holder, arrays by index.
  `JSON.stringify(JSON.parse('{"a":1,"b":{"c":2}}', (k, v) => (typeof v === "number" ? v * 10 : v)))`,
  `JSON.stringify(JSON.parse('{"a":1,"drop":2,"l":[1,2,3]}', (k, v) => (k === "drop" ? undefined : v)))`,
  `JSON.stringify(JSON.parse('[5,6]', function (k, v) { return k === "" ? v : k + ":" + v + ":" + Array.isArray(this); }))`,
  `JSON.stringify(JSON.parse('{"x":1}', (k, v) => (k === "" ? "root:" + typeof v : v)))`,
];
const handler = `export default {fetch() {
  const U = URL;
  const cases = [
${CASES.map((c) => `    () => (${c}),`).join("\n")}
  ];
  const out = [];
  for (const run of cases) {
    try { out.push(String(run())); } catch (e) { out.push("THROWS " + (e && e.message)); }
  }
  return new Response(JSON.stringify(out));
}};`;
const want = CASES.map((c) => String(new Function("U", "return " + c)(URL)));

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-json-"));
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
  const generated = join(workdir, "json.generated.js");
  const binary = join(workdir, "json-native");
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
  assert.deepEqual(diffs, [], `JSON.stringify differs from the spec in ${diffs.length} of ${CASES.length} cases:\n${diffs.join("\n")}`);
  console.log(`Native JSON.stringify honours toJSON in all ${CASES.length} cases: Date, URL, user objects, nested, undefined`);
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
