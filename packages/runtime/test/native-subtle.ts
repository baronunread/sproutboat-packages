import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readdirSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { jsonObject, parseJsonValue, type JsonObject, type JsonValue } from "../../wire/src/json";
import { SUBTLE_DATE } from "../src/subtle-date";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// The date gate and the parts of crypto.subtle that need no native half (the broker transport has
// none): HMAC, digest, JWK for symmetric keys, and every error's DOMException name, against what
// workerd answers for the same calls. The RSA/ECDSA/Ed25519/AES paths run in the embedded
// transport and are covered by src/subtle/subtle.test.ts (C against BoringSSL) and the
// conformance run in the PR description.
const handler = `
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function t(f) {
  try { return await f(); } catch (e) { return "ERR " + e.name + (e instanceof DOMException ? " dom" : ""); }
}
const raw = new Uint8Array(32).fill(7);
const hmac = { name: "HMAC", hash: "SHA-256" };
export default {
  async fetch() {
    const s = crypto.subtle;
    const out = {};
    out.jwkImport = await t(async () => {
      const k = await s.importKey("jwk", { kty: "oct", k: "AAECAwQFBgc", alg: "HS256", ext: true }, hmac, true, ["sign"]);
      return [k.algorithm.length, k.type, k.usages, hex(await s.exportKey("raw", k))];
    });
    out.jwkExport = await t(async () => {
      const k = await s.importKey("raw", raw, hmac, true, ["sign", "verify"]);
      const j = await s.exportKey("jwk", k);
      return [j.kty, j.alg, j.k, j.key_ops, j.ext];
    });
    out.badFormat = await t(() => s.importKey("foo", raw, hmac, true, ["sign"]));
    out.badUsage = await t(() => s.importKey("raw", raw, hmac, true, ["encrypt"]));
    out.empty = await t(() => s.importKey("raw", new Uint8Array(0), hmac, true, ["sign"]));
    out.noHash = await t(() => s.importKey("raw", raw, { name: "HMAC" }, true, ["sign"]));
    out.unknown = await t(() => s.digest("FOO", raw));
    out.nonExtractable = await t(async () => s.exportKey("raw", await s.importKey("raw", raw, hmac, false, ["sign"])));
    out.wrongUsage = await t(async () => s.sign("HMAC", await s.importKey("raw", raw, hmac, true, ["verify"]), raw));
    out.wrongAlgorithm = await t(async () => s.sign("ECDSA", await s.importKey("raw", raw, hmac, true, ["sign"]), raw));
    out.stringData = await t(async () => s.sign("HMAC", await s.importKey("raw", raw, hmac, true, ["sign"]), "abc"));
    out.badJwkAlg = await t(() => s.importKey("jwk", { kty: "oct", k: "AAECAwQFBgc", alg: "HS384" }, hmac, true, ["sign"]));
    out.badJwkKty = await t(() => s.importKey("jwk", { kty: "RSA", k: "AAECAwQFBgc" }, hmac, true, ["sign"]));
    out.badJwkB64 = await t(() => s.importKey("jwk", { kty: "oct", k: "!!!" }, hmac, true, ["sign"]));
    out.extFalse = await t(() => s.importKey("jwk", { kty: "oct", k: "AAECAwQFBgc", ext: false }, hmac, true, ["sign"]));
    out.signVerify = await t(async () => {
      const k = await s.importKey("raw", raw, { name: "HMAC", hash: "SHA-512" }, false, ["sign", "verify"]);
      const sig = await s.sign("HMAC", k, raw);
      return [sig.byteLength, await s.verify("HMAC", k, sig, raw), await s.verify("HMAC", k, sig, new Uint8Array(3))];
    });
    out.digests = await t(async () => [hex(await s.digest("SHA-1", raw)), hex(await s.digest({ name: "sha-256" }, raw)), hex(await s.digest("MD5", raw))]);
    out.tse = await t(() => [s.timingSafeEqual(raw, raw), s.timingSafeEqual(raw, new Uint8Array(32))]);
    out.tseLength = await t(() => s.timingSafeEqual(raw, new Uint8Array(3)));
    out.isKey = await t(async () => { const k = await s.importKey("raw", raw, hmac, true, ["sign"]); return [k instanceof CryptoKey, Object.keys(k)]; });
    // The native half is in the prelude on every transport.
    out.needsNative = await t(async () => { const k = await s.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]); const sig = await s.sign({ name: "ECDSA", hash: "SHA-256" }, k.privateKey, raw); return await s.verify({ name: "ECDSA", hash: "SHA-256" }, k.publicKey, sig, raw); });
    out.unsupportedCurve = await t(() => s.generateKey({ name: "ECDSA", namedCurve: "secp256k1" }, true, ["sign"]));
    return Response.json(out);
  },
};`;

const dom = " dom";
const expectedNew: JsonObject = {
  jwkImport: [64, "secret", ["sign"], "0001020304050607"],
  jwkExport: ["oct", "HS256", "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc", ["sign", "verify"], true],
  badFormat: "ERR NotSupportedError" + dom,
  badUsage: "ERR SyntaxError" + dom,
  empty: "ERR DataError" + dom,
  noHash: "ERR TypeError",
  unknown: "ERR NotSupportedError" + dom,
  nonExtractable: "ERR InvalidAccessError" + dom,
  wrongUsage: "ERR InvalidAccessError" + dom,
  wrongAlgorithm: "ERR InvalidAccessError" + dom,
  stringData: "ERR TypeError",
  badJwkAlg: "ERR DataError" + dom,
  badJwkKty: "ERR DataError" + dom,
  badJwkB64: "ERR DataError" + dom,
  extFalse: "ERR DataError" + dom,
  signVerify: [64, true, false],
  digests: [],
  tse: [true, false],
  tseLength: "ERR TypeError",
  isKey: [true, ["usages", "algorithm", "extractable", "type"]],
  needsNative: true,
  unsupportedCurve: "ERR NotSupportedError" + dom,
};
// The digests are checked against Bun, not typed in.
const bunHex = async (algo: string, data: Uint8Array) =>
  Buffer.from(await crypto.subtle.digest(algo, data)).toString("hex");
const rawBytes = new Uint8Array(32).fill(7);
const digests: JsonValue[] = [
  await bunHex("SHA-1", rawBytes),
  await bunHex("SHA-256", rawBytes),
  Buffer.from(new Bun.CryptoHasher("md5").update(rawBytes).digest()).toString("hex"),
];
expectedNew.digests = digests;

// The prelude carries the native half on every transport now, so a compile that reaches it needs
// BearSSL on the include path and link line, as the CLI arranges. Use the CLI cache; skip without it.
const bearssl = join(process.env.SPROUTBOAT_TOOLCHAIN_CACHE ?? join(homedir(), ".cache/sproutboat"), "bearssl-0.6");
const objects = join(bearssl, "obj-host");
if (!existsSync(objects)) {
  console.log("crypto.subtle native test skipped: no BearSSL in the CLI cache (a standalone build creates it)");
  process.exit(0);
}
const bearsslEnv = {
  SB_EXTRA_CFLAGS: `-I ${join(bearssl, "bearssl-0.6/inc")}`,
  SB_EXTRA_LINK: readdirSync(objects)
    .filter((name) => name.endsWith(".o") && name !== "trust-anchors.o")
    .map((name) => join(objects, name))
    .join(" "),
};

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

async function run(date: string): Promise<JsonObject> {
  const workdir = await mkdtemp(join(tmpdir(), "sb-native-subtle-"));
  let server: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const porffor = await ensurePorffor();
    const node = Bun.which("node");
    if (!node) throw new Error("native subtle test needs node on PATH");
    const [core, broker] = await Promise.all([
      readFile(preludePath, "utf8"),
      readFile(transportPath("broker"), "utf8"),
    ]);
    assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
    const generated = join(workdir, "subtle.generated.js");
    const binary = join(workdir, "subtle-native");
    await writeFile(
      generated,
      wrapNativeFetchHandler(handler, core.replace(TRANSPORT_MARKER, broker), undefined, undefined, undefined, date),
    );
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
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
        assert.equal(response.status, 200);
        const body = jsonObject(parseJsonValue(await response.text()));
        assert(body, "the handler returns a JSON object");
        return body;
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error;
        if (server.exitCode !== null) break;
        await Bun.sleep(100);
      }
    }
    throw new Error(`compiled handler did not start (${date})`);
  } finally {
    if (server) {
      server.kill(9);
      await server.exited;
    }
    await rm(workdir, { recursive: true, force: true });
  }
}

const prelude = await readFile(preludePath, "utf8");
assert(prelude.includes(`const __SB_SUBTLE_DATE = "${SUBTLE_DATE}";`), "SUBTLE_DATE and __SB_SUBTLE_DATE differ");
const [before, after] = await Promise.all([
  run(new Date(Date.parse(SUBTLE_DATE) - 86_400_000).toISOString().slice(0, 10)),
  run(SUBTLE_DATE),
]);
assert.deepEqual(after, expectedNew, "from the new date crypto.subtle answers as workerd does");
// Before the date nothing changed: the old subset, its plain-object keys and its errors.
assert.equal(before.jwkImport, "ERR NotSupportedError", "before the date, jwk import is not supported");
assert.equal(before.needsNative, "ERR NotSupportedError", "before the date, ECDSA is not supported");
assert.deepEqual(before.signVerify, [64, true, false]);
console.log("crypto.subtle: the date gate and the transport-independent surface match workerd");
