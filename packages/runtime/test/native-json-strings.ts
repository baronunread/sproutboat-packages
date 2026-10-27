import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// JSON.stringify of strings as the spec defines it (Bun is the reference): quotes and backslash,
// every control character, U+2028 and U+2029 (not escaped), DEL, Latin-1 and wider text, astral
// characters, and lone or misordered surrogates (escaped as \\udXXX). Each input is built from
// code units in the handler, so the compiled string has whatever layout concatenation gives it.
const units = (s: string) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const everyControl = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)).join("");
const INPUTS: string[] = [
  "",
  "abc",
  'a"b\\c"',
  everyControl,
  "x" + everyControl + "y",
  "\u007f\u0080\u00ff",
  "caf\u00e9",
  "line\u2028sep\u2029end",
  "\u0100",
  "\u4e1c\u4eac",
  "x\u{1F680}y",
  "\u{1F680}".repeat(40),
  "\ud800",
  "\udc00",
  "\ud800x",
  "x\udc00",
  "\udc00\ud800",
  "\ud800\ud800\udc00",
  "a\ud83dz",
  "\ud83d\ude80\ud83d",
  "tab\there\nnewline\r\f\b",
  "plain ascii text that is long enough to run the loop for a while. ".repeat(60),
  'mix \u00e9\u4e1c\u{1F680}"\\\n\ud800 '.repeat(50),
];
const handler = `export default {fetch() {
  const inputs = ${JSON.stringify(INPUTS.map(units))};
  const out = [];
  for (let n = 0; n < inputs.length; n++) {
    let s = "";
    for (let i = 0; i < inputs[n].length; i++) s += String.fromCharCode(inputs[n][i]);
    out.push(JSON.stringify(s));
    out.push(JSON.stringify({ [s]: s, list: [s, 1, null], nested: { k: s } }));
  }
  return new Response(out.join("\\u0001"));
}};`;
const want = INPUTS.flatMap((s) => [
  JSON.stringify(s),
  JSON.stringify({ [s]: s, list: [s, 1, null], nested: { k: s } }),
]);
function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-json-strings-"));
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  const porffor = await ensurePorffor();
  const node = Bun.which("node");
  if (!node) throw new Error("native streams test needs node on PATH");

  const [core, broker] = await Promise.all([readFile(preludePath, "utf8"), readFile(transportPath("broker"), "utf8")]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const prelude = core.replace(TRANSPORT_MARKER, broker);
  const generated = join(workdir, "json-strings.generated.js");
  const binary = join(workdir, "json-strings-native");
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
  const got = (await (await fetch(`http://127.0.0.1:${port}/`)).text()).split("\u0001");
  assert.equal(got.length, want.length, "one result per case");
  const diffs = want.flatMap((w, i) =>
    got[i] === w
      ? []
      : [
          `case ${i >> 1} (${i & 1 ? "object" : "string"})\n    want ${w.slice(0, 200)}\n    got  ${got[i].slice(0, 200)}`,
        ],
  );
  assert.deepEqual(
    diffs,
    [],
    `JSON.stringify differs from the spec in ${diffs.length} of ${want.length} cases:\n${diffs.join("\n")}`,
  );
  console.log(`Native JSON.stringify of strings is byte-identical to the spec in all ${want.length} cases`);
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
