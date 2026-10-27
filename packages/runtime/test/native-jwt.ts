import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// The pieces of a JWT check (base64url decode, TextEncoder, HMAC verify) against values that do
// not come from the runtime under test: RFC 4231 and RFC 7515 vectors, the jwt.io example, and
// Bun / node:crypto on seeded random inputs.

let seed = 0x2545f491;
const rand = (n: number): number => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % n;
};
const randomBytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => rand(256));
const toB64Url = (b: Uint8Array): string => Buffer.from(b).toString("base64url");

// atob: valid, padded and unpadded, with whitespace, and the inputs it must reject.
const atobInputs: string[] = [];
for (let n = 0; n <= 40; n++) {
  const padded = Buffer.from(randomBytes(n)).toString("base64");
  atobInputs.push(padded, padded.replace(/=+$/, ""), padded.replace(/(.{3})/, "$1 \n"), ` ${padded}\t`);
}
atobInputs.push(
  Buffer.from(randomBytes(5000)).toString("base64"),
  Buffer.from(randomBytes(769)).toString("base64"),
  "a",
  "abcde",
  "ab$c",
  "=abc",
  "ab=c",
  "a===",
  "====",
  "==",
  "abc==",
  "YQ=",
  "YQ===",
  "YQ==YQ==",
  " ",
  "\n",
  "",
  "-_",
  "abéd",
  "abŁd",
  "QUJDé",
  "Ł",
  "YWJj\0",
);

// TextEncoder: each length, every kind of unit, lone surrogates in every position.
const pieces = ["a", "Z", "é", "ÿ", "Ā", "߿", "ࠀ", "东", "🚤", "\ud800", "\udc00", "\udbff", "\udfff", "�", "\0"];
const encodeInputs: string[] = [];
for (let n = 0; n <= 60; n++) encodeInputs.push(Array.from({ length: n }, () => pieces[rand(pieces.length)]).join(""));
encodeInputs.push(
  "\ud83d",
  "\ud83dx",
  "x\udea4",
  "\udea4\ud83d",
  "\ud83d🚤",
  "🚤\udea4",
  "é".repeat(3000),
  "🚤".repeat(5000),
  "x".repeat(70000),
);

// HMAC: every key and message length around the SHA-256 and SHA-512 block sizes, high bytes included.
const hmacCases: { key: number[]; data: number[]; hash: string }[] = [];
for (const [klen, dlen] of [
  [0, 0],
  [1, 1],
  [20, 8],
  [32, 55],
  [64, 56],
  [64, 64],
  [65, 119],
  [131, 54],
  [200, 300],
  [16, 1000],
]) {
  for (const hash of ["SHA-256", "SHA-384", "SHA-512"]) {
    hmacCases.push({ key: Array.from(randomBytes(klen)), data: Array.from(randomBytes(dlen)), hash });
  }
}
const nodeHash = (h: string): string => h.replace("-", "").toLowerCase();
const hexOf = (b: Uint8Array | Buffer): string => Buffer.from(b).toString("hex");

// Published vectors.
const rfc4231 = [
  {
    key: "0b".repeat(20),
    data: Buffer.from("Hi There").toString("hex"),
    mac: "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
  },
  {
    key: Buffer.from("Jefe").toString("hex"),
    data: Buffer.from("what do ya want for nothing?").toString("hex"),
    mac: "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  },
  {
    key: "aa".repeat(131),
    data: Buffer.from("Test Using Larger Than Block-Size Key - Hash Key First").toString("hex"),
    mac: "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
  },
];
const rfc7515Key = "AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow";
const rfc7515 =
  "eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const jwtIo =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const jwtIoKey = "your-256-bit-secret";

const handler = `
const codes = (s) => Array.from(s, (c) => c.charCodeAt(0));
const hex = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] + 0x100).toString(16).slice(1);
  return out;
};
const fromHex = (h) => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const b64urlBytes = (s) => {
  let b = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4) b += "=";
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const hmacKey = (bytes, hash, usages) => crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash }, false, usages || ["sign", "verify"]);
// The check an API server writes: split, decode the signature, verify over the signing input.
const verifyJwt = async (token, keyBytes) => {
  const dot = token.lastIndexOf(".");
  const key = await hmacKey(keyBytes, "SHA-256", ["verify"]);
  let sig;
  try { sig = b64urlBytes(token.slice(dot + 1)); } catch (e) { return "bad-base64:" + e.name; }
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(token.slice(0, dot)));
};
export default {
  async fetch() {
    const input = JSON.parse(${JSON.stringify(JSON.stringify({ atobInputs, encodeInputs, hmacCases, rfc4231, rfc7515Key, rfc7515, jwtIo, jwtIoKey }))});
    const out = {};
    out.atob = input.atobInputs.map((s) => { try { return codes(atob(s)); } catch (e) { return e.name; } });
    // The same strings as UTF-16 storage: built from a JSON escape, so not literals.
    out.atobWide = input.atobInputs.slice(0, 12).map((s) => { const w = JSON.parse(JSON.stringify(s + "\\u0141")); try { return codes(atob(w.slice(0, -1))); } catch (e) { return e.name; } });
    out.encode = input.encodeInputs.map((s) => Array.from(new TextEncoder().encode(s)));
    out.encodeWide = input.encodeInputs.slice(0, 12).map((s) => Array.from(new TextEncoder().encode(JSON.parse(JSON.stringify(s)))));
    out.hmac = [];
    for (const c of input.hmacCases) {
      const key = await hmacKey(Uint8Array.from(c.key), c.hash);
      const mac = await crypto.subtle.sign("HMAC", key, Uint8Array.from(c.data));
      const ok = await crypto.subtle.verify("HMAC", key, mac, Uint8Array.from(c.data));
      const bad = await crypto.subtle.verify("HMAC", key, mac, Uint8Array.from(c.data.concat([0])));
      out.hmac.push({ mac: hex(mac), ok, bad });
    }
    out.rfc4231 = [];
    for (const v of input.rfc4231) {
      const key = await hmacKey(fromHex(v.key), "SHA-256");
      out.rfc4231.push(hex(await crypto.subtle.sign("HMAC", key, fromHex(v.data))));
    }
    const sigOf = (token) => token.slice(token.lastIndexOf(".") + 1);
    const flip = (token, at) => token.slice(0, at) + (token[at] === "A" ? "B" : "A") + token.slice(at + 1);
    const k1 = b64urlBytes(input.rfc7515Key);
    const k2 = new TextEncoder().encode(input.jwtIoKey);
    out.jwt = {
      rfc7515: await verifyJwt(input.rfc7515, k1),
      jwtIo: await verifyJwt(input.jwtIo, k2),
      wrongKey: await verifyJwt(input.jwtIo, new TextEncoder().encode("your-256-bit-secreT")),
      emptyKey: await verifyJwt(input.jwtIo, new Uint8Array(0)),
      tamperedSignature: await verifyJwt(flip(input.jwtIo, input.jwtIo.length - 3), k2),
      tamperedPayload: await verifyJwt(flip(input.jwtIo, 40), k2),
      tamperedHeader: await verifyJwt(flip(input.jwtIo, 5), k2),
      shortSignature: await verifyJwt(input.jwtIo.slice(0, -4), k2),
      longSignature: await verifyJwt(input.jwtIo + "AAAA", k2),
      noSignature: await verifyJwt(input.jwtIo.slice(0, input.jwtIo.lastIndexOf(".") + 1), k2),
      badBase64url: await verifyJwt(input.jwtIo.slice(0, -2) + "\\u0021\\u0021", k2),
      badBase64urlLength: await verifyJwt(input.jwtIo.slice(0, -3), k2),
    };
    // Typed-array windows and ArrayBuffers as verify input, not only whole Uint8Arrays.
    const key = await hmacKey(k2, "SHA-256", ["verify"]);
    const signingInput = new TextEncoder().encode(input.jwtIo.slice(0, input.jwtIo.lastIndexOf(".")));
    const sig = b64urlBytes(sigOf(input.jwtIo));
    const padded = new Uint8Array(signingInput.length + 7);
    padded.set(signingInput, 3);
    const sigPadded = new Uint8Array(sig.length + 5);
    sigPadded.set(sig, 2);
    out.views = {
      arrayBuffer: await crypto.subtle.verify("HMAC", key, sig.buffer, signingInput.buffer),
      window: await crypto.subtle.verify("HMAC", key, sigPadded.subarray(2, 34), padded.subarray(3, 3 + signingInput.length)),
      wrongWindow: await crypto.subtle.verify("HMAC", key, sigPadded.subarray(1, 33), padded.subarray(3, 3 + signingInput.length)),
      string: await crypto.subtle.verify("HMAC", key, sig, input.jwtIo.slice(0, input.jwtIo.lastIndexOf("."))),
    };
    out.keyInfo = { type: key.type, extractable: key.extractable, usages: key.usages, algorithm: key.algorithm };
    return Response.json(out);
  },
};`;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const codes = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));
const expectedAtob = (s: string): number[] | string => {
  try {
    return codes(atob(s));
  } catch (e) {
    return e instanceof Error ? e.name : "unknown";
  }
};
const expected = {
  atob: atobInputs.map(expectedAtob),
  atobWide: atobInputs.slice(0, 12).map((s) => expectedAtob(s)),
  encode: encodeInputs.map((s) => Array.from(new TextEncoder().encode(s))),
  encodeWide: encodeInputs.slice(0, 12).map((s) => Array.from(new TextEncoder().encode(s))),
  hmac: hmacCases.map((c) => ({
    mac: hexOf(createHmac(nodeHash(c.hash), Buffer.from(c.key)).update(Buffer.from(c.data)).digest()),
    ok: true,
    bad: false,
  })),
  rfc4231: rfc4231.map((v) => v.mac),
  jwt: {
    rfc7515: true,
    jwtIo: true,
    wrongKey: false,
    emptyKey: false,
    tamperedSignature: false,
    tamperedPayload: false,
    tamperedHeader: false,
    shortSignature: false,
    longSignature: false,
    noSignature: false,
    badBase64url: "bad-base64:InvalidCharacterError",
    badBase64urlLength: false,
  },
  views: { arrayBuffer: true, window: true, wrongWindow: false, string: true },
  keyInfo: {
    type: "secret",
    extractable: false,
    usages: ["verify"],
    algorithm: { name: "HMAC", hash: { name: "SHA-256" }, length: 152 },
  },
};
// The published vectors must hold in Bun too, or the test itself is wrong.
for (const v of rfc4231)
  assert.equal(
    hexOf(createHmac("sha256", Buffer.from(v.key, "hex")).update(Buffer.from(v.data, "hex")).digest()),
    v.mac,
  );
assert.equal(
  toB64Url(
    createHmac("sha256", Buffer.from(rfc7515Key, "base64url"))
      .update(rfc7515.slice(0, rfc7515.lastIndexOf(".")))
      .digest(),
  ),
  rfc7515.slice(rfc7515.lastIndexOf(".") + 1),
);
assert.equal(
  toB64Url(
    createHmac("sha256", jwtIoKey)
      .update(jwtIo.slice(0, jwtIo.lastIndexOf(".")))
      .digest(),
  ),
  jwtIo.slice(jwtIo.lastIndexOf(".") + 1),
);

const workdir = await mkdtemp(join(tmpdir(), "sb-native-jwt-"));
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  const porffor = await ensurePorffor();
  const node = Bun.which("node");
  if (!node) throw new Error("native jwt test needs node on PATH");

  const [core, broker] = await Promise.all([readFile(preludePath, "utf8"), readFile(transportPath("broker"), "utf8")]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const prelude = core.replace(TRANSPORT_MARKER, broker);
  const generated = join(workdir, "jwt.generated.js");
  const binary = join(workdir, "jwt-native");
  await writeFile(generated, wrapNativeFetchHandler(handler, prelude));

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
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(20000) });
      break;
    } catch {
      if (server.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  assert(response, "compiled jwt handler did not start");
  assert.equal(response.status, 200);
  const actual: typeof expected = await response.json();
  assert.deepEqual(actual, expected);
  console.log("Native JWT pieces (atob, TextEncoder, HMAC verify) match RFC 4231, RFC 7515, jwt.io and Bun");
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
