import { expect, test } from "bun:test";
import { unicodeEncoderSource } from "./unicode";
const source = unicodeEncoderSource("class TextEncoder { }\nclass TextDecoder { }");
// oxlint-disable-next-line no-function-constructor -- Test the replacement source inserted into Porffor's fetch globals.
const Encoder = new Function(`${source}\nreturn TextEncoder;`)();

test("UTF-8 encoding matches WebCrypto inputs for BMP, astral and lone surrogates", () => {
  for (const input of [
    "",
    "ASCII",
    "caffè",
    "東京",
    "🚤",
    "x🚤y",
    "\ud800",
    "\udc00",
    "\ud800x",
    "🚤".repeat(1000),
  ]) {
    expect(Array.from(new Encoder().encode(input))).toEqual(
      Array.from(new TextEncoder().encode(input)),
    );
  }
});

test("encodeInto stops before a split UTF-8 character and counts UTF-16 units", () => {
  for (const input of ["🚤", "x🚤y", "éx", "\ud800x"]) {
    for (let size = 0; size <= 10; size++) {
      const actual = new Uint8Array(size);
      const expected = new Uint8Array(size);
      expect(new Encoder().encodeInto(input, actual)).toEqual(
        new TextEncoder().encodeInto(input, expected),
      );
      expect(actual).toEqual(expected);
    }
  }
});

test("encoder patch is idempotent and refuses a changed upstream layout", () => {
  expect(unicodeEncoderSource(source)).toBe(source);
  expect(() => unicodeEncoderSource("unexpected upstream")).toThrow();
});
