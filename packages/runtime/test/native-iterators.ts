import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

const expected = {
  query: [["a", "1"], ["a", "2"], ["b", "3"]],
  keys: ["a", "a", "b"], values: ["1", "2", "3"],
  live: ["x", "y", true], form: [["x", "1"], ["x", "2"]],
  formLive: ["x", "y", true], self: true,
};
const handler = `export default { fetch(request) {
  if (new URL(request.url).pathname === "/null") return new Response(null);
  const params = new URLSearchParams("a=1&a=2&b=3");
  const query = [];
  for (const pair of params) query.push(pair);
  const liveParams = new URLSearchParams("x=1");
  const iterator = liveParams.keys();
  const first = iterator.next().value;
  liveParams.append("y", "2");
  const second = iterator.next().value;
  const done = iterator.next().done;
  const fd = new FormData(); fd.append("x", "1"); fd.append("x", "2");
  const form = []; for (const pair of fd) form.push(pair);
  const liveForm = new FormData(); liveForm.append("x", "1");
  const formIterator = liveForm.keys(); const f1 = formIterator.next().value;
  liveForm.append("y", "2"); const f2 = formIterator.next().value;
  return Response.json({ query, keys: Array.from(params.keys()), values: Array.from(params.values()),
    live: [first, second, done], form, formLive: [f1, f2, formIterator.next().done],
    self: iterator[Symbol.iterator]() === iterator });
} };`;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-iterators-"));
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  const porffor = await ensurePorffor({ cacheRoot: workdir });
  const node = Bun.which("node");
  if (!node) throw new Error("native iterators test needs node on PATH");

  const [core, broker] = await Promise.all([
    readFile(preludePath, "utf8"),
    readFile(transportPath("broker"), "utf8"),
  ]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const prelude = core.replace(TRANSPORT_MARKER, broker);
  const generated = join(workdir, "iterators.generated.js");
  const binary = join(workdir, "iterators-native");
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
  let response: Response | undefined;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
      break;
    } catch {
      if (server.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  assert(response, "compiled iterators handler did not start");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  const empty = await fetch(`http://127.0.0.1:${port}/null`);
  assert.equal(empty.status, 200);
  assert.equal(await empty.text(), "");
  console.log("Native Web API iterators preserve entries, duplicate keys and live mutations");
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
