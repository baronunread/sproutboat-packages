import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// sproutd #22: __sbFromUtf8 and __sbToBytes run in C (__sbFromUtf8Native, __sbToBytesNative).
// They must give exactly what the JS loops gave, and a body of megabytes must not take
// hundreds of megabytes of heap (the JS made one string per character: a 5 MiB R2 object
// read with text() took about 400 MiB).
const handler = `const bytes = (list) => { let s = ""; for (const b of list) s += String.fromCharCode(b); return s; };
const codes = (s) => { const out = []; for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); return out; };
export default {fetch(request) {
  if (new URL(request.url).pathname === "/big") {
    const text = __sbFromUtf8("\\u00c3\\u00a9".repeat(4 * 1024 * 1024));
    const utf8 = __sbToBytes("\\u2713".repeat(1024 * 1024));
    const ascii = __sbToBytes("a".repeat(8 * 1024 * 1024));
    return new Response(JSON.stringify([text.length, text.charCodeAt(0), utf8.length, utf8.charCodeAt(2), ascii.length]));
  }
  const decode = [
    "hello", bytes([0x63, 0x61, 0x66, 0xc3, 0xa9, 0x20, 0xf0, 0x9f, 0x8c, 0xb1, 0x20, 0xe2, 0x9c, 0x93]),
    bytes([0xc2]), bytes([0xe9, 0x41]), bytes([0xf0, 0x9f, 0x8c]), bytes([0xe2, 0x28, 0xa1]), bytes([0xc0, 0x80]),
    bytes([0xf8, 0x88, 0x80, 0x80, 0x80]), bytes([0xed, 0xa0, 0x80]), bytes([0xf4, 0x90, 0x80, 0x80]), bytes([0xff, 0xfe, 0x00]),
    JSON.parse('"caf\\\\u00c3\\\\u00a9 \\\\u0100"'), JSON.parse('"\\\\u00e2\\\\u009c\\\\u0093"'), "",
  ];
  const encode = [
    "hello", "caf\\u00e9", "\\u2713 \\ud83c\\udf31", "\\ud800x", "\\udc00", "a\\ud800", "\\u0100\\u07ff\\u0800\\uffff", "",
    new Uint8Array([0, 255, 128]), new Uint8Array([1, 2, 3]).buffer, new Uint8Array(new Uint8Array([9, 8, 7, 6]).buffer, 1, 2), new Uint8Array(0),
  ];
  return new Response(JSON.stringify({ decode: decode.map((s) => codes(__sbFromUtf8(s))), encode: encode.map((v) => codes(__sbToBytes(v))) }));
}};`;

// The JS the C replaces, lifted from the prelude with the C stubbed out, as the reference.
const core = await readFile(preludePath, "utf8");
const lift = (from: string, to: string) => {
  const start = core.indexOf(from);
  const end = core.indexOf(to, start);
  assert(start >= 0 && end > start, `${from} block not found in prelude`);
  return core.slice(start, end);
};
// oxlint-disable-next-line no-function-constructor -- lifting pure blocks out of the text-only prelude for the reference
const reference = new Function(
  `function __sbFromUtf8Native() { return ""; }\nfunction __sbToBytesNative() { return ""; }\n` +
    lift("function __sbIsStr(", "function __sbIsFn(") +
    lift("const __SB_BYTES_WINDOW", "function __sbBufFrom(") +
    lift("function __sbFromUtf8(", "// sproutboat #181") +
    "return { __sbFromUtf8, __sbToBytes };",
)();
const bytes = (list: number[]) => String.fromCharCode(...list);
const codes = (s: string) => [...s].flatMap((c) => [...Array(c.length).keys()].map((i) => c.charCodeAt(i)));
const want = {
  decode: [
    "hello",
    bytes([0x63, 0x61, 0x66, 0xc3, 0xa9, 0x20, 0xf0, 0x9f, 0x8c, 0xb1, 0x20, 0xe2, 0x9c, 0x93]),
    bytes([0xc2]),
    bytes([0xe9, 0x41]),
    bytes([0xf0, 0x9f, 0x8c]),
    bytes([0xe2, 0x28, 0xa1]),
    bytes([0xc0, 0x80]),
    bytes([0xf8, 0x88, 0x80, 0x80, 0x80]),
    bytes([0xed, 0xa0, 0x80]),
    bytes([0xf4, 0x90, 0x80, 0x80]),
    bytes([0xff, 0xfe, 0x00]),
    "cafÃ© Ā",
    "â\u009c\u0093",
    "",
  ].map((s) => codes(reference.__sbFromUtf8(s))),
  encode: [
    "hello",
    "café",
    "✓ 🌱",
    "\ud800x",
    "\udc00",
    "a\ud800",
    "Ā߿ࠀ￿",
    "",
    new Uint8Array([0, 255, 128]),
    new Uint8Array([1, 2, 3]).buffer,
    new Uint8Array(new Uint8Array([9, 8, 7, 6]).buffer, 1, 2),
    new Uint8Array(0),
  ].map((v) => codes(reference.__sbToBytes(v))),
};

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-byte-text-"));
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  const porffor = await ensurePorffor();
  const node = Bun.which("node");
  if (!node) throw new Error("native byte-text test needs node on PATH");
  const broker = await readFile(transportPath("broker"), "utf8");
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const generated = join(workdir, "bytes.generated.js");
  const binary = join(workdir, "bytes-native");
  await writeFile(generated, wrapNativeFetchHandler(handler, core.replace(TRANSPORT_MARKER, broker)));
  const compile = Bun.spawn(
    [node, resolve(porffor, "runtime/index.js"), "native", generated, "-o", binary, "-s", "-O0"],
    {
      cwd: workdir,
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
  // Peak RSS: /proc's high-water mark on Linux, time(1) on macOS.
  const linux = process.platform === "linux";
  server = Bun.spawn(linux ? [binary] : ["/usr/bin/time", "-l", binary], {
    cwd: workdir,
    env: { ...process.env, PORT: String(port) },
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
  assert(ready, "compiled handler did not start");
  const got = await (await fetch(`http://127.0.0.1:${port}/`)).json();
  assert.deepEqual(got.decode, want.decode, "__sbFromUtf8 in C decodes as the JS did");
  assert.deepEqual(got.encode, want.encode, "__sbToBytes in C encodes as the JS did");
  console.log("C byte/text conversions match the JS ones");

  const big = await (await fetch(`http://127.0.0.1:${port}/big`)).json();
  assert.deepEqual(big, [4 * 1024 * 1024, 0xe9, 3 * 1024 * 1024, 0x93, 8 * 1024 * 1024]);
  let peak = 0;
  if (linux) {
    const status = await readFile(`/proc/${server.pid}/status`, "utf8");
    peak = Number(/VmHWM:\s+(\d+) kB/.exec(status)?.[1] ?? 0) * 1024;
  }
  server.kill("SIGINT");
  const timing = linux ? "" : await new Response(server.stderr).text();
  await server.exited;
  server = undefined;
  if (!linux) peak = Number(/(\d+)\s+maximum resident set size/.exec(timing)?.[1] ?? 0);
  assert(peak > 0, "peak RSS was measured");
  // The JS took over 600 MiB for these; the C needs the strings plus one scratch copy.
  assert(peak < 96 * 1024 * 1024, `8 MiB conversions peaked at ${(peak / 1048576).toFixed(1)} MiB`);
  console.log(`8 MiB conversions peak at ${(peak / 1048576).toFixed(1)} MiB RSS`);
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
