import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// structuredClone, Event/EventTarget and AbortController in a compiled handler,
// compared with Bun (the prelude polyfills them; found by the W2 conformance suite).
const CASES = [
  `(() => { const a = { n: 1, m: new Map([["k", new Set([1])]]), d: new Date(0), b: new Uint8Array([1, 2]) }; a.self = a; const c = structuredClone(a); return [c.self === c, c !== a, [...c.m.get("k")].join(), c.d.getTime(), c.b[1]].join(); })()`,
  `(() => { try { structuredClone(() => 1); return "no throw"; } catch (e) { return e.name; } })()`,
  `(() => { const e = structuredClone(new RangeError("x")); return e.name + ":" + e.message; })()`,
  `(() => { const t = new EventTarget(); const o = []; const f = () => o.push("f"); t.addEventListener("x", f); t.addEventListener("x", f); t.addEventListener("x", () => o.push("once"), { once: true }); t.addEventListener("x", { handleEvent() { o.push("h"); } }); t.dispatchEvent(new Event("x")); t.dispatchEvent(new Event("x")); return o.join(); })()`,
  `(() => { const t = new EventTarget(); t.addEventListener("x", (e) => e.preventDefault()); return [t.dispatchEvent(new Event("x", { cancelable: true })), t.dispatchEvent(new Event("x"))].join(); })()`,
  `new CustomEvent("c", { detail: { a: 1 } }).detail.a`,
  `(() => { const c = new AbortController(); let n = 0; c.signal.addEventListener("abort", () => n++); c.signal.onabort = () => n++; c.abort(); c.abort(); return [c.signal.aborted, c.signal.reason.name, n].join(); })()`,
  `(() => { const c = new AbortController(); const s = AbortSignal.any([c.signal, new AbortController().signal]); c.abort("y"); return s.reason; })()`,
  `(() => { try { AbortSignal.abort(new TypeError("t")).throwIfAborted(); return "no throw"; } catch (e) { return e.name; } })()`,
  `(() => { const c = new AbortController(); const t = new EventTarget(); let n = 0; t.addEventListener("x", () => n++, { signal: c.signal }); c.abort(); t.dispatchEvent(new Event("x")); return n; })()`,
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
const want = await Promise.all(CASES.map(async (c) => { try { return String(await new Function("return " + c)()); } catch (e) { return "THROWS " + (e instanceof Error ? e.message : String(e)); } }));

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-events-"));
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
  const generated = join(workdir, "events.generated.js");
  const binary = join(workdir, "events-native");
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
  assert.deepEqual(diffs, [], `Event, abort and clone results differ from Bun in ${diffs.length} of ${CASES.length} cases:\n${diffs.join("\n")}`);
  console.log(`Native events, abort and structuredClone match Bun in all ${CASES.length} cases`);
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
