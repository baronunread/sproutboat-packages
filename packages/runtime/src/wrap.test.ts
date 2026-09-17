import { expect, test } from "bun:test";
import { EMPTY_BINDINGS, wrapNativeFetchHandler } from "./wrap";

const handler = "export default { fetch() { return new Response('ok'); } };";

test("direct R2 transfer ABI is emitted only for an R2 binding", () => {
  const empty = wrapNativeFetchHandler(handler, "", {}, EMPTY_BINDINGS);
  expect(empty).not.toContain("sb_r2_transfer_open");

  const r2 = wrapNativeFetchHandler(handler, "", {}, { ...EMPTY_BINDINGS, r2: ["OBJECTS"] });
  expect(r2).toContain("sb_r2_transfer_open");
});

test("scrypt remains available without a capability declaration", () => {
  const wrapped = wrapNativeFetchHandler(handler, "sb_scrypt", {}, EMPTY_BINDINGS);
  expect(wrapped).toContain("sb_scrypt");
});
