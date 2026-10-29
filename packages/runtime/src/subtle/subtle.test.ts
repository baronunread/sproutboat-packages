// The native half of crypto.subtle (subtle.c) against Bun's WebCrypto (BoringSSL), the reference
// that is not our code. Compiles the C with the host cc and BearSSL from the CLI's cache; skipped
// when BearSSL has not been built on this machine (the standalone build creates it).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assembleSubtleC } from "./assemble";

const bear = join(
  process.env.SPROUTBOAT_TOOLCHAIN_CACHE ?? join(homedir(), ".cache/sproutboat"),
  "bearssl-0.6/bearssl-0.6",
);
const lib = join(bear, "build/libbearssl.a");
const available = existsSync(lib);

const OP = {
  pkcs1Sign: 1,
  pkcs1Verify: 2,
  pssSign: 3,
  pssVerify: 4,
  ecdsaSign: 5,
  ecdsaVerify: 6,
  edSign: 7,
  edVerify: 8,
  pbkdf2: 9,
  hkdf: 10,
  decodeSpki: 20,
  decodePkcs8: 21,
  encodeSpki: 22,
  encodePkcs8: 23,
  rsaKeygen: 26,
  ecKeygen: 27,
  edKeygen: 28,
  pointOk: 30,
  gcmEnc: 11,
  gcmDec: 12,
  cbcEnc: 13,
  cbcDec: 14,
  ctr: 15,
  kwWrap: 16,
  kwUnwrap: 17,
  ecdh: 18,
  x25519: 19,
  oaepEnc: 24,
  oaepDec: 25,
  edPub: 29,
  xPub: 31,
};

const hex = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("hex");
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const arg = (v: string | Uint8Array | undefined) =>
  v === undefined || v.length === 0 ? "-" : v instanceof Uint8Array ? hex(v) : Buffer.from(v).toString("hex");

let driver = "";
let work = "";
if (available) {
  work = mkdtempSync(join(tmpdir(), "sb-subtle-"));
  writeFileSync(join(work, "assembled.c"), assembleSubtleC());
  await Bun.write(join(work, "driver.c"), Bun.file(new URL("./driver.c", import.meta.url)));
  driver = join(work, "driver");
  const cc = Bun.spawnSync([
    "cc",
    "-O1",
    "-Wall",
    "-Wno-unused-function",
    `-I${bear}/inc`,
    "-o",
    driver,
    join(work, "driver.c"),
    lib,
  ]);
  if (cc.exitCode !== 0) throw new Error(`driver did not compile:\n${cc.stderr}`);
}

function call(
  op: number,
  a?: string | Uint8Array,
  b?: string | Uint8Array,
  c?: string | Uint8Array,
  d?: string | Uint8Array,
) {
  const run = Bun.spawnSync([driver], { stdin: Buffer.from(`${op} ${arg(a)} ${arg(b)} ${arg(c)} ${arg(d)}\n`) });
  const [rc, out = ""] = run.stdout.toString().trim().split(" ");
  return { rc: Number(rc), out: fromHex(out) };
}

/** Fields of a decode result: [kind][curve][private] then u32-length-prefixed fields. */
function fields(out: Uint8Array) {
  const view = new DataView(out.buffer, out.byteOffset);
  const list: Uint8Array[] = [];
  for (let i = 3; i < out.length;) {
    const n = view.getUint32(i);
    list.push(out.slice(i + 4, i + 4 + n));
    i += 4 + n;
  }
  return { kind: out[0], curve: out[1], isPrivate: out[2] === 1, list };
}
const frame = (...parts: Uint8Array[]) => {
  const out: number[] = [];
  for (const p of parts)
    out.push(p.length >>> 24, (p.length >>> 16) & 255, (p.length >>> 8) & 255, p.length & 255, ...p);
  return new Uint8Array(out);
};
const b64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const data = new TextEncoder().encode("the message to sign, é中");
const HASHES = [
  ["SHA-1", 1],
  ["SHA-256", 256],
  ["SHA-384", 384],
  ["SHA-512", 512],
] as const;

describe.skipIf(!available)("subtle.c against Bun WebCrypto", () => {
  test("PBKDF2 for every hash", async () => {
    for (const [hash, bits] of HASHES) {
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("passwörd"), "PBKDF2", false, [
        "deriveBits",
      ]);
      for (const [iters, len] of [
        [1, 20],
        [1000, 70],
        [3, 129],
      ] as const) {
        const want = await crypto.subtle.deriveBits(
          { name: "PBKDF2", hash, salt: fromHex("0102030405"), iterations: iters },
          key,
          len * 8,
        );
        const got = call(
          OP.pbkdf2,
          `${bits},${iters},${len}`,
          new TextEncoder().encode("passwörd"),
          fromHex("0102030405"),
        );
        expect([hash, iters, hex(got.out)]).toEqual([hash, iters, hex(want)]);
      }
    }
  });

  test("HKDF for every hash, empty salt and info included", async () => {
    for (const [hash, bits] of HASHES) {
      const key = await crypto.subtle.importKey("raw", fromHex("0b0b0b0b0b0b0b0b0b0b0b"), "HKDF", false, [
        "deriveBits",
      ]);
      for (const [salt, info, len] of [
        ["000102", "f0f1f2", 42],
        ["", "", 33],
        ["aa", "", 255],
      ] as const) {
        const want = await crypto.subtle.deriveBits(
          { name: "HKDF", hash, salt: fromHex(salt), info: fromHex(info) },
          key,
          len * 8,
        );
        const got = call(OP.hkdf, `${bits},${len}`, fromHex("0b0b0b0b0b0b0b0b0b0b0b"), fromHex(salt), fromHex(info));
        expect([hash, hex(got.out)]).toEqual([hash, hex(want)]);
      }
    }
  });

  for (const modulus of [2048, 3072]) {
    test(`RSA ${modulus}: PKCS#1 v1.5 and PSS interoperate with BoringSSL, both directions`, async () => {
      for (const name of ["RSASSA-PKCS1-v1_5", "RSA-PSS"] as const) {
        for (const [hash, bits] of HASHES.slice(1)) {
          const pair = await crypto.subtle.generateKey(
            { name, modulusLength: modulus, publicExponent: new Uint8Array([1, 0, 1]), hash },
            true,
            ["sign", "verify"],
          );
          const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
          const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
          for (const salt of name === "RSA-PSS" ? [0, 32] : [0]) {
            const algo = name === "RSA-PSS" ? { name, saltLength: salt } : { name };
            const sign = call(name === "RSA-PSS" ? OP.pssSign : OP.pkcs1Sign, `${bits},${salt}`, pkcs8, data);
            expect(sign.rc).toBe(0);
            expect(await crypto.subtle.verify(algo, pair.publicKey, sign.out, data)).toBe(true);
            const theirs = new Uint8Array(await crypto.subtle.sign(algo, pair.privateKey, data));
            const verify = call(
              name === "RSA-PSS" ? OP.pssVerify : OP.pkcs1Verify,
              `${bits},${salt}`,
              spki,
              theirs,
              data,
            );
            expect([name, hash, salt, hex(verify.out)]).toEqual([name, hash, salt, "01"]);
            // A flipped message bit and a flipped signature bit both fail.
            const bad = Uint8Array.from(data);
            bad[0] ^= 1;
            expect(
              hex(call(name === "RSA-PSS" ? OP.pssVerify : OP.pkcs1Verify, `${bits},${salt}`, spki, theirs, bad).out),
            ).toBe("00");
            const badSig = Uint8Array.from(theirs);
            badSig[10] ^= 1;
            expect(
              hex(call(name === "RSA-PSS" ? OP.pssVerify : OP.pkcs1Verify, `${bits},${salt}`, spki, badSig, data).out),
            ).toBe("00");
          }
        }
      }
    }, 60_000);
  }

  test("RSA key decode and encode agree with BoringSSL's JWK and DER", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    // SAFETY: an RSA or EC private JWK from WebCrypto has only string members.
    const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as Record<string, string>;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
    const priv = fields(call(OP.decodePkcs8, undefined, pkcs8).out);
    expect(priv.isPrivate).toBe(true);
    expect(priv.list.map(hex)).toEqual(["n", "e", "d", "p", "q", "dp", "dq", "qi"].map((k) => hex(b64u(jwk[k]))));
    const pub = fields(call(OP.decodeSpki, undefined, spki).out);
    expect(pub.list.map(hex)).toEqual([hex(b64u(jwk.n)), hex(b64u(jwk.e))]);
    // Encoding what we decoded gives DER BoringSSL imports, and the same key back.
    const enc = call(OP.encodePkcs8, "1,0", frame(...priv.list));
    expect(enc.rc).toBe(0);
    const back = await crypto.subtle.importKey("pkcs8", enc.out, { name: "RSA-PSS", hash: "SHA-256" }, true, ["sign"]);
    expect(await crypto.subtle.exportKey("jwk", back)).toMatchObject({ n: jwk.n, d: jwk.d, qi: jwk.qi });
    const encPub = call(OP.encodeSpki, "1,0", frame(...pub.list));
    expect(hex(encPub.out)).toBe(hex(spki));
  });

  test("RSA keygen yields a usable key; bad sizes and exponents are refused", async () => {
    const generated = call(OP.rsaKeygen, "2048,65537");
    expect(generated.rc).toBe(0);
    const key = await crypto.subtle.importKey(
      "pkcs8",
      generated.out,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      true,
      ["sign"],
    );
    expect((await crypto.subtle.exportKey("jwk", key)).e).toBe("AQAB");
    expect(call(OP.rsaKeygen, "256,65537").rc).toBe(3);
    expect(call(OP.rsaKeygen, "2048,4").rc).toBe(3);
  }, 60_000);

  for (const [curve, id, size] of [
    ["P-256", 1, 32],
    ["P-384", 2, 48],
    ["P-521", 3, 66],
  ] as const) {
    test(`ECDSA ${curve}: interop, decode, encode, keygen`, async () => {
      for (const [hash, bits] of HASHES) {
        const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: curve }, true, ["sign", "verify"]);
        const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
        const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
        const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
        const sign = call(OP.ecdsaSign, `${bits}`, pkcs8, data);
        expect(sign.rc).toBe(0);
        expect(sign.out.length).toBe(2 * size);
        expect(await crypto.subtle.verify({ name: "ECDSA", hash }, pair.publicKey, sign.out, data)).toBe(true);
        const theirs = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash }, pair.privateKey, data));
        expect(hex(call(OP.ecdsaVerify, `${bits},${id}`, raw, theirs, data).out)).toBe("01");
        const bad = Uint8Array.from(theirs);
        bad[5] ^= 1;
        expect(hex(call(OP.ecdsaVerify, `${bits},${id}`, raw, bad, data).out)).toBe("00");
        if (hash === "SHA-256") {
          // SAFETY: an RSA or EC private JWK from WebCrypto has only string members.
          const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as Record<string, string>;
          const priv = fields(call(OP.decodePkcs8, undefined, pkcs8).out);
          expect([
            priv.curve,
            hex(priv.list[0].slice(1, 1 + size)),
            hex(priv.list[0].slice(1 + size)),
            hex(priv.list[1]),
          ]).toEqual([id, hex(b64u(jwk.x)), hex(b64u(jwk.y)), hex(b64u(jwk.d))]);
          const pub = fields(call(OP.decodeSpki, undefined, spki).out);
          expect(hex(pub.list[0])).toBe(hex(raw));
          expect(hex(call(OP.encodeSpki, `2,${id}`, frame(raw)).out)).toBe(hex(spki));
          const enc = call(OP.encodePkcs8, `2,${id}`, frame(raw, priv.list[1]));
          const back = await crypto.subtle.importKey("pkcs8", enc.out, { name: "ECDSA", namedCurve: curve }, true, [
            "sign",
          ]);
          expect(await crypto.subtle.exportKey("jwk", back)).toMatchObject({ d: jwk.d, x: jwk.x });
        }
      }
      const made = call(OP.ecKeygen, `${id}`);
      expect(made.rc).toBe(0);
      await crypto.subtle.importKey("pkcs8", made.out, { name: "ECDSA", namedCurve: curve }, true, ["sign"]);
      // A point that is not on the curve is refused, a real one accepted.
      const real = new Uint8Array(
        await crypto.subtle.exportKey(
          "raw",
          (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: curve }, true, ["sign", "verify"])).publicKey,
        ),
      );
      expect(hex(call(OP.pointOk, `${id}`, real).out)).toBe("01");
      const off = Uint8Array.from(real);
      off[off.length - 1] ^= 1;
      expect(hex(call(OP.pointOk, `${id}`, off).out)).toBe("00");
    }, 60_000);
  }

  test("Ed25519: RFC 8032 vector 1, interop, DER", async () => {
    const seed = fromHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
    const sig = call(OP.edSign, undefined, seed, new Uint8Array());
    expect(hex(sig.out)).toBe(
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    );
    // SAFETY: generateKey with an asymmetric algorithm returns a CryptoKeyPair.
    const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
    const priv = fields(call(OP.decodePkcs8, undefined, pkcs8).out);
    expect([priv.kind, hex(priv.list[0])]).toEqual([3, hex(raw)]);
    const ours = call(OP.edSign, undefined, priv.list[1], data).out;
    expect(await crypto.subtle.verify("Ed25519", pair.publicKey, ours, data)).toBe(true);
    const theirs = new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, data));
    expect(hex(theirs)).toBe(hex(ours)); // Ed25519 is deterministic
    expect(hex(call(OP.edVerify, undefined, raw, theirs, data).out)).toBe("01");
    const bad = Uint8Array.from(theirs);
    bad[40] ^= 1;
    expect(hex(call(OP.edVerify, undefined, raw, bad, data).out)).toBe("00");
    expect(hex(call(OP.edVerify, undefined, raw, theirs.slice(0, 63), data).out)).toBe("00");
    expect(hex(call(OP.encodeSpki, "3,0", frame(raw)).out)).toBe(hex(spki));
    expect(hex(call(OP.encodePkcs8, "3,0", frame(raw, priv.list[1])).out)).toBe(hex(pkcs8));
    expect(call(OP.edKeygen).out.length).toBe(32);
  });
  for (const keyBytes of [16, 24, 32]) {
    test(`AES-${keyBytes * 8}: GCM, CBC, CTR and KW match BoringSSL`, async () => {
      const key = crypto.getRandomValues(new Uint8Array(keyBytes));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const aad = fromHex("0a0b0c");
      for (const length of [0, 1, 15, 16, 17, 100]) {
        const plain = crypto.getRandomValues(new Uint8Array(length));
        for (const tag of [128, 96, 32]) {
          const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
          const theirs = new Uint8Array(
            await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: tag }, k, plain),
          );
          const ours = call(OP.gcmEnc, `${tag}`, key, iv, frame(plain, aad));
          expect([ours.rc, hex(ours.out)]).toEqual([0, hex(theirs)]);
          expect(hex(call(OP.gcmDec, `${tag}`, key, iv, frame(theirs, aad)).out)).toBe(hex(plain));
          const bad = Uint8Array.from(theirs);
          bad[bad.length - 1] ^= 1;
          expect(call(OP.gcmDec, `${tag}`, key, iv, frame(bad, aad)).rc).toBe(2);
          expect(call(OP.gcmDec, `${tag}`, key, iv, frame(theirs, new Uint8Array([1]))).rc).toBe(2);
        }
        const cbcIv = crypto.getRandomValues(new Uint8Array(16));
        const ck = await crypto.subtle.importKey("raw", key, "AES-CBC", false, ["encrypt", "decrypt"]);
        const cbcTheirs = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: cbcIv }, ck, plain));
        expect(hex(call(OP.cbcEnc, undefined, key, cbcIv, plain).out)).toBe(hex(cbcTheirs));
        expect(hex(call(OP.cbcDec, undefined, key, cbcIv, cbcTheirs).out)).toBe(hex(plain));
        const badPad = Uint8Array.from(cbcTheirs);
        badPad[badPad.length - 1] ^= 0x55;
        // A flipped last byte makes the padding invalid, except by a 1 in 256 chance of valid padding.
        const damaged = call(OP.cbcDec, undefined, key, cbcIv, badPad);
        expect(damaged.rc === 2 || hex(damaged.out) !== hex(plain)).toBe(true);
        for (const bits of [128, 64, 8, 32]) {
          const counter = crypto.getRandomValues(new Uint8Array(16));
          if (bits < 64) counter[15] = 0xff; // near the wrap
          const rk = await crypto.subtle.importKey("raw", key, "AES-CTR", false, ["encrypt"]);
          const blocks = Math.ceil(length / 16);
          if (bits < 64 && blocks > 2 ** bits) continue;
          const ctrTheirs = new Uint8Array(
            await crypto.subtle.encrypt({ name: "AES-CTR", counter, length: bits }, rk, plain),
          );
          expect([bits, hex(call(OP.ctr, `${bits}`, key, counter, plain).out)]).toEqual([bits, hex(ctrTheirs)]);
        }
      }
      // a counter that cannot number the data is refused
      expect(call(OP.ctr, "1", key, new Uint8Array(16), new Uint8Array(48)).rc).toBe(2);
      const kek = await crypto.subtle.importKey("raw", key, "AES-KW", false, ["wrapKey", "unwrapKey"]);
      const target = await crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), "AES-GCM", true, [
        "encrypt",
      ]);
      const raw = new Uint8Array(await crypto.subtle.exportKey("raw", target));
      const wrapped = new Uint8Array(await crypto.subtle.wrapKey("raw", target, kek, "AES-KW"));
      expect(hex(call(OP.kwWrap, undefined, key, undefined, raw).out)).toBe(hex(wrapped));
      expect(hex(call(OP.kwUnwrap, undefined, key, undefined, wrapped).out)).toBe(hex(raw));
      const tampered = Uint8Array.from(wrapped);
      tampered[3] ^= 1;
      expect(call(OP.kwUnwrap, undefined, key, undefined, tampered).rc).toBe(2);
      expect(call(OP.kwWrap, undefined, key, undefined, new Uint8Array(12)).rc).toBe(2);
    });
  }

  for (const [curve, id, bits] of [
    ["P-256", 1, 256],
    ["P-384", 2, 384],
    ["P-521", 3, 528],
  ] as const) {
    test(`ECDH ${curve} matches BoringSSL, both ways`, async () => {
      const a = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: curve }, true, ["deriveBits"]);
      const b = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: curve }, true, ["deriveBits"]);
      const want = new Uint8Array(
        await crypto.subtle.deriveBits({ name: "ECDH", public: b.publicKey }, a.privateKey, bits),
      );
      const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", a.privateKey));
      const peer = new Uint8Array(await crypto.subtle.exportKey("raw", b.publicKey));
      const got = call(OP.ecdh, `${id}`, pkcs8, peer);
      expect([got.rc, hex(got.out)]).toEqual([0, hex(want)]);
      const off = Uint8Array.from(peer);
      off[off.length - 1] ^= 1;
      expect(call(OP.ecdh, `${id}`, pkcs8, off).rc).toBe(2);
    });
  }

  test("X25519 matches BoringSSL and refuses a low-order point", async () => {
    // SAFETY: generateKey with an asymmetric algorithm returns a CryptoKeyPair.
    const a = (await crypto.subtle.generateKey("X25519", true, ["deriveBits"])) as CryptoKeyPair;
    // SAFETY: as above.
    const b = (await crypto.subtle.generateKey("X25519", true, ["deriveBits"])) as CryptoKeyPair;
    const want = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "X25519", public: b.publicKey }, a.privateKey, 256),
    );
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", a.privateKey));
    const priv = fields(call(OP.decodePkcs8, undefined, pkcs8).out);
    expect(priv.kind).toBe(4);
    const peer = new Uint8Array(await crypto.subtle.exportKey("raw", b.publicKey));
    expect(hex(call(OP.x25519, undefined, priv.list[1], peer).out)).toBe(hex(want));
    expect(hex(call(OP.xPub, undefined, priv.list[1]).out)).toBe(
      hex(new Uint8Array(await crypto.subtle.exportKey("raw", a.publicKey))),
    );
    expect(call(OP.x25519, undefined, priv.list[1], new Uint8Array(32)).rc).toBe(2);
  });

  test("RSA-OAEP interoperates with BoringSSL for every hash, with and without a label", async () => {
    for (const [hash, bits] of HASHES) {
      const pair = await crypto.subtle.generateKey(
        { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash },
        true,
        ["encrypt", "decrypt"],
      );
      const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
      const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
      for (const label of [new Uint8Array(0), fromHex("0102")]) {
        const message = crypto.getRandomValues(new Uint8Array(20));
        const ours = call(OP.oaepEnc, `${bits}`, spki, label, message);
        expect(ours.rc).toBe(0);
        const back = new Uint8Array(
          await crypto.subtle.decrypt({ name: "RSA-OAEP", label }, pair.privateKey, ours.out),
        );
        expect(hex(back)).toBe(hex(message));
        const theirs = new Uint8Array(
          await crypto.subtle.encrypt({ name: "RSA-OAEP", label }, pair.publicKey, message),
        );
        expect(hex(call(OP.oaepDec, `${bits}`, pkcs8, label, theirs).out)).toBe(hex(message));
        expect(call(OP.oaepDec, `${bits}`, pkcs8, fromHex("ff"), theirs).rc).toBe(2);
      }
    }
  }, 60_000);
});

process.on("exit", () => work && rmSync(work, { recursive: true, force: true }));
