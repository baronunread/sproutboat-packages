// R2 get() reads an object as asked (sproutd #99): a range reads only its window, a body streams one chunk at
// a time, and nothing reads the whole object unless text(), json(), arrayBuffer() or blob() ask for all of it.
// The prelude is text, so this lifts the strict R2 object block out and runs it against a fake file whose reads
// are recorded, as r2-object.test.js does for the legacy object.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("./native-fetch-prelude.js", import.meta.url)), "utf8");
const start = src.indexOf("function __sbR2Key(");
const end = src.indexOf("function __sbMakeR2(");
const isStrStart = src.indexOf("function __sbIsStr(");
const isStrEnd = src.indexOf("function __sbIsFn(");
const bytesStart = src.indexOf("const __SB_BYTES_WINDOW");
const utf8Start = src.indexOf("function __sbBufFrom(");
const utf8End = src.indexOf("function __sbRawBodyResponse(");
const lazyStart = src.indexOf("const __SB_R2_CHUNK");
if (
  [start, end, isStrStart, isStrEnd, bytesStart, utf8Start, utf8End, lazyStart].some((i) => i === -1) ||
  end < start ||
  lazyStart < start ||
  lazyStart > end
)
  throw new Error("the strict R2 object block moved in the prelude");

// oxlint-disable-next-line no-function-constructor -- lifting pure blocks out of the text-only prelude for test
const load = new Function(
  "__sbR2ReadRange",
  `function __sbFromUtf8Native() { return ""; }\nfunction __sbToBytesNative() { return ""; }\nfunction __sbFillBytes() { return false; }\n${src.slice(isStrStart, isStrEnd)}\n${src.slice(bytesStart, utf8Start)}\n${src.slice(utf8Start, utf8End)}\n${src.slice(start, end)}\nreturn { __sbR2StrictObject, __SB_R2_CHUNK };`,
);

// An "object file" of SIZE bytes, byte i being i % 251, and the reads asked of it.
const reads = [];
const file = (size) => (_bucket, _key, _blob, offset, view) => {
  reads.push({ offset, length: view.length });
  const n = Math.max(0, Math.min(view.length, size - offset));
  for (let i = 0; i < n; i++) view[i] = (offset + i) % 251;
  return n;
};
const meta = (size) => ({ key: "big.bin", size, etag: "abc123", uploaded: "2026-09-14T00:00:00.000Z" });
const lazy = { lazy: true, bucket: "B", key: "big.bin", blobId: "abc123" };
const drain = async (stream) => {
  const reader = stream.getReader();
  const chunks = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
};

test("a body streams in chunks and never reads the object whole", async () => {
  const { __sbR2StrictObject, __SB_R2_CHUNK } = load(file(3 * 1024 * 1024 + 100));
  reads.length = 0;
  const obj = __sbR2StrictObject(meta(3 * 1024 * 1024 + 100), lazy, { offset: 0, length: 3 * 1024 * 1024 + 100 });
  expect(reads.length).toBe(0);
  const chunks = await drain(obj.body);
  expect(chunks.length).toBe(Math.ceil((3 * 1024 * 1024 + 100) / __SB_R2_CHUNK));
  expect(Math.max(...reads.map((r) => r.length))).toBe(__SB_R2_CHUNK);
  expect(reads.map((r) => r.offset)).toEqual(chunks.map((_, i) => i * __SB_R2_CHUNK));
  expect(chunks[0][250]).toBe(250);
  expect(chunks[1][0]).toBe(__SB_R2_CHUNK % 251);
});

test("a range reads only its window", async () => {
  const { __sbR2StrictObject } = load(file(10 * 1024 * 1024));
  reads.length = 0;
  const range = { offset: 5 * 1024 * 1024 + 7, length: 1000 };
  const obj = __sbR2StrictObject(meta(10 * 1024 * 1024), lazy, range);
  const chunks = await drain(obj.body);
  expect(chunks.length).toBe(1);
  expect(reads).toEqual([{ offset: range.offset, length: 1000 }]);
  expect(chunks[0].length).toBe(1000);
  expect(chunks[0][0]).toBe(range.offset % 251);
});

test("arrayBuffer() and text() read the window in one read", async () => {
  const { __sbR2StrictObject } = load(file(600));
  reads.length = 0;
  const range = { offset: 100, length: 400 };
  const obj = __sbR2StrictObject(meta(600), lazy, range);
  const buffer = await obj.arrayBuffer();
  expect(buffer.byteLength).toBe(400);
  expect(new Uint8Array(buffer)[0]).toBe(100);
  expect(reads).toEqual([{ offset: 100, length: 400 }]);
  await expect(obj.text()).rejects.toThrow(/already been used/);
});

test("an empty window closes at once without reading", async () => {
  const { __sbR2StrictObject } = load(file(0));
  reads.length = 0;
  const obj = __sbR2StrictObject(meta(0), lazy, { offset: 0, length: 0 });
  expect((await drain(obj.body)).length).toBe(0);
  expect(reads.length).toBe(0);
});

test("a read that cannot be completed errors the stream", async () => {
  const { __sbR2StrictObject } = load(() => -1);
  const obj = __sbR2StrictObject(meta(100), lazy, { offset: 0, length: 100 });
  await expect(drain(obj.body)).rejects.toThrow(/could not be read/);
});
