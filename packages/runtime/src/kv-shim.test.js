// The KV shim (`env.KV`) at compatibility dates before and from 2026-10-25, over an
// in-memory transport with the kv.* contract both transports implement (broker.test.ts
// covers the broker's side; sproutd's conformance/bindings/kv.js the whole path).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./native-fetch-prelude.js", import.meta.url), "utf8");
let rows;
const call = (json) => {
  const msg = JSON.parse(json);
  const reply = (() => {
    if (msg.op === "kv.get") {
      const r = rows.get(msg.key);
      return r ? { ok: true, found: true, value: r.value, binary: r.binary, metadata: r.metadata ?? null, expiration: r.expiration ?? null } : { ok: true, found: false, value: null };
    }
    if (msg.op === "kv.put") {
      rows.set(msg.key, { value: msg.value, binary: msg.binary === true, metadata: msg.metadata, expiration: msg.expiration ?? (msg.expirationTtl ? Math.floor(Date.now() / 1000) + msg.expirationTtl : undefined) });
      return { ok: true };
    }
    if (msg.op === "kv.delete") {
      rows.delete(msg.key);
      return { ok: true };
    }
    if (msg.op === "kv.list") {
      const keys = [...rows.keys()].filter((k) => k.startsWith(msg.prefix) && (!msg.cursor || k > msg.cursor)).sort();
      const limit = msg.limit ?? keys.length;
      const page = keys.slice(0, limit);
      const complete = keys.length <= limit;
      return {
        ok: true,
        keys: page,
        entries: page.map((k) => ({ name: k, expiration: rows.get(k).expiration ?? null, metadata: rows.get(k).metadata ?? null })),
        list_complete: complete,
        cursor: complete ? "" : page[page.length - 1],
      };
    }
    return { ok: false, error: "unknown op" };
  })();
  return JSON.stringify(reply);
};
// oxlint-disable-next-line no-function-constructor -- the prelude is prepended as text in production too
const { makeEnv } = new Function(
  "Porffor",
  "__testCall",
  `${source}\n__sbCall = __testCall; return { makeEnv: (target) => { __sbInstallBindings(target, { kv: ["KV"] }); return target; } };`,
)({ c: () => "" }, call);
const fresh = (date) => {
  globalThis.__sbCompat = date;
  rows = new Map();
  return makeEnv({}).KV;
};
const failure = async (fn) => {
  try {
    await fn();
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
  return "did not throw";
};

test("before 2026-10-25: the synchronous shim, unchanged", () => {
  const KV = fresh("2026-10-24");
  expect(KV.put("a", "v")).toBeUndefined();
  expect(KV.get("a")).toBe("v");
  expect(KV.list("a")).toEqual(["a"]);
  expect(KV.getWithMetadata).toBeUndefined();
});

test("from 2026-10-25: Promises, metadata, typed gets and get(keys)", async () => {
  const KV = fresh("2026-10-25");
  expect(KV.put("a", "v", { metadata: { n: 1 } })).toBeInstanceOf(Promise);
  await KV.put("a", '{"x":1}', { metadata: { n: 1 } });
  expect(await KV.get("a", "json")).toEqual({ x: 1 });
  expect(await KV.get("a", { type: "text" })).toBe('{"x":1}');
  expect(await KV.getWithMetadata("a", "json")).toEqual({ value: { x: 1 }, metadata: { n: 1 }, cacheStatus: null });
  expect(await KV.getWithMetadata("missing")).toEqual({ value: null, metadata: null, cacheStatus: null });
  await KV.put("b", new Uint8Array([0, 255]));
  expect(Array.from(new Uint8Array(await KV.get("b", "arrayBuffer")))).toEqual([0, 255]);
  // (ReadableStream values and the "stream" type use the prelude's own streams: checked end to
  // end by sproutd's conformance/bindings/kv.js, not here against Bun's.)
  const many = await KV.get(["a", "missing"]);
  expect(many).toBeInstanceOf(Map);
  expect([...many.entries()]).toEqual([["a", '{"x":1}'], ["missing", null]]);
  expect(await KV.delete("a")).toBeUndefined();
  expect(await KV.get("a")).toBeNull();
});

test("from 2026-10-25: KV's errors for keys, values, expiration and metadata", async () => {
  const KV = fresh("2026-10-25");
  expect(await failure(() => KV.put("", "v"))).toBe("TypeError: Key name cannot be empty.");
  expect(await failure(() => KV.put("..", "v"))).toBe('TypeError: ".." is not allowed as a key name.');
  expect(await failure(() => KV.put("k".repeat(513), "v"))).toBe("Error: KV PUT failed: 414 UTF-8 encoded length of 513 exceeds key length limit of 512.");
  expect(await failure(() => KV.get("k".repeat(513)))).toBe("Error: KV GET failed: 414 UTF-8 encoded length of 513 exceeds key length limit of 512.");
  expect(await failure(() => KV.put("a", { a: 1 }))).toBe("TypeError: KV put() accepts only strings, ArrayBuffers, ArrayBufferViews, and ReadableStreams as values.");
  expect(await failure(() => KV.put("a", "v", { expirationTtl: 30 }))).toBe("Error: KV PUT failed: 400 Invalid expiration_ttl of 30. Expiration TTL must be at least 60.");
  expect(await failure(() => KV.put("a", "v", { expirationTtl: "soon" }))).toBe("Error: KV PUT failed: 400 Invalid expiration_ttl of 0. Please specify integer greater than 0.");
  expect(await failure(() => KV.put("a", "v", { expiration: 1000 }))).toBe(
    "Error: KV PUT failed: 400 Invalid expiration of 1000. Please specify integer greater than the current number of seconds since the UNIX epoch.",
  );
  expect(await failure(() => KV.put("a", "v", { metadata: { big: "x".repeat(1100) } }))).toBe("Error: KV PUT failed: 413 Metadata length of 1110 exceeds limit of 1024.");
  expect(await KV.get("missing", "nope")).toBeNull();
  await KV.put("there", "v");
  expect(await failure(() => KV.get("there", "nope"))).toBe('TypeError: Unknown response type. Possible types are "text", "arrayBuffer", "json", and "stream".');
  expect(await failure(() => KV.list({ limit: 1001 }))).toBe("Error: KV GET failed: 400 Invalid key_count_limit of 1001. Please specify an integer less than 1000.");
  // A failing get rejects rather than throws.
  const rejected = KV.get("");
  expect(rejected).toBeInstanceOf(Promise);
  expect(await rejected.catch((e) => e.message)).toBe("Key name cannot be empty.");
});

test("from 2026-10-25: list() pages with limit and cursor, with expiration and metadata", async () => {
  const KV = fresh("2026-10-25");
  for (const k of ["b", "a", "c"]) await KV.put(k, "v", k === "a" ? { metadata: { t: 1 }, expirationTtl: 3600 } : undefined);
  const first = await KV.list({ limit: 2 });
  expect(first.keys.map((k) => k.name)).toEqual(["a", "b"]);
  expect(first.keys[0].metadata).toEqual({ t: 1 });
  expect(Number.isInteger(first.keys[0].expiration)).toBe(true);
  expect("expiration" in first.keys[1]).toBe(false);
  expect(first.list_complete).toBe(false);
  const rest = await KV.list({ limit: 2, cursor: first.cursor });
  expect(rest.keys.map((k) => k.name)).toEqual(["c"]);
  expect(Object.keys(rest).sort()).toEqual(["cacheStatus", "keys", "list_complete"]);
  expect(await KV.list({ limit: 0 })).toEqual({ keys: [], list_complete: true, cacheStatus: null });
});
