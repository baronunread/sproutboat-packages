import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// Web API behaviour the W2 conformance suite found wrong, compared with Bun: Headers
// (combined get, sorted iteration, getSetCookie, trimming, validation), TextDecoder (astral,
// replacement, fatal, BOM, stream), URLSearchParams init forms, atob/btoa checks, Unicode
// case mapping, queueMicrotask and IDN hosts.
const CASES = [
  `(() => { const h = new Headers(); h.append("B", " 2 "); h.append("a", "1"); h.append("a", "x"); return [h.get("a"), [...h].map((p) => p.join("=")).join(";")].join("|"); })()`,
  `(() => { const h = new Headers(); h.append("set-cookie", "a=1"); h.append("set-cookie", "b=2"); return [h.getSetCookie().join("+"), [...h].length].join("|"); })()`,
  `(() => { try { new Headers({ "bad name": "1" }); return "no throw"; } catch (e) { return e.name; } })()`,
  `(() => { try { new Headers({ a: "x\\ny" }); return "no throw"; } catch (e) { return e.name; } })()`,
  `new TextDecoder().decode(new Uint8Array([0x61, 0xf0, 0x9f, 0x98, 0x80, 0xff, 0x62]))`,
  `(() => { try { new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xc3])); return "no throw"; } catch (e) { return e.name; } })()`,
  `(() => { const d = new TextDecoder(); return d.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0xe2, 0x82]), { stream: true }) + d.decode(new Uint8Array([0xac])); })()`,
  `[new URLSearchParams({ a: "1", b: "x y" }).toString(), new URLSearchParams([["c", "3"]]).toString(), new URLSearchParams(new URLSearchParams("d=4")).toString()].join("|")`,
  `(() => { try { atob("@@"); return "no throw"; } catch (e) { return e.name + ":" + atob(" aGVs bG8= "); } })()`,
  `(() => { try { btoa("€"); return "no throw"; } catch (e) { return e.name; } })()`,
  `["ÄÖÜ", "ΑΒΓ", "дж", "Ā", "Ωmega"].map((s) => s.toLowerCase() + s.toUpperCase()).join(",")`,
  `new Promise((resolve) => { const o = []; setTimeout(() => o.push("t"), 0); queueMicrotask(() => o.push("m")); setTimeout(() => resolve(o.join()), 50); })`,
  `new URL("http://münchen.test/x").host`,
  `crypto.subtle.digest("SHA-1", new TextEncoder().encode("abc")).then((b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join(""))`,
  `crypto.subtle.importKey("raw", new TextEncoder().encode("key"), { name: "HMAC", hash: "SHA-1" }, true, ["sign"]).then(async (k) => [k.algorithm.hash.name, k.algorithm.length, Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("msg"))), (x) => x.toString(16).padStart(2, "0")).join(""), new Uint8Array(await crypto.subtle.exportKey("raw", k)).length].join())`,
  `crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-512" }, true, ["sign"]).then(async (k) => [k.type, k.algorithm.length, (await crypto.subtle.exportKey("raw", k)).byteLength].join())`,
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

const workdir = await mkdtemp(join(tmpdir(), "sb-native-web-apis-"));
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
  const generated = join(workdir, "web-apis.generated.js");
  const binary = join(workdir, "web-apis-native");
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
  assert.deepEqual(diffs, [], `Web API results differ from Bun in ${diffs.length} of ${CASES.length} cases:\n${diffs.join("\n")}`);
  console.log(`Native Web APIs match Bun in all ${CASES.length} cases`);
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
