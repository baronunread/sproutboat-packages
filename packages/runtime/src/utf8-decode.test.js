// sproutboat #181 — __sbFromUtf8 lives inline in native-fetch-prelude.js (the
// prelude is prepended as text and cannot import), so this test lifts that one
// pure-JS function out and exercises it directly. If it moves or its boundary
// markers change, this fails loudly rather than silently testing nothing.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("./native-fetch-prelude.js", import.meta.url)), "utf8");
const start = src.indexOf("function __sbFromUtf8(");
const end = src.indexOf("// sproutboat #181 — wrap a Response");
if (start === -1 || end === -1 || end < start) throw new Error("__sbFromUtf8 block not found in prelude");

// oxlint-disable-next-line no-function-constructor -- lifting a pure block out of the text-only prelude for test
const load = new Function(`${src.slice(start, end)}\nreturn { __sbFromUtf8 };`);
const { __sbFromUtf8 } = load();

/** Build a bytestring (one char per raw byte) the way __sbToBytes/porf_native_fetch_alloc_bytestring would, from real UTF-8 bytes. */
function toBytestring(text) {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

test("decodes real UTF-8 bytes back to the original text", () => {
  const text = "porffor · src/index.js → 1.25 MB · x86_64-musl ✓";
  expect(__sbFromUtf8(toBytestring(text))).toBe(text);
});

test("multi-byte and 4-byte (surrogate-pair) sequences round-trip", () => {
  expect(__sbFromUtf8(toBytestring("café"))).toBe("café");
  expect(__sbFromUtf8(toBytestring("🌱"))).toBe("🌱");
});

test("a genuine Latin-1-range string with no real UTF-8 sequences passes through unchanged", () => {
  // "héllo" here is a real JS string (one code point per character), not
  // re-encoded bytes -- exactly what a handler-built bytestring looks like.
  // This must NOT be decoded, or it corrupts ordinary accented text.
  expect(__sbFromUtf8("héllo")).toBe("héllo");
  expect(__sbFromUtf8("café")).toBe("café");
});

test("a lead byte with an invalid or missing continuation passes through raw", () => {
  expect(__sbFromUtf8(String.fromCharCode(0xe9))).toBe(String.fromCharCode(0xe9));
  expect(__sbFromUtf8(String.fromCharCode(0xc2))).toBe(String.fromCharCode(0xc2)); // truncated 2-byte lead
});

test("empty and pure-ASCII strings are untouched", () => {
  expect(__sbFromUtf8("")).toBe("");
  expect(__sbFromUtf8("hello world")).toBe("hello world");
});
