import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("./native-fetch-prelude.js", import.meta.url), "utf8");
const decoder = src.slice(src.indexOf("function __sbFromUtf8("), src.indexOf("// sproutboat #181"));
const ingress = src.slice(
  src.indexOf("function __sbDecodeIngress("),
  src.indexOf("globalThis.__sbEntry ="),
);
if (!decoder || !ingress) throw new Error("Ingress decoder source not found");
// oxlint-disable-next-line no-function-constructor -- Exercise the text-only runtime prelude.
const load = new Function(`${decoder}\n${ingress}\nreturn __sbDecodeIngress;`);
const decode = load();
const raw = (text) =>
  Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join("");

test("native ingress text and JSON decode Unicode without changing raw bytes", async () => {
  const body = raw('{"id":"caffè-🚤"}');
  const request = { body };
  decode(request);
  expect(await request.text()).toBe('{"id":"caffè-🚤"}');
  expect(await request.json()).toEqual({ id: "caffè-🚤" });
  expect(await request.text()).toBe('{"id":"caffè-🚤"}');
  expect(request.body).toBe(body);
});

test("native ingress retains empty bodies and JSON parse errors", () => {
  const empty = { body: "" };
  decode(empty);
  expect(empty.text()).toBe("");
  expect(() => empty.json()).toThrow();
  const invalid = { body: "{" };
  decode(invalid);
  expect(() => invalid.json()).toThrow();
});

test("a bodyless request keeps its existing methods", () => {
  const text = () => "";
  const request = { body: null, text };
  decode(request);
  expect(request.text).toBe(text);
});
