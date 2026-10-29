import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { preludePath, pruneSubtle, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../wrap";

const embedded = readFileSync(transportPath("embedded"), "utf8");
const prelude = readFileSync(preludePath, "utf8").replace(TRANSPORT_MARKER, embedded);
const handler = (body: string) => `export default { async fetch() { ${body} return new Response("x"); } };`;

test("pruning removes the workerd-style crypto.subtle, its C and its glue, and nothing else", () => {
  const pruned = pruneSubtle(prelude);
  for (const gone of [
    "__sbSubtleNext",
    "const __SB_SUBTLE_DATE",
    "sbc_op",
    "crypto_ed25519_sign",
    "__sbSubtleRaw",
    "class DigestStream",
  ])
    expect(pruned).not.toContain(gone);
  for (const kept of [
    "__sbSubtleLegacy",
    "globalThis.crypto.subtle = __sbSubtleLegacy",
    "br_sha256_init",
    "__sbHmacRaw",
  ])
    expect(pruned).toContain(kept);
  expect(pruned.length).toBeLessThan(prelude.length - 150_000);
  // What is left is still JavaScript.
  new Bun.Transpiler().transformSync(pruned);
});

test("auto keeps the code for a handler that names crypto.subtle, DigestStream or CryptoKey", () => {
  const wrap = (source: string, mode: "auto" | "always") =>
    wrapNativeFetchHandler(
      source,
      prelude,
      {},
      undefined,
      undefined,
      "2026-11-06",
      "app",
      undefined,
      "embedded",
      undefined,
      mode,
    );
  expect(wrap(handler("await crypto.subtle.digest('SHA-256', new Uint8Array(1));"), "auto")).toContain(
    "__sbSubtleNext",
  );
  expect(wrap(handler("new crypto.DigestStream('SHA-1');"), "auto")).toContain("__sbSubtleNext");
  expect(wrap(handler("if (k instanceof CryptoKey) {}"), "auto")).toContain("__sbSubtleNext");
  expect(wrap(handler(""), "auto")).not.toContain("__sbSubtleNext");
  expect(wrap(handler(""), "always")).toContain("__sbSubtleNext");
});

test("a prelude without the markers is an error, not a silent no-op", () => {
  expect(() => pruneSubtle("function f() {}")).toThrow(/no \/\/ SUBTLE-JS:BEGIN/);
});
