import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// Headers validates a name and trims a value in C before it falls back to the regular expression and
// the JS loops. Every kind of name and value must come out as the Fetch spec says: valid names
// lowercased, invalid ones a TypeError, values trimmed, forbidden characters refused, and a name
// that is not a plain bytestring (a wide character) still judged by the expression.
const handler = `export default {fetch(request) {
  const out = {};
  const names = ["a", "Content-Type", "X-Sb-Test", "x_y", "a.b", "a~b", "a|b", "a^b", "a+b", "a*b", "a!b", "a#b", "a$b", "a%b", "a&b", "a'b", "a-b", "9", "A9z", "",
    "a b", "a:b", "a/b", "a(b", "a@b", "a[b", "a\\u0000b", "a\\nb", "\\u00e9", "caf\\u00e9", "a\\u0100b", "a,b", "a;b", "a=b", "a?b", "a\\"b", "a\\\\b", "a<b", "a>b", "a{b", "a}b"];
  const h = new Headers();
  for (const name of names) {
    try { h.append(name, "v"); out["n:" + name] = h.has(name.toLowerCase()) ? "ok" : "stored?"; }
    catch (e) { out["n:" + name] = e instanceof TypeError ? "TypeError" : String(e); }
  }
  const values = ["plain", "", " lead", "trail ", "\\t both \\t", "\\r\\nx", "a\\u0000b", "a\\nb", "a\\rb", "in ner", "caf\\u00e9", "\\u4e2d", " \\u4e2d ", "x\\ty"];
  for (const value of values) {
    const g = new Headers();
    try { g.set("x", value); out["v:" + JSON.stringify(value)] = g.get("x"); }
    catch (e) { out["v:" + JSON.stringify(value)] = e instanceof TypeError ? "TypeError" : String(e); }
  }
  const dup = new Headers();
  dup.append("Accept", "a"); dup.append("accept", "b");
  out.dup = dup.get("ACCEPT");
  out.fromObject = new Headers({ "Content-Type": "text/plain", "X-A": " 1 " }).get("x-a");
  out.getCase = new Headers({ "x-a": "1" }).get("X-A");
  out.trigger = request.headers.get("X-Sb-Trigger");
  out.custom = request.headers.get("X-Custom");
  return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json", "X-Case": " kept " } });
}};`;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

// What the Fetch spec (and workerd) say, from the names and values above.
function expectedName(name: string): string {
  const valid = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
  return valid ? "ok" : "TypeError";
}
function expectedValue(value: string): string {
  const trimmed = value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
  return /[\0\n\r]/.test(trimmed) ? "TypeError" : trimmed;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-headers-"));
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  const porffor = await ensurePorffor();
  const node = Bun.which("node");
  if (!node) throw new Error("native headers test needs node on PATH");

  const [core, broker] = await Promise.all([readFile(preludePath, "utf8"), readFile(transportPath("broker"), "utf8")]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const prelude = core.replace(TRANSPORT_MARKER, broker);
  const generated = join(workdir, "headers.generated.js");
  const binary = join(workdir, "headers-native");
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
  let response: Response | undefined;
  for (let attempt = 0; attempt < 50 && !response; attempt++) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { "X-Custom": "custom" },
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      if (server.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  assert(response, "compiled handler did not start");
  // SAFETY: the handler above answers a flat JSON object of strings (and null), read key by key below.
  const out = (await response.json()) as Record<string, string>;
  const names = [
    "a",
    "Content-Type",
    "X-Sb-Test",
    "x_y",
    "a.b",
    "a~b",
    "a|b",
    "a^b",
    "a+b",
    "a*b",
    "a!b",
    "a#b",
    "a$b",
    "a%b",
    "a&b",
    "a'b",
    "a-b",
    "9",
    "A9z",
    "",
    "a b",
    "a:b",
    "a/b",
    "a(b",
    "a@b",
    "a[b",
    "a\u0000b",
    "a\nb",
    "é",
    "café",
    "aĀb",
    "a,b",
    "a;b",
    "a=b",
    "a?b",
    'a"b',
    "a\\b",
    "a<b",
    "a>b",
    "a{b",
    "a}b",
  ];
  for (const name of names) assert.equal(out["n:" + name], expectedName(name), `header name ${JSON.stringify(name)}`);
  const values = [
    "plain",
    "",
    " lead",
    "trail ",
    "\t both \t",
    "\r\nx",
    "a\u0000b",
    "a\nb",
    "a\rb",
    "in ner",
    "café",
    "中",
    " 中 ",
    "x\ty",
  ];
  for (const value of values)
    assert.equal(out["v:" + JSON.stringify(value)], expectedValue(value), `header value ${JSON.stringify(value)}`);
  assert.equal(out.dup, "a, b");
  assert.equal(out.fromObject, "1");
  assert.equal(out.getCase, "1");
  assert.equal(out.trigger, null);
  assert.equal(out.custom, "custom");
  assert.equal(response.headers.get("x-case"), "kept");
  console.log("Native Headers: names and values validated in C match the Fetch spec for every class of input");
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
