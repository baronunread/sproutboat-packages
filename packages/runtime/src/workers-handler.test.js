import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./native-fetch-prelude.js", import.meta.url), "utf8");
// oxlint-disable-next-line no-function-constructor -- the prelude is prepended as text in production too
const load = new Function(
  "Porffor",
  `${source}\n__sbTriggerAuthed = () => true; return { entry: __sbEntry, queue: __sbRunQueueBatch };`,
);
const { entry, queue } = load({ c: () => "" });
const request = () => ({ headers: { get: () => null }, body: null });

test("the Workers compatibility date passes env and ctx in their standard positions", async () => {
  globalThis.__sbCompat = "2026-09-28";
  globalThis.env = { GREETING: "hello" };
  const response = entry({ fetch(_request, env, ctx) {
    return new Response(env.GREETING + ":" + (ctx.waitUntil instanceof Function));
  } }, request());
  expect(await response.text()).toBe("hello:true");
});

test("earlier compatibility dates retain ctx as the second argument", async () => {
  globalThis.__sbCompat = "2026-09-07";
  const response = entry({ fetch(_request, ctx) {
    return new Response(String(ctx.waitUntil instanceof Function));
  } }, request());
  expect(await response.text()).toBe("true");
});

test("Response.redirect produces a Location header and empty body", async () => {
  const response = Response.redirect("https://example.com/next", 301);
  expect(response.status).toBe(301);
  expect(response.headers.get("location")).toBe("https://example.com/next");
  expect(await response.text()).toBe("");
});

test("queue handlers receive env and ctx with the Workers compatibility date", async () => {
  globalThis.__sbCompat = "2026-09-28";
  globalThis.env = { GREETING: "hello" };
  let seen = "";
  await queue({ queue(_batch, env, ctx) {
    seen = env.GREETING + ":" + (ctx.waitUntil instanceof Function);
  } }, { messages: [] }, { waitUntil() {} });
  expect(seen).toBe("hello:true");
});

test("scheduled handlers receive env and ctx with the Workers compatibility date", () => {
  globalThis.__sbCompat = "2026-09-28";
  globalThis.env = { GREETING: "hello" };
  let seen = "";
  const response = entry({ scheduled(_event, env, ctx) {
    seen = env.GREETING + ":" + (ctx.waitUntil instanceof Function);
  } }, {
    headers: { get: (name) => name === "x-sb-trigger" ? "scheduled" : null },
    body: "{}",
  });
  expect(response.status).toBe(204);
  expect(seen).toBe("hello:true");
});
