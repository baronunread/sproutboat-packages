import { expect, test } from "bun:test";
import { inlineWorkersImports } from "./wrap";
import { SOCKETS_DATE, validateHttpSyncSource } from "./source";

test("cloudflare:sockets imports become the prelude's connect", () => {
  const out = inlineWorkersImports('import { connect } from "cloudflare:sockets";\nconst x = 1;');
  expect(out).toContain("const { connect } = globalThis.__sbSockets;");
  expect(inlineWorkersImports('import { connect as dial } from "cloudflare:sockets";')).toContain(
    "const { connect: dial } = globalThis.__sbSockets;",
  );
});

test("a lazy import of cloudflare:sockets (postgres/cf, pg-cloudflare) resolves to the same object", () => {
  const out = inlineWorkersImports('const { connect } = await import("cloudflare:sockets");');
  expect(out).toBe("const { connect } = await Promise.resolve(globalThis.__sbSockets);");
});

const handler = "export default { fetch() { return new Response(Buffer.from('a').toString() + process.nextTick); } };";

test("Buffer and process in a bundle are refused before the sockets date and allowed from it", () => {
  expect(validateHttpSyncSource(handler, "2026-09-14").ok).toBe(false);
  expect(validateHttpSyncSource(handler, SOCKETS_DATE)).toEqual({ ok: true });
});

test("a node: import specifier is still refused from the sockets date", () => {
  const withNode = "export default { fetch() { return new Response('node:fs'.length + \"\"); } };".replace(
    "'node:fs'",
    '"node:fs"',
  );
  expect(validateHttpSyncSource(withNode, SOCKETS_DATE).ok).toBe(false);
});
