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

// ---- 2026-11-05 ----

const failure = (p) =>
  p.then(
    () => "accepted",
    (e) => e.name + ": " + e.message,
  );

test("2026-11-05: send() checks arguments and delays as workerd does", async () => {
  const { QUEUE } = env("2026-11-05");
  expect(await failure(QUEUE.send())).toBe(
    "TypeError: Failed to execute 'send' on 'WorkerQueue': parameter 1 is not of type 'JsValue'.",
  );
  expect(await failure(QUEUE.send(1, "x"))).toBe(
    "TypeError: Failed to execute 'send' on 'WorkerQueue': parameter 2 is not of type 'SendOptions'.",
  );
  expect(await failure(QUEUE.send(1, null))).toBe("accepted");
  expect(await failure(QUEUE.send(1, { delaySeconds: -1 }))).toStartWith("Error: Queue send failed: delaySeconds");
  expect(await failure(QUEUE.send(1, { delaySeconds: 86401 }))).toStartWith("Error: Queue send failed: delaySeconds");
  expect(await failure(QUEUE.send(1, { delaySeconds: 86400 }))).toBe("accepted");
  expect(await failure(QUEUE.send(1, { delaySeconds: 1.5 }))).toBe("accepted");
  expect(await failure(QUEUE.sendBatch([{ body: 1 }], { delaySeconds: 86401 }))).toStartWith(
    "Error: Queue send failed",
  );
  expect(await failure(QUEUE.sendBatch([{ body: 1, delaySeconds: -5 }]))).toStartWith("Error: Queue send failed");
  expect(await failure(QUEUE.sendBatch([1, 2]))).toBe(
    "TypeError: Incorrect type: the provided value is not of type 'MessageSendRequest'.",
  );
  expect(await failure(QUEUE.send(new Uint8Array([1]).buffer, { contentType: "bytes" }))).toBe(
    'TypeError: Content Type "bytes" requires a value of type ArrayBufferView, but received: object',
  );
  expect(await failure(QUEUE.send(new Uint8Array([1]), { contentType: "bytes" }))).toBe("accepted");
});

test("before 2026-11-05 the same arguments are accepted or answer as before", async () => {
  const { QUEUE } = env("2026-11-01");
  expect(await failure(QUEUE.send(1, { delaySeconds: 86401 }))).toBe("accepted");
  expect(await failure(QUEUE.send(1, "x"))).toBe("accepted");
  expect(await failure(QUEUE.sendBatch([{ body: 1, delaySeconds: -5 }]))).toBe("accepted");
  expect(await failure(QUEUE.send(new Uint8Array([1]).buffer, { contentType: "bytes" }))).toBe("accepted");
  expect(await failure(QUEUE.send())).toBe("TypeError: Message body cannot be undefined");
  expect(sent.find((r) => r.delaySeconds === 86401)).toBeDefined();
});

const roundTrip = async (compat, value) => {
  const { QUEUE } = env(compat);
  await QUEUE.send(value, { contentType: "v8" });
  const body = sent[sent.length - 1].body;
  let seen;
  await run(
    {
      queue(batch) {
        seen = batch.messages[0];
      },
    },
    { queue: "QUEUE", messages: [message("a", body)] },
    ctx,
  );
  return { body, seen };
};

test("2026-11-05: the v8 content type keeps shared and circular references, holes and invalid dates", async () => {
  const shared = { z: 1 };
  const circular = { n: 1 };
  circular.self = circular;
  const holes = [1];
  holes[3] = 4;
  const { body, seen } = await roundTrip("2026-11-05", {
    a: shared,
    b: shared,
    c: circular,
    holes,
    d: new Date(NaN),
    e: new TypeError("boom"),
    m: new Map([[shared, new Set([shared])]]),
  });
  expect(body.startsWith("#sbq1:v8r:")).toBe(true);
  const v = seen.body;
  expect(v.a).toBe(v.b);
  expect(v.c.self).toBe(v.c);
  expect(v.holes.length).toBe(4);
  expect(1 in v.holes).toBe(false);
  expect(v.holes[3]).toBe(4);
  expect(Number.isNaN(v.d.getTime())).toBe(true);
  expect(v.e).toBeInstanceOf(TypeError);
  expect(v.e.message).toBe("boom");
  const [key, set] = [...v.m][0];
  expect(key).toBe(v.a);
  expect([...set][0]).toBe(v.a);
  expect(Object.getOwnPropertyDescriptor(seen, "body").writable).toBe(false);
  expect(Object.getOwnPropertyDescriptor(seen, "id").writable).toBe(false);
});

test("before 2026-11-05 the v8 content type is the earlier codec, and v8r messages decode at any date", async () => {
  const { body, seen } = await roundTrip("2026-11-01", { d: new Date(1000), m: new Map([[1, 2]]) });
  expect(body.startsWith("#sbq1:v8:")).toBe(true);
  expect(seen.body.m.get(1)).toBe(2);
  const circular = {};
  circular.self = circular;
  const later = await roundTrip("2026-11-05", circular);
  globalThis.__sbCompat = "2026-10-31";
  let again;
  await run(
    {
      queue(batch) {
        again = batch.messages[0].body;
      },
    },
    { queue: "QUEUE", messages: [message("a", later.body)] },
    ctx,
  );
  expect(again.self).toBe(again);
  expect(Object.getOwnPropertyDescriptor(seen, "body").writable).toBe(true);
});

test("2026-11-05: a consumer announces its queue to the store before the handler runs", async () => {
  globalThis.__sbCompat = "2026-11-05";
  sent = [];
  let at;
  await run(
    {
      queue() {
        at = sent.length;
      },
    },
    { queue: "QUEUE", messages: [message("a", "1")] },
    ctx,
  );
  expect(sent[0]).toMatchObject({ op: "queue.consumer", queue: "QUEUE" });
  expect(at).toBe(1);
  globalThis.__sbCompat = "2026-11-01";
  sent = [];
  await run({ queue() {} }, { queue: "QUEUE", messages: [message("a", "1")] }, ctx);
  expect(sent).toEqual([]);
});
