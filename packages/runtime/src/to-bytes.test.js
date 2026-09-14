// sproutboat #180 — __sbToBytes lives inline in native-fetch-prelude.js (the
// prelude is prepended as text and cannot import), so this test lifts that one
// pure-JS function (plus its __sbIsStr dependency) out and exercises it
// directly. If it moves or its boundary markers change, this fails loudly
// rather than silently testing nothing.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("./native-fetch-prelude.js", import.meta.url)), "utf8");
const isStrStart = src.indexOf("function __sbIsStr(");
const isStrEnd = src.indexOf("function __sbIsFn(");
const start = src.indexOf("function __sbToBytes(");
const end = src.indexOf("function __sbBufFrom(");
const hexStart = src.indexOf("function __sbHexOrBytes(");
const hexEnd = src.indexOf("\nif (globalThis.crypto.subtle");
if (isStrStart === -1 || isStrEnd === -1 || start === -1 || end === -1 || end < start) {
  throw new Error("__sbToBytes (or __sbIsStr) block not found in prelude");
}
if (hexStart === -1 || hexEnd === -1 || hexEnd < hexStart) throw new Error("__sbHexOrBytes block not found in prelude");

// oxlint-disable-next-line no-function-constructor -- lifting pure blocks out of the text-only prelude for test
const load = new Function(
  `${src.slice(isStrStart, isStrEnd)}\n${src.slice(start, end)}\n${src.slice(hexStart, hexEnd)}\nreturn { __sbToBytes, __sbHexOrBytes };`,
);
const { __sbToBytes, __sbHexOrBytes } = load();

/** The real bytestring shape (one char per raw byte) as a normal JS array of byte values, for comparison. */
function bytesOf(bytestring) {
  const out = [];
  for (let i = 0; i < bytestring.length; i++) out.push(bytestring.charCodeAt(i));
  return out;
}

test("ASCII string encodes byte-identically to TextEncoder", () => {
  const text = "hello world 123";
  expect(bytesOf(__sbToBytes(text))).toEqual([...new TextEncoder().encode(text)]);
});

test("2-byte (Latin-1 range) sequences encode byte-identically to TextEncoder", () => {
  const text = "café";
  expect(bytesOf(__sbToBytes(text))).toEqual([...new TextEncoder().encode(text)]);
});

test("3-byte sequences encode byte-identically to TextEncoder", () => {
  const text = "porffor · x86_64 ✓";
  expect(bytesOf(__sbToBytes(text))).toEqual([...new TextEncoder().encode(text)]);
});

test("surrogate-pair (4-byte) sequences encode byte-identically to TextEncoder", () => {
  const text = "🌱 sprout 🌱";
  expect(bytesOf(__sbToBytes(text))).toEqual([...new TextEncoder().encode(text)]);
});

test("a lone unpaired surrogate falls into the 3-byte branch, matching charCodeAt-based encoders", () => {
  const lone = String.fromCharCode(0xd800); // high surrogate with no following low surrogate
  const view = __sbToBytes(lone);
  // WHATWG TextEncoder would replace this with U+FFFD; __sbToBytes intentionally
  // encodes the raw code unit instead (matches the historical/legacy behavior it
  // already had) -- this test only pins that behavior isn't disturbed by the fix.
  expect(bytesOf(view)).toEqual([0xe0 | (0xd800 >> 12), 0x80 | ((0xd800 >> 6) & 0x3f), 0x80 | (0xd800 & 0x3f)]);
});

test("null/undefined input returns empty", () => {
  expect(__sbToBytes(null)).toBe("");
  expect(__sbToBytes(undefined)).toBe("");
});

test("ArrayBuffer / typed-array input is copied byte for byte, high bytes included", () => {
  const bytes = new Uint8Array([0x00, 0x7f, 0x80, 0xff, 0x01, 0xfe]);
  expect(bytesOf(__sbToBytes(bytes))).toEqual([...bytes]);
  expect(bytesOf(__sbToBytes(bytes.buffer))).toEqual([...bytes]);
});

// __sbToBytes builds its result via an array + one join(), not repeated
// `out +=` / `s +=`. Porffor's strings have no rope/cons optimization, so `+=`
// in a loop copies the whole accumulated string on every append, making a
// large encode O(n^2) -- the same bug class __sbFromUtf8 was fixed for
// (see utf8-decode.test.js). This is a correctness check (long input still
// round-trips exactly), not a timing assertion.
test("a long, multi-chunk mixed-width string round-trips byte-identically", () => {
  const chunk = "porffor · src/index.js → 1.25 MB · x86_64-musl ✓ café 🌱 ";
  const text = chunk.repeat(800); // ~46KB, comparable to the __sbFromUtf8 regression case
  expect(bytesOf(__sbToBytes(text))).toEqual([...new TextEncoder().encode(text)]);
});

test("a long high-byte typed array round-trips byte for byte", () => {
  const bytes = new Uint8Array(50000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 0x80) & 0xff;
  expect(bytesOf(__sbToBytes(bytes))).toEqual([...bytes]);
});

// __sbHexOrBytes had the same O(n^2) shape on a third path (it backs the
// `expected` side of the HMAC verify), plus a `slice(0, -1) + ...` rewrite that
// copied the accumulated string a second time per byte. Same array+join fix.
test("an even-length hex string decodes to its bytes, both cases", () => {
  expect(bytesOf(__sbHexOrBytes("00ff107a"))).toEqual([0x00, 0xff, 0x10, 0x7a]);
  expect(bytesOf(__sbHexOrBytes("00FF107A"))).toEqual([0x00, 0xff, 0x10, 0x7a]);
  expect(bytesOf(__sbHexOrBytes("aAbB"))).toEqual([0xaa, 0xbb]);
});

test("a non-hex or odd-length string falls back to raw bytes", () => {
  expect(__sbHexOrBytes("zz")).toBe(__sbToBytes("zz"));
  expect(__sbHexOrBytes("abc")).toBe(__sbToBytes("abc")); // odd length
  expect(__sbHexOrBytes("")).toBe(__sbToBytes(""));
  expect(bytesOf(__sbHexOrBytes(new Uint8Array([0x80, 0x01])))).toEqual([0x80, 0x01]);
});

test("a long hex string decodes byte for byte", () => {
  const bytes = new Uint8Array(20000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 0x80) & 0xff;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  expect(bytesOf(__sbHexOrBytes(hex))).toEqual([...bytes]);
});
