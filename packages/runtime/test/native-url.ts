import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// URL as WHATWG defines it (Bun's URL is the reference): base URLs, setters on every
// part, hash, default ports, dot segments, percent-encoding, and searchParams writing
// back into the URL. Each case is an expression over U, the URL class under test.
const CASES = [
  `new U("https://Example.COM:443/a/./b/../c?x=1#frag").href`,
  `new U("http://example.com:80").href`,
  `new U("http://example.com:8080/p").host`,
  `new U("/path?q=1", "https://a.com/base/x").href`,
  `new U("rel", "https://a.com/base/x").href`,
  `new U("../up", "https://a.com/a/b/c").href`,
  `new U("?q", "https://a.com/p?old#h").href`,
  `new U("#h2", "https://a.com/p?old#h").href`,
  `new U("//other.com/x", "https://a.com/").href`,
  `new U("./", "https://a.com/a/b").href`,
  `new U("..", "https://a.com/a/b/").href`,
  `new U("x", new U("https://a.com/d/")).href`,
  `(() => { const u = new U("https://foo.example.com/api.js"); u.hostname = "example.com"; return u.href; })()`,
  `(() => { const u = new U("https://a.com/"); u.port = "8080"; return u.href; })()`,
  `(() => { const u = new U("https://a.com:8080/"); u.port = "443"; return u.href; })()`,
  `(() => { const u = new U("https://a.com:8080/"); u.port = ""; return u.href; })()`,
  `(() => { const u = new U("https://a.com/x"); u.protocol = "http"; return u.href; })()`,
  `(() => { const u = new U("https://a.com/x"); u.protocol = "http:"; u.port = "80"; return u.href; })()`,
  `(() => { const u = new U("https://a.com/x"); u.host = "b.com:9"; return u.href; })()`,
  `(() => { const u = new U("https://a.com/x"); u.search = "a=1&b=2"; return u.href; })()`,
  `(() => { const u = new U("https://a.com/x?a=1"); u.search = ""; return u.href; })()`,
  `(() => { const u = new U("https://a.com/x"); u.hash = "top"; return u.href + " " + u.hash; })()`,
  `(() => { const u = new U("https://a.com/x#top"); u.hash = ""; return u.href; })()`,
  `(() => { const u = new U("https://a.com/x"); u.pathname = "new path"; return u.href; })()`,
  `(() => { const u = new U("https://a.com/x?a=1"); u.searchParams.set("b", "two words"); return u.href; })()`,
  `(() => { const u = new U("https://a.com/x?a=1&a=2"); u.searchParams.delete("a"); return u.href; })()`,
  `(() => { const u = new U("https://a.com/x?b=2&a=1"); u.searchParams.sort(); return u.href; })()`,
  `(() => { const u = new U("https://a.com/x?a=1"); const p = u.searchParams; u.search = "?z=9"; return p.get("z") + " " + p.get("a"); })()`,
  `(() => { const u = new U("https://a.com/x"); u.searchParams.append("q", "a+b&c=d!'()~*"); return u.search; })()`,
  `new U("https://a.com/x?a=1").searchParams.get("a")`,
  `new U("http://u:p@h.com/").username + " " + new U("http://u:p@h.com/").password`,
  `new U("http://u:p@h.com/").href`,
  `new U("https://a.com/p").origin`,
  `new U("http://[::1]:8080/").hostname + " " + new U("http://[::1]:8080/").port`,
  `new U("http://[::1]:8080/").host`,
  `U.canParse("nope") + " " + U.canParse("https://a.com") + " " + U.canParse("/x", "https://a.com")`,
  `(() => { try { new U("nope"); return "no throw"; } catch (e) { return e instanceof TypeError; } })()`,
  `(() => { try { new U("https://"); return "no throw"; } catch (e) { return e instanceof TypeError; } })()`,
  `JSON.stringify({ u: new U("https://a.com") })`,
  `new U("https://a.com").pathname`,
  `new U("mailto:x@y.com").pathname + " " + new U("mailto:x@y.com").protocol + " " + new U("mailto:x@y.com").origin`,
  `String(new U("https://a.com/a b"))`,
  `new U("https://a.com/é?q=ü#ä").href`,
  `new U("https://a.com/x?q=it's").search`,
  `new U("HTTPS://A.COM/X").href`,
  `new U("https://a.com?").href`,
  `new U("https://a.com#").href`,
  `new U("https://a.com/%2e/x").pathname`,
  `(() => { const u = new U("https://a.com/x"); u.href = "http://b.com/y?z"; return u.host + " " + u.pathname + " " + u.search; })()`,
  `new U("https://a.com/x?a=1#f").toString()`,
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

const workdir = await mkdtemp(join(tmpdir(), "sb-native-url-"));
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
  const generated = join(workdir, "url.generated.js");
  const binary = join(workdir, "url-native");
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
  assert.deepEqual(diffs, [], `URL differs from WHATWG in ${diffs.length} of ${CASES.length} cases:\n${diffs.join("\n")}`);
  console.log(`Native URL matches WHATWG URL in all ${CASES.length} cases: base URLs, setters, hash, ports, dot segments, encoding, searchParams`);
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
