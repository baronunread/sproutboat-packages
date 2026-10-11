import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

const expected = Array.from({length:10}, (_,length) => {
  const bytes=Uint8Array.from({length}, (_,i) => (i*71+251)%256);
  const padded=Buffer.from(bytes).toString("base64");
  return {padded,url:padded.replaceAll("+","-").replaceAll("/","_").replace(/=+$/, ""),decoded:Array.from(bytes)};
});
const handler = `export default {fetch() {
  const rows=[];
  for(let length=0;length<10;length++) {
    const bytes=new Uint8Array(length);for(let i=0;i<length;i++)bytes[i]=(i*71+251)%256;
    const padded=bytes.toBase64();const url=bytes.toBase64({alphabet:"base64url",omitPadding:true});
    const decoded=Array.from(Uint8Array.fromBase64(url,{alphabet:"base64url"}));
    rows.push({padded,url,decoded});
  }
  return Response.json(rows);
}};`;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-base64-"));
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
  const generated = join(workdir, "base64.generated.js");
  const binary = join(workdir, "base64-native");
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
  console.log("Native base64 and base64url round-trip zero to nine bytes with correct padding");
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
