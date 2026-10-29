import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// TextDecoder encodings (UTF-16LE/BE, windows-1252), Blob.stream and Response.url in a compiled handler, compared with Bun
// (found while testing third-party packages).
const CASES = [
  `new TextDecoder("utf-16le").decode(new Uint8Array([104, 0, 105, 0, 0x3d, 0xd8, 0x00, 0xde]))`,
  `new TextDecoder("utf-16be").decode(new Uint8Array([0, 104, 0, 105]))`,
  `JSON.stringify(new TextDecoder("utf-16le").decode(new Uint8Array([0xff, 0xfe, 65, 0])))`,
  `JSON.stringify(new TextDecoder("utf-16le", { ignoreBOM: true }).decode(new Uint8Array([0xff, 0xfe, 65, 0])))`,
  `JSON.stringify(new TextDecoder("utf-16le").decode(new Uint8Array([0x00, 0xd8, 65, 0])))`,
  `JSON.stringify(new TextDecoder("utf-16le").decode(new Uint8Array([65, 0, 66])))`,
  `(() => { try { new TextDecoder("utf-16le", { fatal: true }).decode(new Uint8Array([0x00, 0xd8])); return "no throw"; } catch (e) { return e.name; } })()`,
  `(() => { const d = new TextDecoder("utf-16le"); return [d.decode(new Uint8Array([104]), { stream: true }), d.decode(new Uint8Array([0, 105]), { stream: true }), d.decode(new Uint8Array([0x3d, 0xd8]), { stream: true }), d.decode(new Uint8Array([0x00, 0xde]))].join("|"); })()`,
  `new TextDecoder("windows-1252").decode(new Uint8Array([0x80, 0x41, 0xe9, 0x9f, 0xff, 0x7f]))`,
  `JSON.stringify(new TextDecoder("windows-1252").decode(new Uint8Array([0x81, 0x8d, 0x8f, 0x90, 0x9d])))`,
  `[new TextDecoder("latin1").encoding, new TextDecoder("ISO-8859-1").encoding, new TextDecoder(" ascii ").encoding, new TextDecoder("utf-16").encoding, new TextDecoder("UTF8").encoding, new TextDecoder("unicodefffe").encoding].join()`,
  `(() => { try { new TextDecoder("not-an-encoding"); return "no throw"; } catch (e) { return e.name; } })()`,
  `new TextDecoder("utf-8").decode(new Uint8Array([0xe2, 0x82, 0xac]))`,
  `new Response(new Blob(["abc", new Uint8Array([100, 101])]).stream()).text()`,
  `(async () => { const r = new Blob(["hello"]).stream().getReader(); const a = await r.read(); const b = await r.read(); return [a.done, a.value.length, b.done].join(); })()`,
  `JSON.stringify([new Response("x").url, new Response("x").redirected, new Response(null, { status: 429 }).url + "|"])`,
  `(async () => { const r = new Blob([]).stream().getReader(); const a = await r.read(); return a.done; })()`,
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

const workdir = await mkdtemp(join(tmpdir(), "sb-native-textdecoder-encodings-"));
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  const porffor = await ensurePorffor();
  const node = Bun.which("node");
  if (!node) throw new Error("native streams test needs node on PATH");

  const [core, broker] = await Promise.all([readFile(preludePath, "utf8"), readFile(transportPath("broker"), "utf8")]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const prelude = core.replace(TRANSPORT_MARKER, broker);
  const generated = join(workdir, "textdecoder-encodings.generated.js");
  const binary = join(workdir, "textdecoder-encodings-native");
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
    `TextDecoder, Blob.stream and Response.url results differ from Bun in ${diffs.length} of ${CASES.length} cases:\n${diffs.join("\n")}`,
  );
  console.log(`Native TextDecoder encodings, Blob.stream and Response.url match Bun in all ${CASES.length} cases`);
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
