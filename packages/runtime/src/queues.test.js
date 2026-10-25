import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Queues from compatibility date 2026-10-31 (producer checks and content types, the
// consumer's message and batch, first-call-wins, retry settings), against a fake transport.
const source = readFileSync(new URL("./native-fetch-prelude.js", import.meta.url), "utf8");
// oxlint-disable-next-line no-function-constructor -- the prelude is prepended as text in production too
const load = new Function(
  "Porffor",
  `var __sbCall = (text) => globalThis.__sbTestCall(text);\n${source}\nreturn { install: __sbInstallBindings, run: __sbRunQueueBatch };`,
);
const { install, run } = load({ c: () => "" });

let sent = [];
globalThis.__sbTestCall = (text) => {
  const req = JSON.parse(text);
  sent.push(req);
  return JSON.stringify({ ok: true, metrics: { backlogCount: 1, backlogBytes: 7, oldestMessageTimestamp: 1000 } });
};
afterEach(() => {
  sent = [];
});

const bindings = {
  queues: ["QUEUE", "DLQ"],
  queueConfig: [
    { binding: "QUEUE", queue: "q", maxRetries: 3, deadLetterQueue: "dlq" },
    { binding: "DLQ", queue: "dlq" },
  ],
};
const env = (compat) => {
  globalThis.__sbCompat = compat;
  const target = {};
  install(target, bindings);
  return target;
};
const ctx = { waitUntil() {} };

test("2026-10-31: send() returns a promise of the backlog and keeps the content type", async () => {
  const { QUEUE } = env("2026-10-31");
  const result = QUEUE.send("123");
  expect(result).toBeInstanceOf(Promise);
  expect(await result).toEqual({
    metadata: { metrics: { backlogCount: 1, backlogBytes: 7, oldestMessageTimestamp: 1000 } },
  });
  expect(sent[0].body).toBe('#sbq1:json:"123"');
  await QUEUE.send("plain", { contentType: "text" });
  await QUEUE.send(new Uint8Array([7, 8]), { contentType: "bytes" });
  await QUEUE.send(new Map([[1, 2]]), { contentType: "v8" });
  expect(sent.map((r) => r.body.split(":")[1])).toEqual(["json", "text", "bytes", "v8"]);
});

test("2026-10-31: send() and sendBatch() reject what workerd rejects", async () => {
  const { QUEUE } = env("2026-10-31");
  const error = (p) =>
    p.then(
      () => "accepted",
      (e) => e.name + ": " + e.message,
    );
  expect(await error(QUEUE.send(undefined))).toBe("TypeError: Message body cannot be undefined");
  expect(await error(QUEUE.send({ b: 1n }))).toBe("TypeError: Do not know how to serialize a BigInt");
  expect(await error(QUEUE.send({}, { contentType: "text" }))).toBe(
    'TypeError: Content Type "text" requires a value of type string, but received: object',
  );
  expect(await error(QUEUE.send("x", { contentType: "xml" }))).toBe(
    "TypeError: Unsupported queue message content type: xml",
  );
  expect(await error(QUEUE.send("x".repeat(128 * 1024 + 1)))).toStartWith("Error: ");
  expect(await error(QUEUE.sendBatch([]))).toBe("TypeError: sendBatch() requires at least one message");
  expect(await error(QUEUE.sendBatch({ body: 1 }))).toStartWith("TypeError: Failed to execute 'sendBatch'");
  expect(await error(QUEUE.sendBatch(Array.from({ length: 101 }, () => ({ body: 1 }))))).toStartWith("Error: ");
  expect(sent).toEqual([]);
});

test("before 2026-10-31 send() is unchanged", () => {
  const { QUEUE } = env("2026-10-29");
  expect(QUEUE.send("123")).toBeUndefined();
  expect(sent[0].body).toBe("123");
});

const message = (id, body, attempts = 1) => ({ id, body, timestamp: 5000, attempts });

test("2026-10-31: message and batch shapes, decoded bodies, and the queue's name", async () => {
  globalThis.__sbCompat = "2026-10-31";
  let seen;
  await run(
    {
      queue(batch) {
        seen = batch;
      },
    },
    {
      queue: "QUEUE",
      messages: [message("a", '#sbq1:text:{"a":1}'), message("b", "#sbq1:bytes:0708")],
      metadata: { metrics: { backlogCount: 2 } },
    },
    ctx,
  );
  expect(seen.queue).toBe("q");
  expect(Object.keys(seen).sort()).toEqual(["messages", "metadata", "queue"]);
  expect(Object.keys(seen.messages[0]).sort()).toEqual(["attempts", "body", "id", "timestamp"]);
  expect(seen.messages[0].timestamp).toEqual(new Date(5000));
  expect(seen.messages[0].body).toBe('{"a":1}');
  expect(new Uint8Array(seen.messages[1].body)).toEqual(new Uint8Array([7, 8]));
  expect(seen.metadata.metrics.backlogCount).toBe(2);
});

test("2026-10-31: the first of ack() and retry() wins, and a message's own call beats the batch's", async () => {
  globalThis.__sbCompat = "2026-10-31";
  const out = await run(
    {
      queue(batch) {
        batch.messages[0].ack();
        batch.messages[0].retry();
        batch.messages[1].retry({ delaySeconds: 7 });
        batch.retryAll();
        throw new Error("after the decisions");
      },
    },
    { queue: "QUEUE", messages: [message("a", "1"), message("b", "2"), message("c", "3")] },
    ctx,
  );
  expect(out.ack).toEqual(["a"]);
  expect(out.retry).toEqual(["b", "c"]);
  expect(out.delays).toEqual({ b: 7, c: 0 });
});

test("max_retries: a retry past it goes to the dead letter queue's binding", async () => {
  globalThis.__sbCompat = "2026-10-31";
  const out = await run(
    {
      queue(batch) {
        batch.retryAll();
      },
    },
    { queue: "QUEUE", messages: [message("a", "1", 3), message("b", "2", 4)] },
    ctx,
  );
  expect(out.retry).toEqual(["a", "b"]);
  expect(out.dead).toEqual(["b"]);
  expect(out.deadLetter).toBe("DLQ");
});

test("before 2026-10-31 without settings, the outcome has only ack and retry", async () => {
  globalThis.__sbCompat = "2026-10-29";
  let legacy;
  const out = await run(
    {
      queue(batch) {
        legacy = [batch.queue, Object.keys(batch.messages[0]).includes("ack"), batch.messages[0].timestamp];
        throw new Error("retry all");
      },
    },
    { queue: "DLQ", messages: [message("a", '{"a":1}')] },
    ctx,
  );
  expect(legacy).toEqual(["dlq", true, 5000]);
  expect(out).toEqual({ ack: [], retry: ["a"] });
});
