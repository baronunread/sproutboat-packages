import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// These values come from Bun WebCrypto and node:crypto, not from the runtime
// under test. A sign/verify round trip would miss a shared input corruption.
const expected = {
  rounds: [
    "e94df4f03406bc36299dd6e6961b22b50fc963fbbf8aeb773f8d7960a77e741e",
    "1321aaf34d2ad833bd0c8af3ab6c3a91f2be090fd9631538c88ec3986b6eac28",
  ],
  digest: "89273d2f70b93285bb7ddb4bcee86a5347ca7159352e3cbdd20c23e9d1e507d3",
  keyed: "ae70bbf366f791b87ae2c2642bf5bee0e7115f09ec9d15d407b8e5fb60ae933c",
  scrypt: true,
};

const handler = `
import { keyBytes } from "./crypto-helper.js";
const hex = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] + 0x100).toString(16).slice(1);
  return out;
};
export default {
  async fetch() {
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes(),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    let data = new TextEncoder().encode("h1-regression-password-0001");
    const rounds = [];
    for (let i = 0; i < 2; i++) {
      data = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
      rounds.push(hex(data));
    }
    const binary = new Uint8Array([0x00, 0x7f, 0x80, 0xff]);
    const binaryKey = await crypto.subtle.importKey(
      "raw", new Uint8Array([0x80, 0xff]), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const digest = hex(await crypto.subtle.digest("SHA-256", binary));
    const keyed = hex(await crypto.subtle.sign("HMAC", binaryKey, binary));
    const scrypt = crypto.scryptVerify(
      "café",
      binary,
      "4459ed251d645d761e6d111db6bedeb64a8e3e8a9ad2b30dce4550ae9fc35049",
      { N: 16, r: 1, p: 1 },
    );
    return Response.json({ rounds, digest, keyed, scrypt });
  },
};
`;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-crypto-"));
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  const porffor = await ensurePorffor({ cacheRoot: workdir });
  const node = Bun.which("node");
  if (!node) throw new Error("native crypto test needs node on PATH");

  const [core, broker] = await Promise.all([
    readFile(preludePath, "utf8"),
    readFile(transportPath("broker"), "utf8"),
  ]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const prelude = core.replace(TRANSPORT_MARKER, broker);
  const generated = join(workdir, "crypto.generated.js");
  const binary = join(workdir, "crypto-native");
  // This is a direct ESM import into Porffor, with no bundler in front of it.
  await writeFile(join(workdir, "crypto-helper.js"),
    "export const keyBytes = () => Uint8Array.from({ length: 16 }, (_, index) => index + 1);\n");
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
  assert(response, "compiled crypto handler did not start");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  console.log("Native crypto vectors match Bun WebCrypto and node:crypto");
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
