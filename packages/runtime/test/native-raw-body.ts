import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import {
  preludePath,
  TRANSPORT_MARKER,
  transportPath,
  wrapNativeFetchHandler,
} from "../src/wrap";

// fetch() hands a response's bytes back as a raw body (x-sb-raw-body, #176), and
// they can arrive as a UTF-16 string holding one byte per unit: JSON.parse of the
// transport's reply makes one. Returning that response unchanged must send the bytes.
const handler = `export default {fetch() {
  const bytes = JSON.parse('"caf\\u00e9 \\u00ff ok"');
  return new Response(bytes, { headers: { "x-sb-raw-body": "1", "content-type": "application/octet-stream" } });
}};`;
const want = [0x63, 0x61, 0x66, 0xe9, 0x20, 0xff, 0x20, 0x6f, 0x6b];

function freePort(): number {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-raw-body-"));
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  const porffor = await ensurePorffor();
  const node = Bun.which("node");
  if (!node) throw new Error("native streams test needs node on PATH");

  const [core, broker] = await Promise.all([
    readFile(preludePath, "utf8"),
    readFile(transportPath("broker"), "utf8"),
  ]);
  assert(
    core.includes(TRANSPORT_MARKER),
    "runtime prelude is missing its transport marker",
  );
  const prelude = core.replace(TRANSPORT_MARKER, broker);
  const generated = join(workdir, "raw.generated.js");
  const binary = join(workdir, "raw-native");
  await writeFile(generated, wrapNativeFetchHandler(handler, prelude));
  await rm(binary, { force: true });

  const compile = Bun.spawn(
    [
      node,
      resolve(porffor, "runtime/index.js"),
      "native",
      generated,
      "-o",
      binary,
      "-s",
      "-O0",
    ],
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
  assert.equal(
    exitCode,
    0,
    `Porffor native compile failed:\n${stderr}\n${stdout}`,
  );

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
      await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(500),
      });
      ready = true;
    } catch {
      if (server.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  assert(ready, "compiled handler did not start");
  const response = await fetch(`http://127.0.0.1:${port}/`);
  const got = [...new Uint8Array(await response.arrayBuffer())];
  assert.deepEqual(got, want, "raw body bytes");
  assert.equal(
    response.headers.get("x-sb-raw-body"),
    null,
    "the marker never reaches the client",
  );
  console.log("A raw UTF-16 body is sent as its bytes");
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
