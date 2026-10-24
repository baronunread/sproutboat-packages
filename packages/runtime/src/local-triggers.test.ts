import { expect, test } from "bun:test";
import { validateHttpSyncSource } from "./source";
import { EMPTY_BINDINGS, wrapNativeFetchHandler } from "./wrap";

// B22: a Worker may export only scheduled() or queue(), as on workerd (Cloudflare's
// cron-trigger example), and a Worker with crons but no other binding gets its triggers.
const cronOnly = `export default { async scheduled(controller, env, ctx) { console.log("cron"); } };`;
const queueOnly = `export default { async queue(batch, env) { batch.ackAll(); } };`;

test("scheduled() or queue() alone is a valid entry", () => {
  expect(validateHttpSyncSource(cronOnly)).toEqual({ ok: true });
  expect(validateHttpSyncSource(queueOnly)).toEqual({ ok: true });
  expect(validateHttpSyncSource(`export default { hello() { return 1; } };`).ok).toBe(false);
});

test("crons alone start the local triggers", () => {
  const out = wrapNativeFetchHandler(cronOnly, "/*prelude*/", {}, { ...EMPTY_BINDINGS, crons: ["* * * * *"] });
  expect(out).toContain("__sbStartLocalTriggers(__sbHandlers, {");
  expect(out).toContain('"crons":["* * * * *"]');
});

test("a Worker with no bindings and no crons starts none", () => {
  const out = wrapNativeFetchHandler(`export default { fetch() { return new Response("x"); } };`, "/*prelude*/");
  expect(out).not.toContain("__sbStartLocalTriggers(");
});
