// #179 — an uncaught handler exception must turn into a 500 (or, for
// scheduled/queue/alarm, a swallowed failure), never a process-crashing
// throw/rejection out of __sbEntry. Same lift-the-prelude-and-eval approach
// as client-ip.test.js: the prelude is prepended as text and cannot import.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("./native-fetch-prelude.js", import.meta.url)), "utf8");

// oxlint-disable-next-line no-function-constructor -- lifting the whole text-only prelude for test
const load = new Function(
  "Porffor",
  "__envMap",
  `${src}
   return { __sbEntry, __sbRegisterDO };`,
);
// Every Porffor.c`...` block in the prelude only runs inside a function body
// (never at load time), so a no-op tag covers all of them: __sbCpuMs and
// __sbEnv just see an empty result, same as "native op returned nothing."
const H = load(
  { c: () => "" },
  new Proxy({}, { get: () => undefined }),
);

const req = (overrides = {}) => ({
  headers: { get: (k) => (overrides.headers && overrides.headers[k.toLowerCase()]) ?? null },
  cf: undefined,
  ...overrides,
});

test("a synchronously-throwing fetch handler returns 500, not a throw", async () => {
  const handlers = {
    fetch() {
      throw new Error("boom");
    },
  };
  const res = await H.__sbEntry(handlers, req());
  expect(res.status).toBe(500);
});

test("an async fetch handler whose promise rejects returns 500, not a rejection", async () => {
  const handlers = {
    async fetch() {
      throw new Error("boom");
    },
  };
  const res = await H.__sbEntry(handlers, req());
  expect(res.status).toBe(500);
});

test("a throwing fetch handler doesn't stop the next request from being served", async () => {
  const handlers = {
    fetch(request) {
      if (request.boom) throw new Error("boom");
      return new Response("ok");
    },
  };
  const first = await H.__sbEntry(handlers, req({ boom: true }));
  expect(first.status).toBe(500);
  const second = await H.__sbEntry(handlers, req({ boom: false }));
  expect(await second.text()).toBe("ok");
});
