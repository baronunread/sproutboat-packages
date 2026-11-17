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
  for (const spec of ['import fs from "node:fs";', 'import "node:fs";', 'export * from "node:fs";']) {
    const withNode = spec + '\nexport default { fetch() { return new Response("x"); } };';
    expect(validateHttpSyncSource(withNode, SOCKETS_DATE).ok).toBe(false);
  }
});

test("cloudflare:sockets needs the sockets date", () => {
  const app =
    'import { connect } from "cloudflare:sockets";\nexport default { fetch() { return new Response(String(typeof connect)); } };';
  const before = validateHttpSyncSource(app, "2026-11-16");
  expect(before.ok).toBe(false);
  expect(before.ok ? [] : before.errors).toContain(
    `cloudflare:sockets needs compatibility_date ${SOCKETS_DATE} or later`,
  );
  expect(validateHttpSyncSource(app, SOCKETS_DATE)).toEqual({ ok: true });
});

test("a dynamic import of cloudflare:workers (Alchemy) resolves to the runtime globals", () => {
  for (const quote of ['"', "'", "`"]) {
    const out = inlineWorkersImports(
      `const p = import(${quote}cloudflare:workers${quote}).catch(() => ({ env: {} }));`,
    );
    expect(out).toContain("Promise.resolve({ env: globalThis.env, WorkerEntrypoint: globalThis.WorkerEntrypoint");
    expect(out).toContain(".catch(() => ({ env: {} }))");
    expect(out).not.toContain("import(");
  }
});

test("a dynamic import of cloudflare:workers passes the source check and keeps other dynamic imports refused", () => {
  const app = `const p = import("cloudflare:workers").catch(() => ({ env: {} }));\nexport default { async fetch() { return new Response(typeof (await p).env); } };`;
  expect(validateHttpSyncSource(app, "2026-11-18")).toEqual({ ok: true });
  expect(validateHttpSyncSource(app.replace("cloudflare:workers", "./other.js"), "2026-11-18").ok).toBe(false);
});
