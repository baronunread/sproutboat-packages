import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { createBroker, listen } from "../../wire/src/broker";
import { EMPTY_BINDINGS, preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// baronunread/sproutboat#189: text read back through the broker came back as
// Latin-1 mojibake ("café" as "cafÃ©"), because the reply JSON is UTF-8 and the
// sprout holds it one char per byte. Covers 2-, 3- and 4-byte sequences on the
// two hot paths (KV, D1) and a non-ASCII SQLite error message.
const text = "/café/日本/😀/x";

// #238: the handler's own top-level \`URL\` (uuid exports one) must not replace
// the URL class the prelude extends; the handler runs in its own scope.
const handler = `
const URL = "shadowed";
export default {
  async fetch() {
    await env.KV.put("k", ${JSON.stringify(text)});
    const kv = await env.KV.get("k");
    await env.DB.prepare("CREATE TABLE t (v TEXT)").run();
    await env.DB.prepare("INSERT INTO t (v) VALUES (?)").bind(${JSON.stringify(text)}).run();
    const d1 = (await env.DB.prepare("SELECT v FROM t").first()).v;
    let error = "";
    try { await env.DB.prepare("SELECT * FROM tabellà").first(); } catch (e) { error = String(e.message); }
    return Response.json({ kv, kvLength: kv.length, d1, d1Length: d1.length, error, url: URL });
  },
};
`;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-utf8-"));
const bindings = { ...EMPTY_BINDINGS, kv: ["KV"], d1: ["DB"] };
const broker = createBroker({
  db: ":memory:",
  token: "native-utf8",
  bindings: { ...bindings, resources: {} },
});
const brokerServer = listen(broker, "127.0.0.1", 0);
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  const porffor = await ensurePorffor({ cacheRoot: workdir });
  const node = Bun.which("node");
  if (!node) throw new Error("native UTF-8 test needs node on PATH");

  const [core, transport] = await Promise.all([
    readFile(preludePath, "utf8"),
    readFile(transportPath("broker"), "utf8"),
  ]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const generated = join(workdir, "utf8.generated.js");
  const binary = join(workdir, "utf8-native");
  await writeFile(generated, wrapNativeFetchHandler(handler, core.replace(TRANSPORT_MARKER, transport), {}, bindings));

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
    env: {
      ...process.env,
      PORT: String(port),
      SB_BROKER_PORT: String(brokerServer.port),
      SB_BROKER_TOKEN: "native-utf8",
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  let response: Response | undefined;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      break;
    } catch {
      if (server.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  assert(response, "compiled UTF-8 handler did not start");
  assert.equal(response.status, 200);
  // SAFETY: the handler above is the only producer of this body and always
  // returns exactly these five fields; deepEqual below checks every one.
  const body = (await response.json()) as {
    kv: string;
    kvLength: number;
    d1: string;
    d1Length: number;
    error: string;
    url: string;
  };
  assert.deepEqual(
    { kv: body.kv, kvLength: body.kvLength, d1: body.d1, d1Length: body.d1Length },
    { kv: text, kvLength: text.length, d1: text, d1Length: text.length },
  );
  assert.match(body.error, /tabellà/);
  assert.equal(body.url, "shadowed");
  console.log("Non-ASCII KV, D1 and error text round-trip through the broker; a handler-level URL stays scoped");
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  brokerServer.stop();
  broker.close();
  await rm(workdir, { recursive: true, force: true });
}
