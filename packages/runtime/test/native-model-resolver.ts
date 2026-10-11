import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

const expected = {a: "user", b: "account", again: "user", plural: "user", custom: "user"};
const handler = `
const makeResolver = ({usePlural, schema}) => {
  return (model) => {
    const resolve = (candidate) => {
      if (schema[candidate]) return candidate;
      return Object.entries(schema).find((entry) => entry[1].modelName === candidate)?.[0];
    };
    if (usePlural && model.endsWith("s")) {
      const m = resolve(model.slice(0, -1));
      if (m) return m;
    }
    const m = resolve(model);
    if (!m) throw new Error("Missing model");
    return m;
  };
};
export default {fetch() {
  const schema = {user:{modelName:"user"},session:{modelName:"session"}};
  const a = makeResolver({schema,usePlural:false});
  const b = makeResolver({schema:{account:{modelName:"account"}},usePlural:false});
  return Response.json({a:a("user"),b:b("account"),again:a("user"),
    plural:makeResolver({schema,usePlural:true})("users"),
    custom:makeResolver({schema:{user:{modelName:"members"}},usePlural:false})("members")});
}};`;


function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-model-resolver-"));
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
  const generated = join(workdir, "model-resolver.generated.js");
  const binary = join(workdir, "model-resolver-native");
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
  assert(response, "compiled streams handler did not start");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  console.log("Native model resolvers preserve lexical function types, plural aliases and schema names");
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
