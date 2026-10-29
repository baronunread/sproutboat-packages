import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBroker,
  cronMatches,
  encodeFrame,
  frameOf,
  encodeV1,
  listen,
  listenTransfers,
  type Broker,
  type Frame,
  type FetchLike,
} from "./broker";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { walkAssets, type AssetManifest } from "@sproutboat/assets";
import { jsonObject, parseJsonValue, type JsonObject, type JsonValue } from "./json";

/** Reply frames are JSON; these narrow one field down to what an assertion reads. */
const obj = (value: JsonValue | undefined): JsonObject => jsonObject(value ?? null) ?? {};
const arr = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : []);

const brokers: Broker[] = [];
afterEach(() => {
  for (const b of brokers) b.close();
  brokers.length = 0;
});

function make(opts: Parameters<typeof createBroker>[0] = {}): Broker {
  // A public address, so fetch tests are about fetch and not about DNS (#174).
  const b = createBroker({ resolveImpl: async () => [{ address: "93.184.216.34" }], ...opts });
  brokers.push(b);
  return b;
}

test("a stale queue acknowledgement cannot remove a newer delivery claim", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-claim-fence-"));
  const path = join(root, "state.sqlite");
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const finishFirst = Promise.withResolvers<Response>();
  const finishSecond = Promise.withResolvers<Response>();
  let enabled = false;
  const a = createBroker({
    db: path,
    bindings: { queues: ["JOBS"] },
    sproutUrl: "http://127.0.0.1:1/",
    deliveryTimeoutMs: 2_000,
    deliveryLeaseMs: 3_000,
    fetchImpl: async () => {
      first.resolve();
      return finishFirst.promise;
    },
  });
  const b = createBroker({
    db: path,
    bindings: { queues: ["JOBS"] },
    sproutUrl: "http://127.0.0.1:1/",
    dispatchEnabled: () => enabled,
    deliveryTimeoutMs: 2_000,
    deliveryLeaseMs: 3_000,
    fetchImpl: async () => {
      second.resolve();
      return finishSecond.promise;
    },
  });
  const inspect = new Database(path);
  try {
    await a.dispatch({ op: "queue.send", queue: "JOBS", body: "work" });
    await first.promise;
    const row = inspect.query<{ id: string; claim_token: string }, []>("SELECT id,claim_token FROM mq").get()!;
    inspect.query("UPDATE mq SET visible_at=0").run();
    enabled = true;
    await second.promise;
    expect(inspect.query<{ claim_token: string }, []>("SELECT claim_token FROM mq").get()!.claim_token).not.toBe(
      row.claim_token,
    );
    finishFirst.resolve(Response.json({ ack: [row.id], retry: [] }));
    await Bun.sleep(30);
    expect(inspect.query<{ count: number }, []>("SELECT count(*) AS count FROM mq").get()!.count).toBe(1);
    finishSecond.resolve(Response.json({ ack: [row.id], retry: [] }));
    await Bun.sleep(30);
    expect(inspect.query<{ count: number }, []>("SELECT count(*) AS count FROM mq").get()!.count).toBe(0);
  } finally {
    a.close();
    b.close();
    inspect.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 5_000);

test("ping round-trips", async () => {
  const b = make();
  expect(await b.dispatch({ op: "ping", msg: "hi" })).toMatchObject({ ok: true, op: "pong", echo: "hi" });
});

test("a new alarm replaces exhausted delivery state and delete cancels durable retries", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-alarm-replace-"));
  const path = join(root, "state.sqlite");
  const broker = createBroker({ db: path, bindings: { do: [{ binding: "COUNTER", className: "Counter" }] } });
  const inspect = new Database(path);
  try {
    inspect.query("INSERT INTO do_alarm_delivery VALUES ('Counter','one',1,5,'old',0)").run();
    await broker.dispatch({ op: "do.alarm.set", cls: "Counter", id: "one", at: Date.now() + 60_000 });
    expect(inspect.query<{ count: number }, []>("SELECT count(*) AS count FROM do_alarm_delivery").get()!.count).toBe(
      0,
    );
    expect((await broker.dispatch({ op: "do.alarm.get", cls: "Counter", id: "one" })).at).toBeGreaterThan(Date.now());
    inspect.query("INSERT INTO do_alarm_delivery VALUES ('Counter','one',1,1,'active',9999999999999)").run();
    expect((await broker.dispatch({ op: "do.alarm.delete", cls: "Counter", id: "one" })).deleted).toBe(true);
    expect(inspect.query<{ count: number }, []>("SELECT count(*) AS count FROM do_alarm_delivery").get()!.count).toBe(
      0,
    );
    expect((await broker.dispatch({ op: "do.alarm.get", cls: "Counter", id: "one" })).at).toBeNull();
  } finally {
    inspect.close();
    broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized queue acknowledgement bodies are cancelled and retried", async () => {
  let cancelled = false;
  const delivered = Promise.withResolvers<void>();
  const root = mkdtempSync(join(tmpdir(), "sb-ack-bound-"));
  const path = join(root, "state.sqlite");
  const broker = createBroker({
    db: path,
    bindings: { queues: ["JOBS"] },
    sproutUrl: "http://127.0.0.1:1/",
    fetchImpl: async () => {
      delivered.resolve();
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(65_536));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    },
  });
  const inspect = new Database(path);
  try {
    await broker.dispatch({ op: "queue.send", queue: "JOBS", body: "work" });
    await delivered.promise;
    await Bun.sleep(40);
    expect(cancelled).toBe(true);
    const row = inspect
      .query<{ attempts: number; claim_token: string }, []>("SELECT attempts,claim_token FROM mq")
      .get()!;
    expect(row.attempts).toBe(1);
    expect(row.claim_token).toBe("");
  } finally {
    inspect.close();
    broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 3_000);

test("#233: a KV value put as bytes is flagged binary and survives an existing store", async () => {
  const b = make({ bindings: { kv: ["CACHE"] } });
  // One char per byte, as the runtime sends a put of an ArrayBuffer/view.
  const bytes = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join("");
  await b.dispatch({ op: "kv.put", ns: "CACHE", key: "bin", value: bytes, binary: true });
  await b.dispatch({ op: "kv.put", ns: "CACHE", key: "txt", value: "café" });
  expect(await b.dispatch({ op: "kv.get", ns: "CACHE", key: "bin" })).toMatchObject({
    ok: true,
    found: true,
    value: bytes,
    binary: true,
  });
  expect(await b.dispatch({ op: "kv.get", ns: "CACHE", key: "txt" })).toMatchObject({ value: "café", binary: false });
  // Overwriting a binary value with text clears the flag.
  await b.dispatch({ op: "kv.put", ns: "CACHE", key: "bin", value: "now text" });
  expect(await b.dispatch({ op: "kv.get", ns: "CACHE", key: "bin" })).toMatchObject({
    value: "now text",
    binary: false,
  });
});

test("KV put / get / list / delete, scoped to a bound namespace", async () => {
  const b = make({ bindings: { kv: ["CACHE"] } });
  expect(await b.dispatch({ op: "kv.get", ns: "CACHE", key: "k" })).toEqual({ ok: true, found: false, value: null });
  await b.dispatch({ op: "kv.put", ns: "CACHE", key: "k", value: "v" });
  await b.dispatch({ op: "kv.put", ns: "CACHE", key: "k2", value: "v2" });
  expect(await b.dispatch({ op: "kv.get", ns: "CACHE", key: "k" })).toMatchObject({
    ok: true,
    found: true,
    value: "v",
    binary: false,
  });
  expect(await b.dispatch({ op: "kv.list", ns: "CACHE", prefix: "k" })).toMatchObject({ ok: true, keys: ["k", "k2"] });
  await b.dispatch({ op: "kv.delete", ns: "CACHE", key: "k" });
  expect(await b.dispatch({ op: "kv.get", ns: "CACHE", key: "k" })).toMatchObject({ found: false });
});

test("KV metadata, expiration and paged list (the shim from 2026-10-25); the prefix matches exactly", async () => {
  const b = make({ bindings: { kv: ["CACHE"] } });
  const at = Math.floor(Date.now() / 1000) + 3600;
  await b.dispatch({ op: "kv.put", ns: "CACHE", key: "a", value: "1", metadata: '{"t":1}' });
  await b.dispatch({ op: "kv.put", ns: "CACHE", key: "b", value: "2", expiration: at });
  await b.dispatch({ op: "kv.put", ns: "CACHE", key: "c", value: "3" });
  await b.dispatch({ op: "kv.put", ns: "CACHE", key: "a_x", value: "4" });
  await b.dispatch({ op: "kv.put", ns: "CACHE", key: "AB", value: "5" });
  expect(await b.dispatch({ op: "kv.get", ns: "CACHE", key: "a" })).toMatchObject({
    metadata: '{"t":1}',
    expiration: null,
  });
  expect(await b.dispatch({ op: "kv.get", ns: "CACHE", key: "b" })).toMatchObject({ metadata: null, expiration: at });
  // LIKE matched "ab" for "a_" and "AB" for "a"; the prefix is now exact and case-sensitive.
  expect((await b.dispatch({ op: "kv.list", ns: "CACHE", prefix: "a_" })).keys).toEqual(["a_x"]);
  expect((await b.dispatch({ op: "kv.list", ns: "CACHE", prefix: "a" })).keys).toEqual(["a", "a_x"]);
  const first = await b.dispatch({ op: "kv.list", ns: "CACHE", prefix: "", limit: 2, cursor: "" });
  expect(first).toMatchObject({ keys: ["AB", "a"], list_complete: false, cursor: "a" });
  expect(first.entries).toEqual([
    { name: "AB", expiration: null, metadata: null },
    { name: "a", expiration: null, metadata: '{"t":1}' },
  ]);
  const rest = await b.dispatch({ op: "kv.list", ns: "CACHE", prefix: "", limit: 2, cursor: "a" });
  expect(rest).toMatchObject({ keys: ["a_x", "b"], list_complete: false, cursor: "b" });
  expect(await b.dispatch({ op: "kv.list", ns: "CACHE", prefix: "", limit: 2, cursor: "b" })).toMatchObject({
    keys: ["c"],
    list_complete: true,
    cursor: "",
  });
});

test("KV expirationTtl under 60 seconds is rejected, matching CF", async () => {
  const b = make({ bindings: { kv: ["CACHE"] } });
  await expect(b.dispatch({ op: "kv.put", ns: "CACHE", key: "k", value: "v", expirationTtl: 59 })).rejects.toThrow(
    "at least 60 seconds",
  );
});

test("a key past its expiration reads as absent and is omitted from list", async () => {
  const b = make({ bindings: { kv: ["CACHE"] } });
  const past = Math.floor((Date.now() - 1000) / 1000);
  await b.dispatch({ op: "kv.put", ns: "CACHE", key: "expired", value: "v", expiration: past });
  await b.dispatch({ op: "kv.put", ns: "CACHE", key: "fresh", value: "v", expirationTtl: 3600 });
  expect(await b.dispatch({ op: "kv.get", ns: "CACHE", key: "expired" })).toEqual({
    ok: true,
    found: false,
    value: null,
  });
  expect(await b.dispatch({ op: "kv.list", ns: "CACHE", prefix: "" })).toMatchObject({ ok: true, keys: ["fresh"] });
});

test("an unbound KV namespace is rejected", async () => {
  const b = make({ bindings: { kv: ["CACHE"] } });
  await expect(b.dispatch({ op: "kv.put", ns: "OTHER", key: "k", value: "v" })).rejects.toThrow("not bound");
});

test("cache.match on an empty cache is a plain miss", async () => {
  const b = make();
  expect(await b.dispatch({ op: "cache.match", key: "GET https://example.com/a" })).toEqual({
    ok: true,
    found: false,
  });
});

test("cache: put then match round-trips status/headers/body, deletes work, ambient (no binding needed)", async () => {
  const b = make();
  const key = "GET https://example.com/a";
  expect(
    await b.dispatch({ op: "cache.put", key, status: 200, headers: { "content-type": "text/plain" }, body: "hi" }),
  ).toEqual({ ok: true, stored: true });
  expect(await b.dispatch({ op: "cache.match", key })).toEqual({
    ok: true,
    found: true,
    status: 200,
    headers: { "content-type": "text/plain" },
    body: "hi",
  });
  expect(await b.dispatch({ op: "cache.delete", key })).toEqual({ ok: true, deleted: true });
  expect(await b.dispatch({ op: "cache.match", key })).toEqual({ ok: true, found: false });
  expect(await b.dispatch({ op: "cache.delete", key })).toEqual({ ok: true, deleted: false });
});

test("cache.put skips storage (silently) for a 206, no-store, or private response", async () => {
  const b = make();
  await b.dispatch({ op: "cache.put", key: "k1", status: 206, body: "partial" });
  await b.dispatch({ op: "cache.put", key: "k2", status: 200, headers: { "cache-control": "no-store" }, body: "x" });
  await b.dispatch({ op: "cache.put", key: "k3", status: 200, headers: { "cache-control": "private" }, body: "x" });
  expect(await b.dispatch({ op: "cache.match", key: "k1" })).toEqual({ ok: true, found: false });
  expect(await b.dispatch({ op: "cache.match", key: "k2" })).toEqual({ ok: true, found: false });
  expect(await b.dispatch({ op: "cache.match", key: "k3" })).toEqual({ ok: true, found: false });
});

test("cache.put derives TTL from s-maxage over max-age; an expired entry reads as a miss", async () => {
  const b = make();
  await b.dispatch({
    op: "cache.put",
    key: "k",
    status: 200,
    headers: { "cache-control": "max-age=3600, s-maxage=0" },
    body: "x",
  });
  // s-maxage=0 wins over max-age=3600 -> expires immediately.
  expect(await b.dispatch({ op: "cache.match", key: "k" })).toEqual({ ok: true, found: false });
});

test("cache namespaces (caches.open) don't collide on the same key", async () => {
  const b = make();
  await b.dispatch({ op: "cache.put", name: "images", key: "k", status: 200, body: "img" });
  expect(await b.dispatch({ op: "cache.match", name: "images", key: "k" })).toMatchObject({ found: true, body: "img" });
  expect(await b.dispatch({ op: "cache.match", key: "k" })).toEqual({ ok: true, found: false });
});

test("secrets resolve only when both bound and present", async () => {
  const b = make({ bindings: { secrets: ["API_KEY", "MISSING"] }, secrets: { API_KEY: "s3cr3t" } });
  expect(await b.dispatch({ op: "secret.get", name: "API_KEY" })).toEqual({ ok: true, value: "s3cr3t" });
  await expect(b.dispatch({ op: "secret.get", name: "MISSING" })).rejects.toThrow("no value");
  await expect(b.dispatch({ op: "secret.get", name: "UNBOUND" })).rejects.toThrow("not bound");
});

test("fetch reaches any public host, with no allowlist (#174)", async () => {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(String(url));
    return new Response("body", { status: 200, headers: { "x-mark": "1" } });
  };
  const b = make({ fetchImpl });

  await expect(b.dispatch({ op: "fetch", url: "ftp://api.example.com/x" })).rejects.toThrow("unsupported protocol");
  const res = await b.dispatch({ op: "fetch", url: "https://api.example.com/x" });
  expect(res).toMatchObject({ ok: true, status: 200, body: "body" });
  expect(calls).toEqual(["https://93.184.216.34/x"]);
});

test("#174: fetch never connects to a private address, whatever the name says", async () => {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(String(url));
    return new Response("ok");
  };
  const resolving = (addresses: string[]) => async () => addresses.map((address) => ({ address }));

  // A public-looking name that resolves somewhere private is refused before connect.
  for (const address of ["127.0.0.1", "169.254.169.254", "10.0.0.7", "::1", "64:ff9b::7f00:1"]) {
    const b = make({ fetchImpl, resolveImpl: resolving([address]), egressAllow: [] });
    await expect(b.dispatch({ op: "fetch", url: "https://api.example.com/x" })).rejects.toThrow(
      `api.example.com resolves to ${address}, a private or reserved address`,
    );
  }
  expect(calls).toEqual([]);

  // A mixed answer connects to the public address, not the first one.
  const mixed = make({ fetchImpl, resolveImpl: resolving(["10.0.0.7", "2606:4700::1111"]), egressAllow: [] });
  await mixed.dispatch({ op: "fetch", url: "https://api.example.com/x" });
  expect(calls).toEqual(["https://[2606:4700::1111]/x"]);

  // The operator, not the handler, can let one address through.
  const allowed = make({ fetchImpl, resolveImpl: resolving(["10.0.0.7"]), egressAllow: ["10.0.0.7"] });
  expect(await allowed.dispatch({ op: "fetch", url: "https://api.example.com/x" })).toMatchObject({ status: 200 });
});

test("#174: the pinned connection still sends the name as Host and verifies TLS against it", async () => {
  const inits: RequestInit[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    inits.push(init ?? {});
    return new Response("ok");
  };
  const b = make({ fetchImpl });
  await b.dispatch({ op: "fetch", url: "https://api.example.com/x" });
  expect(new Headers(inits[0].headers).get("host")).toBe("api.example.com");
  expect(inits[0]).toMatchObject({ tls: { serverName: "api.example.com" } });
});

test("#174: a real request reaches an allowed local upstream through the pinned address", async () => {
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => new Response(req.headers.get("host")) });
  try {
    const host = `localhost:${upstream.port}`;
    const b = make({ resolveImpl: undefined, egressAllow: ["127.0.0.1"] });
    expect(await b.dispatch({ op: "fetch", url: `http://${host}/` })).toMatchObject({ status: 200, body: host });
    const blocked = make({ resolveImpl: undefined, egressAllow: [] });
    await expect(blocked.dispatch({ op: "fetch", url: `http://${host}/` })).rejects.toThrow("SB_EGRESS_ALLOW=");
  } finally {
    upstream.stop(true);
  }
});

test("#232: a binary fetch request body is sent as its bytes, a text body as UTF-8", async () => {
  const seen: Uint8Array[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    seen.push(new Uint8Array(await new Response(init?.body).arrayBuffer()));
    return new Response("ok");
  };
  const b = make({ fetchImpl });
  // The runtime sends a binary body one char per byte, flagged bodyBinary.
  const raw = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join("");
  await b.dispatch({ op: "fetch", url: "https://api.example.com/up", method: "POST", body: raw, bodyBinary: true });
  await b.dispatch({ op: "fetch", url: "https://api.example.com/up", method: "POST", body: "café" });
  expect(Array.from(seen[0])).toEqual(Array.from({ length: 256 }, (_, i) => i));
  expect(Array.from(seen[1])).toEqual([99, 97, 102, 195, 169]);
});

test("#232: a v1 fetch returns the upstream body as raw bytes; v0 keeps decoded text", async () => {
  const binary = Uint8Array.from({ length: 256 }, (_, i) => i);
  const fetchImpl: FetchLike = async (url) =>
    new Response(String(url).endsWith("/bin") ? binary : "café", { status: 200 });
  const b = make({ fetchImpl });

  const raw = decodeV1Frame(
    await b.handleFrame(encodeV1({ v: 1, token: "tok", op: "fetch", url: "https://api.example.com/bin" })),
  );
  expect(raw.json).toMatchObject({ ok: true, status: 200 });
  expect(raw.json.body).toBeUndefined();
  expect(Buffer.from(raw.bytes).equals(Buffer.from(binary))).toBe(true);

  // Already-deployed sprouts speak v0 and expect the body as text in the JSON.
  expect(await b.dispatch({ op: "fetch", url: "https://api.example.com/t" })).toMatchObject({ body: "café" });
});

test("D1: query / run / batch on a bound database, isolated per name", async () => {
  const b = make({ bindings: { d1: ["DB", "OTHER"] } });
  await b.dispatch({ op: "d1.exec", db: "DB", sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)" });
  const ins = await b.dispatch({ op: "d1.query", db: "DB", sql: "INSERT INTO t (name) VALUES (?)", params: ["ada"] });
  expect(ins).toMatchObject({ ok: true, results: [] });
  expect(obj(ins.meta).changes).toBe(1);
  expect(obj(ins.meta).last_row_id).toBe(1);

  const sel = await b.dispatch({ op: "d1.query", db: "DB", sql: "SELECT * FROM t", params: [] });
  expect(sel.results).toEqual([{ id: 1, name: "ada" }]);

  const batch = await b.dispatch({
    op: "d1.batch",
    db: "DB",
    statements: [
      { sql: "INSERT INTO t (name) VALUES (?)", params: ["grace"] },
      { sql: "SELECT count(*) AS n FROM t", params: [] },
    ],
  });
  expect(obj(arr(batch.results)[1]).results).toEqual([{ n: 2 }]);

  // a different bound name is a different database
  await expect(b.dispatch({ op: "d1.query", db: "OTHER", sql: "SELECT * FROM t", params: [] })).rejects.toThrow(
    "no such table",
  );
  await expect(b.dispatch({ op: "d1.query", db: "NOPE", sql: "SELECT 1", params: [] })).rejects.toThrow("not bound");
});

test("D1: backup writes an integrity-checked snapshot, replayed from cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-broker-backup-"));
  try {
    const b = make({ db: join(dir, "store.sqlite"), bindings: { d1: ["DB"] } });
    await b.dispatch({ op: "d1.exec", db: "DB", sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)" });
    await b.dispatch({ op: "d1.query", db: "DB", sql: "INSERT INTO t (name) VALUES (?)", params: ["ada"] });

    const bk = await b.dispatch({ op: "d1.backup", db: "DB", name: "snap.sqlite" });
    expect(bk.ok).toBe(true);
    expect(String(bk.path).endsWith(join("backups", "snap.sqlite"))).toBe(true);
    expect(Number(bk.bytes)).toBeGreaterThan(0);
    expect(existsSync(String(bk.path))).toBe(true);

    // the snapshot is a real, readable database with the row in it
    const snap = new Database(String(bk.path), { readonly: true });
    expect(snap.query("SELECT name FROM t").all()).toEqual([{ name: "ada" }]);
    snap.close();

    await expect(b.dispatch({ op: "d1.backup", db: "NOPE" })).rejects.toThrow("not bound");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R2: put / get / head / list / delete on a bound bucket", async () => {
  const b = make({ bindings: { r2: ["ASSETS"] } });
  const put = await b.dispatch({
    op: "r2.put",
    bucket: "ASSETS",
    key: "a/1.txt",
    body: "hello",
    customMetadata: { k: "v" },
  });
  expect(put).toMatchObject({ ok: true });
  expect(obj(put.object).size).toBe(5);

  const got = await b.dispatch({ op: "r2.get", bucket: "ASSETS", key: "a/1.txt" });
  expect(got).toMatchObject({ ok: true, found: true, body: "hello" });
  expect(obj(got.object).customMetadata).toEqual({ k: "v" });

  const head = await b.dispatch({ op: "r2.head", bucket: "ASSETS", key: "a/1.txt" });
  expect(head).toMatchObject({ found: true });
  expect(head.body).toBeUndefined();

  await b.dispatch({ op: "r2.put", bucket: "ASSETS", key: "a/2.txt", body: "two" });
  await b.dispatch({ op: "r2.put", bucket: "ASSETS", key: "b/3.txt", body: "three" });
  const list = await b.dispatch({ op: "r2.list", bucket: "ASSETS", prefix: "a/" });
  expect(arr(list.objects).map((o) => obj(o).key)).toEqual(["a/1.txt", "a/2.txt"]);

  await b.dispatch({ op: "r2.delete", bucket: "ASSETS", key: "a/1.txt" });
  expect(await b.dispatch({ op: "r2.get", bucket: "ASSETS", key: "a/1.txt" })).toMatchObject({ found: false });
  await expect(b.dispatch({ op: "r2.put", bucket: "NOPE", key: "x", body: "y" })).rejects.toThrow("not bound");
});

test("R2: exact list prefix at every date; md5, paged list and delimiter for the shim from 2026-10-26", async () => {
  const b = make({ bindings: { r2: ["ASSETS"] } });
  for (const key of ["a_x", "ab", "AB", "d/1", "d/2", "e/1", "f"])
    await b.dispatch({ op: "r2.put", bucket: "ASSETS", key, body: "v" });
  // LIKE listed "ab" for "a_" and "AB" for "a".
  expect(
    arr((await b.dispatch({ op: "r2.list", bucket: "ASSETS", prefix: "a_" })).objects).map((o) => obj(o).key),
  ).toEqual(["a_x"]);
  expect(
    arr((await b.dispatch({ op: "r2.list", bucket: "ASSETS", prefix: "a" })).objects).map((o) => obj(o).key),
  ).toEqual(["a_x", "ab"]);
  const put = await b.dispatch({ op: "r2.put", bucket: "ASSETS", key: "m", body: "hello" });
  await b.dispatch({
    op: "r2.md5",
    bucket: "ASSETS",
    key: "m",
    etag: obj(put.object).etag,
    md5: "5d41402abc4b2a76b9719d911017c592",
  });
  expect(obj((await b.dispatch({ op: "r2.head", bucket: "ASSETS", key: "m" })).object).md5).toBe(
    "5d41402abc4b2a76b9719d911017c592",
  );
  // A stale etag (the object was written again since) records nothing.
  await b.dispatch({ op: "r2.md5", bucket: "ASSETS", key: "m", etag: "stale", md5: "x" });
  expect(obj((await b.dispatch({ op: "r2.head", bucket: "ASSETS", key: "m" })).object).md5).toBe(
    "5d41402abc4b2a76b9719d911017c592",
  );
  const page = (cursor: string) =>
    b.dispatch({ op: "r2.list", bucket: "ASSETS", page: true, prefix: "", cursor, limit: 3, delimiter: "/" });
  const first = await page("");
  expect(arr(first.objects).map((o) => obj(o).key)).toEqual(["AB", "a_x", "ab"]);
  expect(first).toMatchObject({ truncated: true, cursor: "ab", delimitedPrefixes: [] });
  const second = await page("ab");
  expect(arr(second.objects).map((o) => obj(o).key)).toEqual(["f"]);
  expect(second).toMatchObject({ truncated: true, delimitedPrefixes: ["d/", "e/"] });
  expect(await page(String(second.cursor))).toMatchObject({ objects: [{ key: "m" }], truncated: false, cursor: "" });
});

test("R2 direct transfer: streamed upload, metadata, one-use ticket and ranged download", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-r2-transfer-"));
  try {
    const b = make({ db: join(root, "state.sqlite"), bindings: { r2: ["UPLOADS"] } });
    const upload = await b.dispatch({
      op: "r2.transfer.create",
      bucket: "UPLOADS",
      key: "large.bin",
      method: "upload",
      maxBytes: 100,
      sha256: createHash("sha256").update("abcdef").digest("hex"),
      httpMetadata: { contentType: "application/octet-stream" },
    });
    const url = `http://127.0.0.1${upload.url}`;
    const bytes = new TextEncoder().encode("abcdef");
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(bytes.subarray(0, 3));
        controller.enqueue(bytes.subarray(3));
        controller.close();
      },
    });
    // SAFETY: Bun accepts duplex for streamed bodies; the bundled DOM type omits this runtime field.
    const put = await b.transfer(new Request(url, { method: "PUT", body, duplex: "half" } as RequestInit));
    expect(put.status).toBe(201);
    expect(await b.transfer(new Request(url, { method: "PUT", body: "again" }))).toMatchObject({ status: 410 });
    const head = await b.dispatch({ op: "r2.head", bucket: "UPLOADS", key: "large.bin" });
    expect(obj(head.object).size).toBe(6);

    const download = await b.dispatch({
      op: "r2.transfer.create",
      bucket: "UPLOADS",
      key: "large.bin",
      method: "download",
    });
    const get = await b.transfer(new Request(`http://127.0.0.1${download.url}`, { headers: { range: "bytes=2-4" } }));
    expect(get.status).toBe(206);
    expect(get.headers.get("content-range")).toBe("bytes 2-4/6");
    expect(get.headers.get("content-type")).toBe("application/octet-stream");
    expect(await get.text()).toBe("cde");
    expect((await b.transfer(new Request(`http://127.0.0.1${download.url}`))).status).toBe(410);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R2 direct transfer: invalid ranges and oversized bodies never replace an object", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-r2-transfer-errors-"));
  try {
    const b = make({ db: join(root, "state.sqlite"), bindings: { r2: ["UPLOADS"] } });
    await b.dispatch({ op: "r2.put", bucket: "UPLOADS", key: "k", body: "old" });
    const upload = await b.dispatch({
      op: "r2.transfer.create",
      bucket: "UPLOADS",
      key: "k",
      method: "upload",
      maxBytes: 2,
    });
    const url = `http://127.0.0.1${upload.url}`;
    expect((await b.transfer(new Request(url, { method: "PUT", body: "large" }))).status).toBe(413);
    expect((await b.transfer(new Request(url, { method: "PUT", body: "ok" }))).status).toBe(410);
    const retry = await b.dispatch({
      op: "r2.transfer.create",
      bucket: "UPLOADS",
      key: "k",
      method: "upload",
      maxBytes: 2,
    });
    expect((await b.transfer(new Request(`http://127.0.0.1${retry.url}`, { method: "PUT", body: "ok" }))).status).toBe(
      201,
    );
    const after = await b.dispatch({ op: "r2.get", bucket: "UPLOADS", key: "k" });
    expect(after.body).toBe("ok");
    const dl = await b.dispatch({ op: "r2.transfer.create", bucket: "UPLOADS", key: "k", method: "download" });
    expect(
      (await b.transfer(new Request(`http://127.0.0.1${dl.url}`, { headers: { range: "bytes=1-0" } }))).status,
    ).toBe(416);
    expect((await b.transfer(new Request(`http://127.0.0.1${dl.url}`))).status).toBe(200);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R2 direct transfer: account quota includes objects and shared in-flight reservations", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-r2-quota-"));
  try {
    const resourceDir = join(root, "resources");
    const bindings = {
      r2: ["UPLOADS"],
      resources: { UPLOADS: { kind: "r2" as const, id: "uploads" } },
    };
    const config = {
      resourceDir,
      ownerId: "owner-1",
      r2QuotaBytes: 12,
      r2ResourceIds: ["uploads"],
      bindings,
    };
    const first = make({ ...config, db: join(root, "first.sqlite") });
    const second = make({ ...config, db: join(root, "second.sqlite") });

    await first.dispatch({ op: "r2.put", bucket: "UPLOADS", key: "existing", body: "four" });
    const resource = new Database(join(resourceDir, "uploads.sqlite"));
    try {
      resource
        .query("INSERT INTO r2_part (bucket, key, upload_id, part_number, size, etag) VALUES (?1, ?2, ?3, 1, 2, ?4)")
        .run("uploads", "partial", "upload-1", "part");
    } finally {
      resource.close();
    }
    await expect(
      first.dispatch({ op: "r2.transfer.create", bucket: "UPLOADS", key: "large", method: "upload", maxBytes: 7 }),
    ).rejects.toThrow("quota");
    const ticket = await first.dispatch({
      op: "r2.transfer.create",
      bucket: "UPLOADS",
      key: "large",
      method: "upload",
      maxBytes: 6,
    });
    await expect(
      second.dispatch({ op: "r2.transfer.create", bucket: "UPLOADS", key: "other", method: "upload", maxBytes: 1 }),
    ).rejects.toThrow("quota");

    expect(
      (await first.transfer(new Request(`http://127.0.0.1${ticket.url}`, { method: "PUT", body: "five!" }))).status,
    ).toBe(201);
    const replacement = await second.dispatch({
      op: "r2.transfer.create",
      bucket: "UPLOADS",
      key: "other",
      method: "upload",
      maxBytes: 1,
    });
    expect(replacement.ok).toBe(true);
    const ledger = new Database(join(resourceDir, "r2-quota.sqlite"), { readonly: true });
    try {
      expect(
        ledger
          .query<{ tickets_issued: number; rejected_quota: number }, [string]>(
            "SELECT tickets_issued, rejected_quota FROM r2_transfer_metric WHERE owner = ?",
          )
          .get("owner-1"),
      ).toEqual({ tickets_issued: 2, rejected_quota: 2 });
    } finally {
      ledger.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R2 direct transfer: failed uploads release their reservation and retain the disk floor", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-r2-quota-release-"));
  try {
    const config = {
      db: join(root, "state.sqlite"),
      resourceDir: join(root, "resources"),
      ownerId: "owner-1",
      r2QuotaBytes: 5,
      r2ResourceIds: ["uploads"],
      bindings: { r2: ["UPLOADS"], resources: { UPLOADS: { kind: "r2" as const, id: "uploads" } } },
    };
    const b = make(config);
    const ticket = await b.dispatch({
      op: "r2.transfer.create",
      bucket: "UPLOADS",
      key: "bad",
      method: "upload",
      maxBytes: 5,
      sha256: createHash("sha256").update("expected").digest("hex"),
    });
    expect(
      (await b.transfer(new Request(`http://127.0.0.1${ticket.url}`, { method: "PUT", body: "wrong" }))).status,
    ).toBe(422);
    expect(
      (await b.dispatch({ op: "r2.transfer.create", bucket: "UPLOADS", key: "retry", method: "upload", maxBytes: 5 }))
        .ok,
    ).toBe(true);

    const floor = make({
      ...config,
      db: join(root, "floor.sqlite"),
      r2QuotaBytes: 100,
      r2MinFreeBytes: 10,
      freeBytes: () => 11,
    });
    await expect(
      floor.dispatch({ op: "r2.transfer.create", bucket: "UPLOADS", key: "no-space", method: "upload", maxBytes: 2 }),
    ).rejects.toThrow("temporarily unavailable");

    let freeBytes = 20;
    const duringUpload = make({
      ...config,
      db: join(root, "during-upload.sqlite"),
      r2QuotaBytes: 100,
      r2MinFreeBytes: 10,
      freeBytes: () => freeBytes,
    });
    const unknownLength = await duringUpload.dispatch({
      op: "r2.transfer.create",
      bucket: "UPLOADS",
      key: "during",
      method: "upload",
      maxBytes: 5,
    });
    freeBytes = 10;
    expect(
      (await duringUpload.transfer(new Request(`http://127.0.0.1${unknownLength.url}`, { method: "PUT", body: "x" })))
        .status,
    ).toBe(507);

    const abandoned = join(config.resourceDir, "r2-blobs", "a".repeat(24) + ".upload.tmp");
    mkdirSync(join(config.resourceDir, "r2-blobs"), { recursive: true });
    writeFileSync(abandoned, "partial");
    await expect(
      b.dispatch({ op: "r2.transfer.create", bucket: "UPLOADS", key: "quota-full", method: "upload", maxBytes: 1 }),
    ).rejects.toThrow("quota");
    expect(existsSync(abandoned)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R2 direct transfer: live HTTP listener accepts a chunked binary PUT", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-r2-transfer-http-"));
  const b = make({ db: join(root, "state.sqlite"), bindings: { r2: ["UPLOADS"] } });
  const server = listenTransfers(b, "127.0.0.1", 0);
  try {
    const ticket = await b.dispatch({
      op: "r2.transfer.create",
      bucket: "UPLOADS",
      key: "stream.bin",
      method: "upload",
      maxBytes: 2 * 1024 * 1024,
    });
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks++ < 16) controller.enqueue(new Uint8Array(64 * 1024).fill(chunks));
        else controller.close();
      },
    });
    // SAFETY: Bun accepts duplex for streamed bodies; the bundled DOM type omits this runtime field.
    const uploaded = await fetch(`http://127.0.0.1:${server.port}${ticket.url}`, {
      method: "PUT",
      body,
      duplex: "half",
    } as RequestInit);
    expect(uploaded.status).toBe(201);
    const download = await b.dispatch({
      op: "r2.transfer.create",
      bucket: "UPLOADS",
      key: "stream.bin",
      method: "download",
    });
    const response = await fetch(`http://127.0.0.1:${server.port}${download.url}`, {
      headers: { range: "bytes=65535-65537" },
    });
    expect(response.status).toBe(206);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 2]));
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("R2: list paginates with a cursor", async () => {
  const b = make({ bindings: { r2: ["ASSETS"] } });
  for (let i = 0; i < 5; i++) await b.dispatch({ op: "r2.put", bucket: "ASSETS", key: `k${i}`, body: "x" });
  const p1 = await b.dispatch({ op: "r2.list", bucket: "ASSETS", limit: 2 });
  expect(arr(p1.objects).map((o) => obj(o).key)).toEqual(["k0", "k1"]);
  expect(p1.truncated).toBe(true);
  const p2 = await b.dispatch({ op: "r2.list", bucket: "ASSETS", limit: 2, cursor: p1.cursor });
  expect(arr(p2.objects).map((o) => obj(o).key)).toEqual(["k2", "k3"]);
});

test("R2 multipart: binary parts complete without joining the full object in the broker heap", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-broker-r2-multipart-"));
  try {
    const b = make({ db: join(root, "state.sqlite"), bindings: { r2: ["UPLOADS"] }, token: "tok" });
    const created = await b.handleFrame(
      encodeV1({
        v: 1,
        id: 1,
        token: "tok",
        op: "r2.multipart.create",
        bucket: "UPLOADS",
        key: "archive.bin",
        customMetadata: { source: "test" },
      }),
    );
    const uploadId = String(decodeV1Frame(created).json.uploadId);
    const first = new Uint8Array([0, 1, 2, 255]);
    const second = new Uint8Array([4, 5]);
    const part1 = decodeV1Frame(
      await b.handleFrame(
        encodeV1(
          {
            v: 1,
            id: 2,
            token: "tok",
            op: "r2.multipart.put",
            bucket: "UPLOADS",
            key: "archive.bin",
            uploadId,
            partNumber: 1,
          },
          first,
        ),
      ),
    ).json;
    const part2 = decodeV1Frame(
      await b.handleFrame(
        encodeV1(
          {
            v: 1,
            id: 3,
            token: "tok",
            op: "r2.multipart.put",
            bucket: "UPLOADS",
            key: "archive.bin",
            uploadId,
            partNumber: 2,
          },
          second,
        ),
      ),
    ).json;
    const completed = await b.dispatch({
      op: "r2.multipart.complete",
      bucket: "UPLOADS",
      key: "archive.bin",
      uploadId,
      parts: [obj(part1.part), obj(part2.part)],
    });
    expect(obj(completed.object)).toMatchObject({ key: "archive.bin", size: 6, customMetadata: { source: "test" } });

    const got = decodeV1Frame(
      await b.handleFrame(encodeV1({ v: 1, token: "tok", op: "r2.get", bucket: "UPLOADS", key: "archive.bin" })),
    );
    expect(Buffer.from(got.bytes).equals(Buffer.from([...first, ...second]))).toBe(true);
    expect(existsSync(join(root, "r2-blobs"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R2 overwrite keeps the committed generation visible when metadata update fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-broker-r2-atomic-"));
  try {
    const databasePath = join(root, "state.sqlite");
    const b = make({ db: databasePath, bindings: { r2: ["UPLOADS"] } });
    await b.dispatch({ op: "r2.put", bucket: "UPLOADS", key: "object", body: "old-bytes" });
    const control = new Database(databasePath);
    control.exec(
      "CREATE TRIGGER fail_r2_metadata BEFORE UPDATE ON r2 BEGIN SELECT RAISE(ABORT, 'forced metadata failure'); END",
    );
    await expect(
      b.dispatch({ op: "r2.put", bucket: "UPLOADS", key: "object", body: "new-and-longer-bytes" }),
    ).rejects.toThrow("forced metadata failure");
    expect(await b.dispatch({ op: "r2.get", bucket: "UPLOADS", key: "object" })).toMatchObject({
      found: true,
      body: "old-bytes",
      object: { size: 9 },
    });
    control.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R2 direct overwrite also preserves the old generation on metadata failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-r2-transfer-atomic-"));
  try {
    const databasePath = join(root, "state.sqlite");
    const b = make({ db: databasePath, bindings: { r2: ["UPLOADS"] } });
    await b.dispatch({ op: "r2.put", bucket: "UPLOADS", key: "object", body: "old" });
    const control = new Database(databasePath);
    control.exec(
      "CREATE TRIGGER fail_r2_metadata BEFORE UPDATE ON r2 BEGIN SELECT RAISE(ABORT, 'forced metadata failure'); END",
    );
    const ticket = await b.dispatch({ op: "r2.transfer.create", bucket: "UPLOADS", key: "object", method: "upload" });
    await expect(
      b.transfer(new Request(`http://127.0.0.1${ticket.url}`, { method: "PUT", body: "new" })),
    ).rejects.toThrow("forced metadata failure");
    expect(await b.dispatch({ op: "r2.get", bucket: "UPLOADS", key: "object" })).toMatchObject({
      found: true,
      body: "old",
    });
    control.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Durable Object storage list: exact prefix, start / startAfter / end, reverse, limit", async () => {
  const b = make({ bindings: { do: [{ binding: "COUNTER", className: "Counter" }] } });
  for (const key of ["a", "b", "c", "d", "a_x", "A1", "aZ"])
    await b.dispatch({ op: "do.storage.put", cls: "Counter", id: "r", key, value: "1" });
  const keys = async (opts: Record<string, string | number | boolean | null>) => {
    const entries = (await b.dispatch({ op: "do.storage.list", cls: "Counter", id: "r", prefix: "", ...opts }))
      ?.entries;
    return Array.isArray(entries) ? entries.map((e) => (Array.isArray(e) ? e[0] : null)) : null;
  };
  expect(await keys({ start: "b", end: "d" })).toEqual(["b", "c"]);
  expect(await keys({ startAfter: "a_x" })).toEqual(["b", "c", "d"]);
  expect(await keys({ reverse: true, limit: 2 })).toEqual(["d", "c"]);
  // LIKE matched "_" as a wildcard and ignored case: "a_" used to list "aZ" and "A1" too.
  expect(await keys({ prefix: "a_" })).toEqual(["a_x"]);
  expect(await keys({ start: null, end: null })).toEqual(["A1", "a", "aZ", "a_x", "b", "c", "d"]);
});

test("Durable Object storage: get / put / delete / list / deleteAll scoped to (class, id)", async () => {
  const b = make({ bindings: { do: [{ binding: "COUNTER", className: "Counter" }] } });
  expect(await b.dispatch({ op: "do.storage.get", cls: "Counter", id: "a", key: "n" })).toMatchObject({ found: false });
  await b.dispatch({ op: "do.storage.put", cls: "Counter", id: "a", key: "n", value: "5" });
  await b.dispatch({ op: "do.storage.put", cls: "Counter", id: "a", key: "m", value: "9" });
  await b.dispatch({ op: "do.storage.put", cls: "Counter", id: "b", key: "n", value: "1" });
  expect(await b.dispatch({ op: "do.storage.get", cls: "Counter", id: "a", key: "n" })).toMatchObject({
    found: true,
    value: "5",
  });
  expect((await b.dispatch({ op: "do.storage.list", cls: "Counter", id: "a", prefix: "" })).entries).toEqual([
    ["m", "9"],
    ["n", "5"],
  ]);
  expect(await b.dispatch({ op: "do.storage.delete", cls: "Counter", id: "a", key: "m" })).toEqual({
    ok: true,
    deleted: true,
  });
  await b.dispatch({ op: "do.storage.delete_all", cls: "Counter", id: "a" });
  expect((await b.dispatch({ op: "do.storage.list", cls: "Counter", id: "a", prefix: "" })).entries).toEqual([]);
  expect(await b.dispatch({ op: "do.storage.get", cls: "Counter", id: "b", key: "n" })).toMatchObject({
    found: true,
    value: "1",
  });
  await expect(b.dispatch({ op: "do.storage.get", cls: "Nope", id: "a", key: "n" })).rejects.toThrow("not bound");
});

test("Analytics Engine: write is bound-gated; query reads back count + recent rows", async () => {
  const b = make({ bindings: { analytics: ["METRICS"] } });
  expect(await b.dispatch({ op: "ae.write", dataset: "METRICS", blobs: ["GET", "/a"], doubles: [1] })).toEqual({
    ok: true,
  });
  await b.dispatch({ op: "ae.write", dataset: "METRICS", blobs: ["POST", "/b"], doubles: [1] });
  await expect(b.dispatch({ op: "ae.write", dataset: "OTHER" })).rejects.toThrow("not bound");

  const q = await b.dispatch({ op: "ae.query", dataset: "METRICS", limit: 5 });
  expect(q.count).toBe(2);
  const rows = arr(q.rows);
  expect(obj(rows[0]).blobs).toEqual(["POST", "/b"]); // newest first
  await expect(b.dispatch({ op: "ae.query", dataset: "OTHER" })).rejects.toThrow("not bound");
});

test("Queues: send enqueues; the consumer delivers a batch and acked messages are removed", async () => {
  const delivered: JsonObject[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = obj(parseJsonValue(String(init?.body)));
    delivered.push(body);
    // ack all but the first
    return new Response(
      JSON.stringify({
        ack: arr(body.messages)
          .slice(1)
          .map((m) => obj(m).id),
        retry: [],
      }),
      { status: 200 },
    );
  };

  const b = make({ bindings: { queues: ["JOBS"] }, sproutUrl: "http://127.0.0.1:1/", fetchImpl });
  await b.dispatch({ op: "queue.send", queue: "JOBS", body: JSON.stringify({ n: 1 }) });
  await b.dispatch({ op: "queue.send", queue: "JOBS", body: JSON.stringify({ n: 2 }) });
  await b.dispatch({ op: "queue.send", queue: "JOBS", body: JSON.stringify({ n: 3 }) });

  // the consumer runs on a 500ms interval
  await Bun.sleep(900);
  expect(delivered.length).toBeGreaterThan(0);
  const first = obj(delivered[0]);
  expect(first.queue).toBe("JOBS");
  expect(arr(first.messages).length).toBe(3);

  await expect(b.dispatch({ op: "queue.send", queue: "NOPE", body: "x" })).rejects.toThrow("not bound");
});

test("Queues: send reports the backlog; batches carry send times, metrics and the batch settings", async () => {
  const delivered: JsonObject[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = obj(parseJsonValue(String(init?.body)));
    delivered.push(body);
    return new Response(JSON.stringify({ ack: arr(body.messages).map((m) => obj(m).id), retry: [] }), { status: 200 });
  };
  const b = make({
    bindings: {
      queues: ["JOBS"],
      queueConfig: [{ binding: "JOBS", queue: "jobs", maxBatchSize: 2, maxBatchTimeout: 1 }],
    },
    sproutUrl: "http://127.0.0.1:1/",
    fetchImpl,
  });
  const before = Date.now();
  const sent = await b.dispatch({ op: "queue.send", queue: "JOBS", body: "one", metrics: true });
  expect(obj(sent.metrics)).toMatchObject({ backlogCount: 1, backlogBytes: 3 });
  expect(Number(obj(sent.metrics).oldestMessageTimestamp)).toBeGreaterThanOrEqual(before);
  expect(await b.dispatch({ op: "queue.metrics", queue: "JOBS" })).toMatchObject({ metrics: { backlogCount: 1 } });
  // One message waits for max_batch_timeout (1 s); three fill a batch of two at once.
  await Bun.sleep(700);
  expect(delivered.length).toBe(0);
  await Bun.sleep(900);
  expect(delivered.length).toBe(1);
  const batch = obj(delivered[0]);
  expect(Number(obj(arr(batch.messages)[0]).timestamp)).toBeGreaterThanOrEqual(before);
  expect(obj(obj(batch.metadata).metrics).backlogCount).toBe(1);
  await b.dispatch({ op: "queue.send_batch", queue: "JOBS", messages: [{ body: "a" }, { body: "b" }, { body: "c" }] });
  await Bun.sleep(600);
  expect(arr(obj(delivered[1]).messages).length).toBe(2);
});

test("Queues: retry delays from the sprout, and messages past max_retries move to the dead letter queue", async () => {
  const delivered: JsonObject[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = obj(parseJsonValue(String(init?.body)));
    delivered.push(body);
    const ids = arr(body.messages).map((m) => String(obj(m).id));
    if (body.queue === "DLQ") return new Response(JSON.stringify({ ack: ids, retry: [] }), { status: 200 });
    // The first delivery retries at once; the second sends the message to the dead letter queue.
    const second = Number(obj(arr(body.messages)[0]).attempts) > 1;
    return new Response(
      JSON.stringify(
        second
          ? { ack: [], retry: ids, delays: {}, dead: ids, deadLetter: "DLQ" }
          : { ack: [], retry: ids, delays: Object.fromEntries(ids.map((id) => [id, 0])), dead: [] },
      ),
      { status: 200 },
    );
  };
  const b = make({ bindings: { queues: ["JOBS", "DLQ"] }, sproutUrl: "http://127.0.0.1:1/", fetchImpl });
  await b.dispatch({ op: "queue.send", queue: "JOBS", body: "work" });
  await Bun.sleep(1800);
  expect(delivered.map((d) => [d.queue, obj(arr(d.messages)[0]).attempts, obj(arr(d.messages)[0]).body])).toEqual([
    ["JOBS", 1, "work"],
    ["JOBS", 2, "work"],
    ["DLQ", 1, "work"],
  ]);
});

test("assets.get: serves a bound file, falls back per not_found_handling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-assets-"));
  const assetsDir = join(dir, "assets");
  mkdirSync(join(assetsDir, "sub"), { recursive: true });
  writeFileSync(join(assetsDir, "index.html"), "<h1>home</h1>");
  writeFileSync(join(assetsDir, "sub", "page.css"), "body{}");
  const write = (notFound: AssetManifest["notFound"]): void => {
    const m: AssetManifest = { notFound, runSproutFirst: false, files: walkAssets(assetsDir) };
    writeFileSync(join(dir, "assets.json"), JSON.stringify(m));
  };

  write("none");
  const b1 = make({ bindings: { assets: "ASSETS" }, assetsDir });
  expect(await b1.dispatch({ op: "assets.get", path: "/index.html" })).toMatchObject({
    found: true,
    status: 200,
    type: "text/html; charset=utf-8",
    body: "<h1>home</h1>",
  });
  expect(await b1.dispatch({ op: "assets.get", path: "/" })).toMatchObject({ found: true, body: "<h1>home</h1>" });
  expect(await b1.dispatch({ op: "assets.get", path: "/sub/page.css" })).toMatchObject({
    type: "text/css; charset=utf-8",
  });
  expect(await b1.dispatch({ op: "assets.get", path: "/missing" })).toMatchObject({ found: false, status: 404 });

  write("single-page-application");
  const b2 = make({ bindings: { assets: "ASSETS" }, assetsDir });
  expect(await b2.dispatch({ op: "assets.get", path: "/client/route" })).toMatchObject({
    found: true,
    status: 200,
    body: "<h1>home</h1>",
  });

  await expect(
    make({ bindings: { assets: "" }, assetsDir }).dispatch({ op: "assets.get", path: "/x" }),
  ).rejects.toThrow("not bound");
  rmSync(dir, { recursive: true, force: true });
});

test("cronMatches: fields, steps, ranges, lists (UTC)", () => {
  const at = (iso: string) => new Date(iso);
  expect(cronMatches("* * * * *", at("2026-08-31T04:07:00Z"))).toBe(true);
  expect(cronMatches("0 3 * * *", at("2026-08-31T03:00:00Z"))).toBe(true);
  expect(cronMatches("0 3 * * *", at("2026-08-31T04:00:00Z"))).toBe(false);
  expect(cronMatches("*/15 * * * *", at("2026-08-31T04:15:00Z"))).toBe(true);
  expect(cronMatches("*/15 * * * *", at("2026-08-31T04:16:00Z"))).toBe(false);
  expect(cronMatches("0 9-17 * * 1", at("2026-08-31T12:00:00Z"))).toBe(true); // 2026-08-31 is a Monday
  expect(cronMatches("0 9-17 * * 1", at("2026-08-30T12:00:00Z"))).toBe(false); // Sunday
  expect(cronMatches("0 0 1,15 * *", at("2026-08-15T00:00:00Z"))).toBe(true);
});

// #74 — a binding wired to an account-level resource stores in its own file
// under resourceDir, keyed by id, so the data outlives a "redeploy" (a new
// broker with a fresh per-deployment db but the same resourceDir).
test("Durable Object SQL: one database per object, beside its project's doDb, D1-strict replies", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-broker-do-sql-"));
  try {
    for (const dep of ["dep", "dep2", "dep3"]) mkdirSync(join(root, dep));
    const bindings = { do: [{ binding: "SQL", className: "SqlObject" }] };
    const a = "a".repeat(64);
    const b2 = "b".repeat(64);
    const sql = (b: ReturnType<typeof createBroker>, file: string, text: string, params: JsonValue[] = []) =>
      b.dispatch({ op: "do.sql", cls: "SqlObject", file, sql: text, params });
    const one = createBroker({ db: join(root, "dep", "state.sqlite"), doDb: join(root, "do_p1.sqlite"), bindings });
    await sql(one, a, "CREATE TABLE t (v, b BLOB)");
    expect(await sql(one, a, "INSERT INTO t VALUES (?, ?), (?, ?)", [1, { $blob: "0102" }, 2, null])).toMatchObject({
      meta: { changes: 2 },
    });
    expect(await sql(one, a, "SELECT v, b FROM t ORDER BY v")).toMatchObject({
      columns: ["v", "b"],
      rows: [
        [1, { $blob: "0102" }],
        [2, null],
      ],
    });
    // Another object has its own database.
    await expect(sql(one, b2, "SELECT v FROM t")).rejects.toThrow("D1_ERROR: no such table: t");
    await expect(sql(one, a, "SELEKT 1")).rejects.toThrow('near "SELEKT": syntax error');
    await expect(sql(one, "../x", "SELECT 1")).rejects.toThrow("invalid Durable Object SQL database");
    await expect(one.dispatch({ op: "do.sql", cls: "Nope", file: a, sql: "SELECT 1", params: [] })).rejects.toThrow(
      "not bound",
    );
    one.close();
    expect(existsSync(join(root, "do_p1.do-sql", "SqlObject", `${a}.sqlite`))).toBe(true);

    // A redeploy keeps it; another project with the same class and id does not see it.
    const again = createBroker({ db: join(root, "dep2", "state.sqlite"), doDb: join(root, "do_p1.sqlite"), bindings });
    expect((await sql(again, a, "SELECT count(*) AS n FROM t")).rows).toEqual([[2]]);
    again.close();
    const other = createBroker({ db: join(root, "dep3", "state.sqlite"), doDb: join(root, "do_p2.sqlite"), bindings });
    await expect(sql(other, a, "SELECT v FROM t")).rejects.toThrow("no such table: t");
    other.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#207: Durable Object storage and alarms in doDb outlive a redeploy", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-broker-do-"));
  try {
    mkdirSync(join(root, "dep-a"), { recursive: true });
    mkdirSync(join(root, "dep-b"), { recursive: true });
    const doDb = join(root, "do_0123456789abcdef01234567.sqlite");
    const bindings = { do: [{ binding: "COUNTER", className: "Counter" }] };

    const first = createBroker({ db: join(root, "dep-a", "state.sqlite"), doDb, bindings });
    await first.dispatch({ op: "do.storage.put", cls: "Counter", id: "global", key: "n", value: "41" });
    await first.dispatch({ op: "do.alarm.set", cls: "Counter", id: "global", at: 1234 });
    first.close();

    // A redeploy: new per-deployment state.sqlite, same per-project doDb.
    const second = createBroker({ db: join(root, "dep-b", "state.sqlite"), doDb, bindings });
    expect(await second.dispatch({ op: "do.storage.get", cls: "Counter", id: "global", key: "n" })).toEqual({
      ok: true,
      found: true,
      value: "41",
    });
    expect(await second.dispatch({ op: "do.alarm.get", cls: "Counter", id: "global" })).toMatchObject({ at: 1234 });
    second.close();

    // Without doDb the state stays per deployment, as before.
    const third = createBroker({ db: join(root, "dep-a", "state.sqlite"), bindings });
    expect(await third.dispatch({ op: "do.storage.get", cls: "Counter", id: "global", key: "n" })).toMatchObject({
      found: false,
    });
    third.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resource-backed KV persists across brokers and is shared by id", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-broker-res-"));
  try {
    const resourceDir = join(root, "resources");
    const kvId = "kv_0123456789abcdef01234567";
    mkdirSync(join(root, "dep-a"), { recursive: true });
    mkdirSync(join(root, "dep-b"), { recursive: true });

    const first = createBroker({
      db: join(root, "dep-a", "state.sqlite"),
      resourceDir,
      bindings: { kv: ["LINKS"], resources: { LINKS: { kind: "kv", id: kvId } } },
    });
    await first.dispatch({ op: "kv.put", ns: "LINKS", key: "a", value: "1" });
    first.close();
    // stored in the per-resource file, not a per-deployment one
    expect(existsSync(join(resourceDir, `${kvId}.sqlite`))).toBe(true);

    // a different deployment, different binding name, same id → same data
    const second = createBroker({
      db: join(root, "dep-b", "state.sqlite"),
      resourceDir,
      bindings: { kv: ["SHORTENER"], resources: { SHORTENER: { kind: "kv", id: kvId } } },
    });
    expect(await second.dispatch({ op: "kv.get", ns: "SHORTENER", key: "a" })).toMatchObject({
      ok: true,
      found: true,
      binary: false,
      value: "1",
    });
    second.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// #56 — object bytes live in their own file next to the store's own SQLite
// file, not inside it, so a resource-bound bucket's blobs persist across a
// redeploy exactly like its metadata does, and a bare-string binding's blobs
// live beside its per-deployment db.
test("R2 blobs are file-backed and persist across brokers for a resource-bound bucket", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-broker-r2-res-"));
  try {
    const resourceDir = join(root, "resources");
    const bucketId = "r2_0123456789abcdef01234567";
    mkdirSync(join(root, "dep-a"), { recursive: true });
    mkdirSync(join(root, "dep-b"), { recursive: true });

    const first = createBroker({
      db: join(root, "dep-a", "state.sqlite"),
      resourceDir,
      bindings: { r2: ["UPLOADS"], resources: { UPLOADS: { kind: "r2", id: bucketId } } },
    });
    await first.dispatch({ op: "r2.put", bucket: "UPLOADS", key: "a.txt", body: "hello" });
    first.close();
    // metadata in the per-resource file, bytes in their own file beside it —
    // never inline in the sqlite row.
    const dbFile = join(resourceDir, `${bucketId}.sqlite`);
    expect(existsSync(dbFile)).toBe(true);
    expect(readFileSync(dbFile, "utf8")).not.toContain("hello");
    expect(existsSync(join(resourceDir, "r2-blobs"))).toBe(true);

    const second = createBroker({
      db: join(root, "dep-b", "state.sqlite"),
      resourceDir,
      bindings: { r2: ["FILES"], resources: { FILES: { kind: "r2", id: bucketId } } },
    });
    expect(await second.dispatch({ op: "r2.get", bucket: "FILES", key: "a.txt" })).toMatchObject({
      ok: true,
      found: true,
      body: "hello",
    });
    second.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bare-string R2 binding stores blobs beside the per-deployment db, not resourceDir", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-broker-r2-bare-"));
  try {
    const resourceDir = join(root, "resources");
    mkdirSync(join(root, "dep"), { recursive: true });
    const b = createBroker({ db: join(root, "dep", "state.sqlite"), resourceDir, bindings: { r2: ["UPLOADS"] } });
    const put = await b.dispatch({ op: "r2.put", bucket: "UPLOADS", key: "k", body: "bytes" });
    b.close();
    expect(existsSync(resourceDir)).toBe(false);
    expect(existsSync(join(root, "dep", "r2-blobs"))).toBe(true);
    expect(obj(put.object)).toMatchObject({ size: 5 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Binary round trip against a real file-backed store (not `:memory:`), the
// v1 path a live sprout actually uses (#63).
test("R2 v1 binary put/get round-trips through a file-backed blob", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-broker-r2-v1-"));
  try {
    const b = createBroker({ db: join(root, "state.sqlite"), bindings: { r2: ["UPLOADS"] }, token: "tok" });
    const server = listen(b, "127.0.0.1", 0);
    try {
      const body = new Uint8Array([0, 1, 2, 0x80, 0xff, 254, 253]);
      const put = await v1(server, { v: 1, token: "tok", op: "r2.put", bucket: "UPLOADS", key: "k" }, body);
      expect(obj(put.json.object)).toMatchObject({ size: body.length });
      expect(existsSync(join(root, "r2-blobs"))).toBe(true);
      const got = await v1(server, { v: 1, token: "tok", op: "r2.get", bucket: "UPLOADS", key: "k" });
      expect(Buffer.from(got.bytes).equals(Buffer.from(body))).toBe(true);
    } finally {
      server.stop();
      b.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bare-string binding still uses the per-broker db, not resourceDir", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-broker-bare-"));
  try {
    const resourceDir = join(root, "resources");
    mkdirSync(join(root, "dep"), { recursive: true });
    const b = createBroker({ db: join(root, "dep", "state.sqlite"), resourceDir, bindings: { kv: ["CACHE"] } });
    await b.dispatch({ op: "kv.put", ns: "CACHE", key: "k", value: "v" });
    b.close();
    expect(existsSync(resourceDir)).toBe(false);
    expect(existsSync(join(root, "dep", "state.sqlite"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("queue and alarm poll indexes migrate existing broker and resource stores", async () => {
  const root = mkdtempSync(join(tmpdir(), "sb-trigger-index-"));
  const state = join(root, "state.sqlite");
  const resourceDir = join(root, "resources");
  const queueId = "queue_0123456789abcdef01234567";
  const oldState = new Database(state, { create: true });
  oldState.exec(
    "CREATE TABLE mq (queue TEXT NOT NULL, id TEXT PRIMARY KEY, body TEXT NOT NULL, visible_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, dead INTEGER NOT NULL DEFAULT 0); " +
      "CREATE TABLE do_alarm (cls TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (cls, id))",
  );
  oldState.close();
  mkdirSync(resourceDir, { recursive: true });
  const oldQueue = new Database(join(resourceDir, `${queueId}.sqlite`), { create: true });
  oldQueue.exec(
    "CREATE TABLE mq (queue TEXT NOT NULL, id TEXT PRIMARY KEY, body TEXT NOT NULL, visible_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, dead INTEGER NOT NULL DEFAULT 0)",
  );
  oldQueue.close();

  const broker = createBroker({
    db: state,
    resourceDir,
    bindings: {
      queues: ["JOBS"],
      do: [{ binding: "COUNTER", className: "Counter" }],
      resources: { JOBS: { kind: "queue", id: queueId } },
    },
  });
  // Resource-backed stores open on first binding use, just as they do in a
  // deployed worker. Opening the queue upgrades its existing SQLite file.
  await broker.dispatch({ op: "queue.send", queue: "JOBS", body: "first" });
  broker.close();

  const names = (path: string): string[] => {
    const store = new Database(path);
    const rows = store.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index'").all();
    store.close();
    return rows.map((row) => row.name);
  };
  expect(names(state)).toEqual(expect.arrayContaining(["mq_due", "do_alarm_due"]));
  expect(names(join(resourceDir, `${queueId}.sqlite`))).toContain("mq_due");
  rmSync(root, { recursive: true, force: true });
});

test("queue and alarm due queries use their poll indexes", () => {
  const root = mkdtempSync(join(tmpdir(), "sb-trigger-plan-"));
  const path = join(root, "state.sqlite");
  const broker = createBroker({
    db: path,
    bindings: { queues: ["JOBS"], do: [{ binding: "COUNTER", className: "Counter" }] },
  });
  broker.close();
  const store = new Database(path);
  const plan = (sql: string): string =>
    store
      .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`)
      .all()
      .map((row) => row.detail)
      .join("\n");
  expect(
    plan(
      "SELECT id, body, attempts FROM mq WHERE queue = 'JOBS' AND dead = 0 AND visible_at <= 1 ORDER BY visible_at LIMIT 10",
    ),
  ).toContain("mq_due");
  expect(plan("SELECT cls, id, at, attempts FROM do_alarm WHERE at <= 1 ORDER BY at LIMIT 10")).toContain(
    "do_alarm_due",
  );
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("token line is enforced by handlePayload", async () => {
  const b = make({ token: "t0k" });
  expect(await b.handlePayload(`wrong\n${JSON.stringify({ op: "ping" })}`)).toEqual({
    ok: false,
    error: "unauthorized",
  });
  expect(await b.handlePayload(`t0k\n${JSON.stringify({ op: "ping" })}`)).toMatchObject({ ok: true, op: "pong" });
});

test("listen(): framed request/reply over a real socket, delivered split", async () => {
  const b = make({ bindings: { kv: ["CACHE"] } });
  const server = listen(b, "127.0.0.1", 0);
  let recv = Buffer.alloc(0);
  let resolveReply: (s: string) => void;
  const reply = new Promise<string>((r) => {
    resolveReply = r;
  });
  try {
    const sock = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: {
        data(_s, chunk) {
          recv = Buffer.concat([recv, chunk]);
          if (recv.length >= 4 && recv.length >= 4 + recv.readUInt32LE(0)) {
            resolveReply(recv.subarray(4, 4 + recv.readUInt32LE(0)).toString("utf8"));
          }
        },
      },
    });
    const frame = encodeFrame({ op: "ping", msg: "x" });
    sock.write(frame.subarray(0, 3)); // header split mid-length
    await Bun.sleep(5);
    sock.write(frame.subarray(3));
    expect(JSON.parse(await reply)).toMatchObject({ ok: true, op: "pong", echo: "x" });
    sock.end();
  } finally {
    server.stop();
  }
});

// --- Durable Object alarms (#125) -------------------------------------------

const doBindings = { do: [{ binding: "COUNTER", className: "Counter" }] };

test("alarm: set, read back, and delete", async () => {
  const b = make({ bindings: doBindings });
  expect((await b.dispatch({ op: "do.alarm.get", cls: "Counter", id: "a" })).at).toBeNull();

  await b.dispatch({ op: "do.alarm.set", cls: "Counter", id: "a", at: 1_800_000_000_000 });
  expect((await b.dispatch({ op: "do.alarm.get", cls: "Counter", id: "a" })).at).toBe(1_800_000_000_000);

  // Workers keeps at most one pending alarm per object: a later set replaces.
  await b.dispatch({ op: "do.alarm.set", cls: "Counter", id: "a", at: 1_900_000_000_000 });
  expect((await b.dispatch({ op: "do.alarm.get", cls: "Counter", id: "a" })).at).toBe(1_900_000_000_000);

  expect((await b.dispatch({ op: "do.alarm.delete", cls: "Counter", id: "a" })).deleted).toBe(true);
  expect((await b.dispatch({ op: "do.alarm.get", cls: "Counter", id: "a" })).at).toBeNull();
});

test("alarm: one object's alarm is not another's", async () => {
  const b = make({ bindings: doBindings });
  await b.dispatch({ op: "do.alarm.set", cls: "Counter", id: "a", at: 1_800_000_000_000 });
  expect((await b.dispatch({ op: "do.alarm.get", cls: "Counter", id: "b" })).at).toBeNull();
});

test("alarm: a class that is not bound is refused", async () => {
  const b = make({ bindings: doBindings });
  await expect(b.dispatch({ op: "do.alarm.set", cls: "Ghost", id: "a", at: 1 })).rejects.toThrow(/not bound/);
});

test("alarm: a due alarm is delivered once, and a self-rescheduling handler survives", async () => {
  const delivered: JsonObject[] = [];
  let b: Broker | undefined;
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = obj(parseJsonValue(String(init?.body)));
    delivered.push(body);
    // What a self-rescheduling alarm() does: set the next one *during*
    // delivery. Deleting the claimed row after this would erase it.
    await b!.dispatch({ op: "do.alarm.set", cls: "Counter", id: "a", at: Date.now() + 60_000 });
    return new Response("", { status: 204 });
  };

  b = make({ bindings: doBindings, sproutUrl: "http://127.0.0.1:1/", fetchImpl });
  await b.dispatch({ op: "do.alarm.set", cls: "Counter", id: "a", at: Date.now() - 1 });

  await Bun.sleep(900);
  expect(delivered.length).toBe(1);
  expect(obj(delivered[0]).cls).toBe("Counter");
  expect(obj(delivered[0]).id).toBe("a");

  // the alarm the handler scheduled is still pending, not clobbered by the claim
  const pending = await b.dispatch({ op: "do.alarm.get", cls: "Counter", id: "a" });
  expect(pending.at).not.toBeNull();
  expect(Number(pending.at)).toBeGreaterThan(Date.now());
});

test("alarm: a failed delivery is retried, not lost", async () => {
  let attempts = 0;
  const fetchImpl: FetchLike = async () => {
    attempts += 1;
    return new Response("boom", { status: 500 });
  };
  const b = make({ bindings: doBindings, sproutUrl: "http://127.0.0.1:1/", fetchImpl });
  await b.dispatch({ op: "do.alarm.set", cls: "Counter", id: "a", at: Date.now() - 1 });

  await Bun.sleep(900);
  expect(attempts).toBeGreaterThan(0);
  // re-armed for a later retry rather than dropped on the floor
  const pending = await b.dispatch({ op: "do.alarm.get", cls: "Counter", id: "a" });
  expect(pending.at).not.toBeNull();
});

// --- service bindings (#48) --------------------------------------------------

const svcBindings = { services: [{ binding: "AUTH", service: "auth-api" }] };

test("service: forwards through the edge with the target's Host header", async () => {
  const seen: Array<{ url: string; host: string | null; method: string; body: string | null }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers);
    seen.push({
      url: String(url),
      host: headers.get("host"),
      method: String(init?.method),
      body: init?.body == null ? null : String(init.body),
    });
    return new Response("pong", { status: 200, headers: { "content-type": "text/plain" } });
  };
  const b = make({
    bindings: svcBindings,
    services: { AUTH: "auth-api.andrea.example.com" },
    edgeUrl: "http://127.0.0.1:8080/",
    fetchImpl,
  });

  const reply = await b.dispatch({
    op: "service.fetch",
    binding: "AUTH",
    url: "https://service/verify?token=abc",
    method: "POST",
    headers: [["content-type", "application/json"]],
    body: '{"t":1}',
  });

  expect(reply.status).toBe(200);
  expect(reply.body).toBe("pong");
  // The path and query survive; the destination is the edge, and the Host
  // header is what actually routes it to the target deployment.
  expect(seen[0].url).toBe("http://127.0.0.1:8080/verify?token=abc");
  expect(seen[0].host).toBe("auth-api.andrea.example.com");
  expect(seen[0].method).toBe("POST");
  expect(seen[0].body).toBe('{"t":1}');
});

test("service: a binding the artifact never declared is refused", async () => {
  const b = make({ bindings: svcBindings, services: { AUTH: "a.example.com" }, edgeUrl: "http://127.0.0.1:8080/" });
  await expect(b.dispatch({ op: "service.fetch", binding: "GHOST", url: "https://service/" })).rejects.toThrow(
    /service not bound: GHOST/,
  );
});

test("service: declared but not deployed says so, instead of a bare 502", async () => {
  const b = make({ bindings: svcBindings, services: {}, edgeUrl: "http://127.0.0.1:8080/" });
  await expect(b.dispatch({ op: "service.fetch", binding: "AUTH", url: "https://service/" })).rejects.toThrow(
    /"auth-api" is not deployed/,
  );
});

test("service: a call reaches the edge on loopback, which plain fetch() may not", async () => {
  // The target is reached internally through the edge, so the private-address
  // block (#174) does not apply to it.
  const fetchImpl: FetchLike = async () => new Response("ok", { status: 200 });
  const b = make({
    bindings: svcBindings,
    services: { AUTH: "auth-api.andrea.example.com" },
    edgeUrl: "http://127.0.0.1:8080/",
    fetchImpl,
    resolveImpl: async () => [{ address: "127.0.0.1" }],
    egressAllow: [],
  });
  expect((await b.dispatch({ op: "service.fetch", binding: "AUTH", url: "https://service/" })).status).toBe(200);
  // ...while real egress to the same place is refused.
  await expect(b.dispatch({ op: "fetch", url: "http://127.0.0.1:8080/" })).rejects.toThrow("private or reserved");
});

// --- v1 frames (#63) --------------------------------------------------------

/** Send one v1 frame over a real socket and return the decoded reply. */
async function v1(
  server: { port: number },
  json: Frame,
  binary?: Uint8Array,
): Promise<{ json: JsonObject; bytes: Uint8Array }> {
  const payload = encodeV1(json, binary);
  const frame = new Uint8Array(4 + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length, true);
  frame.set(payload, 4);
  const chunks: Uint8Array[] = [];
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port: server.port,
    socket: { data: (_s, d) => void chunks.push(new Uint8Array(d)) },
  });
  socket.write(frame);
  for (let i = 0; i < 200 && chunks.length === 0; i++) await Bun.sleep(5);
  await Bun.sleep(20);
  socket.end();
  const all = Buffer.concat(chunks);
  const jsonLen = all.readUInt32LE(5);
  return {
    json: obj(parseJsonValue(all.subarray(9, 9 + jsonLen).toString("utf8"))),
    bytes: new Uint8Array(all.subarray(9 + jsonLen)),
  };
}

type V1Reply = { json: JsonObject; bytes: Uint8Array };

function decodeV1Frame(frame: Buffer): V1Reply {
  const payloadLength = frame.readUInt32LE(0);
  const payload = frame.subarray(4, 4 + payloadLength);
  expect(payload[0]).toBe(1);
  const jsonLength = payload.readUInt32LE(1);
  return {
    json: obj(parseJsonValue(payload.subarray(5, 5 + jsonLength).toString("utf8"))),
    bytes: new Uint8Array(payload.subarray(5 + jsonLength)),
  };
}

test("v1: an object body round-trips as bytes, not as escaped JSON", async () => {
  const b = make({ bindings: { r2: ["UP"] }, token: "tok" });
  const server = listen(b, "127.0.0.1", 0);
  // Every byte value, including the ones JSON escapes and the ones that are not
  // valid UTF-8 — the whole point of carrying them outside the JSON.
  const body = new Uint8Array(1024);
  for (let i = 0; i < body.length; i++) body[i] = i % 256;

  const put = await v1(server, { v: 1, token: "tok", op: "r2.put", bucket: "UP", key: "k" }, body);
  expect(put.json.ok).toBe(true);
  expect(obj(put.json.object).size).toBe(1024);

  const got = await v1(server, { v: 1, token: "tok", op: "r2.get", bucket: "UP", key: "k" });
  expect(got.json.found).toBe(true);
  expect(got.bytes.length).toBe(1024);
  expect(Buffer.from(got.bytes).equals(Buffer.from(body))).toBe(true);
  server.stop();
});

test("v1: a binary static asset round-trips without UTF-8 replacement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-binary-asset-"));
  const assets = join(dir, "assets");
  mkdirSync(assets);
  const body = new Uint8Array(256);
  for (let index = 0; index < body.length; index++) body[index] = index;
  writeFileSync(join(assets, "fixture.bin"), body);
  writeFileSync(
    join(dir, "assets.json"),
    JSON.stringify({
      headers: [{ pattern: "/*", set: [["X-Test", "asset"]], unset: ["ETag"] }],
      redirects: [{ from: "/old", to: "/new", status: 301 }],
      notFound: "none",
      runSproutFirst: false,
      files: {
        "/fixture.bin": { type: "application/octet-stream", hash: "fixture" },
        "/old": { type: "text/html", hash: "missing-file" },
      },
    }),
  );
  const b = make({ bindings: { assets: "ASSETS" }, assetsDir: assets, token: "tok" });
  const server = listen(b, "127.0.0.1", 0);
  const got = await v1(server, { v: 1, token: "tok", op: "assets.get", path: "/fixture.bin" });
  expect(got.json.found).toBe(true);
  expect(got.json.rules).toEqual({
    headers: [{ pattern: "/*", set: [["X-Test", "asset"]], unset: ["ETag"] }],
    redirects: [{ from: "/old", to: "/new", status: 301 }],
  });
  const missing = await v1(server, { v: 1, token: "tok", op: "assets.get", path: "/old" });
  expect(missing.json.found).toBe(false);
  expect(missing.json.status).toBe(301);
  expect(missing.json.location).toBe("/new");
  expect(missing.bytes.length).toBe(0);
  expect(missing.json.rules).toEqual(got.json.rules);
  expect(Buffer.from(got.bytes).equals(Buffer.from(body))).toBe(true);
  server.stop();
  b.close();
  rmSync(dir, { recursive: true, force: true });
});

test("v1: the etag is sha256 of the bytes, matching the v0 path", async () => {
  const b = make({ bindings: { r2: ["UP"] }, token: "tok" });
  const server = listen(b, "127.0.0.1", 0);
  const body = new TextEncoder().encode("the file contents");
  const put = await v1(server, { v: 1, token: "tok", op: "r2.put", bucket: "UP", key: "k" }, body);
  expect(obj(put.json.object).etag).toBe(createHash("sha256").update(body).digest("hex"));
  server.stop();
});

test("v1: a wrong token is refused before the op runs", async () => {
  const b = make({ bindings: { r2: ["UP"] }, token: "tok" });
  const server = listen(b, "127.0.0.1", 0);
  const reply = await v1(server, { v: 1, token: "nope", op: "r2.put", bucket: "UP", key: "k" }, new Uint8Array(4));
  expect(reply.json.ok).toBe(false);
  expect(reply.json.error).toBe("unauthorized");
  server.stop();
});

test("v0 frames still work, so an older artifact keeps running", async () => {
  // The compatibility that matters: rollback can reactivate a sprout built
  // before v1 existed, and it will speak the token-line format forever.
  const b = make({ bindings: { kv: ["CACHE"] }, token: "tok" });
  const reply = await b.handleFrame(Buffer.from('tok\n{"op":"kv.put","ns":"CACHE","key":"k","value":"v"}', "utf8"));
  const len = reply.readUInt32LE(0);
  expect(reply[4]).not.toBe(1); // a v0 request gets a v0 reply
  expect(obj(parseJsonValue(reply.subarray(4, 4 + len).toString("utf8"))).ok).toBe(true);
});

test("a resent request is applied once, not twice (#63 §3)", async () => {
  const b = make({ bindings: { d1: ["DB"] } });
  const frame = (msg: Frame) => Buffer.from(`\n${JSON.stringify(msg)}`, "utf8");
  await b.handleFrame(frame({ v: 1, id: 1, op: "d1.exec", db: "DB", sql: "CREATE TABLE t (v TEXT)" }));

  // The same id three times is what a reconnect produces: the transport retries
  // the exact bytes, having no way to know whether the first attempt landed.
  const insert = { v: 1, id: 42, op: "d1.query", db: "DB", sql: "INSERT INTO t (v) VALUES ('x')" };
  await b.handleFrame(frame(insert));
  await b.handleFrame(frame(insert));
  await b.handleFrame(frame(insert));

  const counted = await b.dispatch({ op: "d1.query", db: "DB", sql: "SELECT count(*) AS n FROM t" });
  expect(obj(arr(counted.results)[0]).n).toBe(1);

  // A different id is a different request and does apply.
  await b.handleFrame(frame({ ...insert, id: 43 }));
  const after = await b.dispatch({ op: "d1.query", db: "DB", sql: "SELECT count(*) AS n FROM t" });
  expect(obj(arr(after.results)[0]).n).toBe(2);
});

test("replaying a read is allowed, since it changes nothing", async () => {
  const b = make({ bindings: { kv: ["CACHE"] } });
  await b.handleFrame(
    Buffer.from(`\n${JSON.stringify({ v: 1, id: 1, op: "kv.put", ns: "CACHE", key: "k", value: "v" })}`, "utf8"),
  );
  const read = async () =>
    b.handleFrame(Buffer.from(`\n${JSON.stringify({ v: 1, id: 2, op: "kv.get", ns: "CACHE", key: "k" })}`, "utf8"));
  const a = await read();
  const c = await read();
  expect(a.subarray(4).toString()).toBe(c.subarray(4).toString());
});

test("ratelimit: fixed window per key, limit/period from the message (#69)", async () => {
  const b = make({ bindings: { ratelimiters: [{ binding: "API", limit: 3, period: 60 }] } });
  const hit = (key: string) => b.dispatch({ op: "ratelimit.check", name: "API", key, limit: 3, period: 60 });

  expect((await hit("a")).success).toBe(true); // 1
  expect((await hit("a")).success).toBe(true); // 2
  expect((await hit("a")).success).toBe(true); // 3
  const over = await hit("a"); // 4 — over
  expect(over.success).toBe(false);
  // resetAt is epoch ms at the window edge, so it drives a Retry-After.
  expect(over.resetAt).toBeGreaterThan(Date.now());
  expect(over.resetAt).toBeLessThanOrEqual(Date.now() + 60_000);
  expect((await hit("b")).success).toBe(true); // a different key has its own count

  await expect(b.dispatch({ op: "ratelimit.check", name: "NOPE", key: "x", limit: 1, period: 60 })).rejects.toThrow(
    "not bound",
  );
});

test("TCP: large replies survive backpressure and stay ordered with a pipelined request", async () => {
  const bytes = Buffer.alloc(8 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  const first = frameOf(encodeV1({ ok: true, id: 1 }, bytes));
  const second = encodeFrame({ ok: true, id: 2 });
  let calls = 0;
  const broker = make();
  const server = listen(
    {
      ...broker,
      async handleFrame() {
        if (calls++ === 0) {
          await Bun.sleep(10);
          return first;
        }
        return second;
      },
    },
    "127.0.0.1",
    0,
  );
  const socket = createConnection({ host: "127.0.0.1", port: server.port });
  let resume: ReturnType<typeof setTimeout> | undefined;
  let next: ReturnType<typeof setTimeout> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const received = await new Promise<Buffer>((done, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      timeout = setTimeout(() => reject(new Error("large broker reply stalled or truncated")), 3000);
      socket.on("error", reject);
      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size >= first.length + second.length) done(Buffer.concat(chunks));
      });
      socket.on("connect", () => {
        socket.pause();
        socket.write(frameOf(Buffer.from("first")));
        next = setTimeout(() => socket.write(frameOf(Buffer.from("second"))), 2);
        resume = setTimeout(() => socket.resume(), 50);
      });
    });
    expect(received.length).toBe(first.length + second.length);
    expect(received.subarray(0, first.length).equals(first)).toBe(true);
    expect(received.subarray(first.length).equals(second)).toBe(true);
    expect(calls).toBe(2);
  } finally {
    clearTimeout(timeout);
    clearTimeout(next);
    clearTimeout(resume);
    socket.destroy();
    server.stop();
  }
}, 10_000);

test("R2 direct download: If-None-Match supports wildcard, lists and weak comparison", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-transfer-condition-"));
  const broker = make({ db: join(dir, "state.sqlite"), bindings: { r2: ["UPLOADS"] } });
  try {
    const put = await broker.dispatch({ op: "r2.put", bucket: "UPLOADS", key: "object", body: "content" });
    const etag = `"${String(obj(put.object).etag)}"`;
    const ticket = await broker.dispatch({
      op: "r2.transfer.create",
      bucket: "UPLOADS",
      key: "object",
      method: "download",
    });
    const url = `http://127.0.0.1${ticket.url}`;
    for (const value of ["*", etag, `W/${etag}`, `"other", W/${etag}`]) {
      const response = await broker.transfer(new Request(url, { headers: { "if-none-match": value } }));
      expect(response.status).toBe(304);
      expect(response.headers.get("etag")).toBe(etag);
      expect(await response.text()).toBe("");
    }
    const fresh = await broker.transfer(new Request(url, { headers: { "if-none-match": '"different"' } }));
    expect(fresh.status).toBe(200);
    expect(await fresh.text()).toBe("content");
    expect((await broker.transfer(new Request(url))).status).toBe(410);
  } finally {
    broker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listen(): a service.fetch body streamed in FRAME_V1_MORE frames reaches the upstream as it arrives", async () => {
  const arrivals: { text: string; at: number }[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    // SAFETY: the broker passes the BodySink's ReadableStream as the body of a streamed request.
    const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      arrivals.push({ text: new TextDecoder().decode(value), at: Date.now() });
    }
    return new Response(arrivals.map((a) => a.text).join(""));
  };
  const b = make({
    token: "tok",
    bindings: { services: [{ binding: "PEER", service: "peer" }] },
    services: { PEER: "peer.example.com" },
    edgeUrl: "http://127.0.0.1:8080/",
    fetchImpl,
  });
  const server = listen(b, "127.0.0.1", 0);
  const socket = createConnection({ host: "127.0.0.1", port: server.port });
  const replies: Buffer[] = [];
  let pending = Buffer.alloc(0);
  socket.on("data", (data: Buffer) => {
    pending = Buffer.concat([pending, data]);
    while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
      replies.push(pending.subarray(4, 4 + pending.readUInt32LE(0)));
      pending = pending.subarray(4 + pending.readUInt32LE(0));
    }
  });
  await new Promise((done) => socket.once("connect", done));
  const head = {
    v: 1,
    token: "tok",
    op: "service.fetch",
    binding: "PEER",
    url: "https://peer/up",
    method: "POST",
    bodyStream: true,
  };
  socket.write(frameOf(encodeV1(head)));
  socket.write(frameOf(encodeV1({ chunk: true }, new TextEncoder().encode("first "), true)));
  await Bun.sleep(300);
  expect(arrivals.map((a) => a.text)).toEqual(["first "]);
  socket.write(frameOf(encodeV1({ chunk: true }, new TextEncoder().encode("second"), true)));
  socket.write(frameOf(encodeV1({ end: true }, undefined, true)));
  for (let i = 0; i < 100 && replies.length === 0; i++) await Bun.sleep(20);
  const jsonLength = replies[0].readUInt32LE(1);
  expect(JSON.parse(replies[0].subarray(5, 5 + jsonLength).toString())).toMatchObject({ ok: true, status: 200 });
  expect(replies[0].subarray(5 + jsonLength).toString()).toBe("first second");
  expect(arrivals[1].at - arrivals[0].at).toBeGreaterThan(200);
  // The broker says it takes streamed bodies.
  expect(await b.dispatch({ op: "ping" })).toMatchObject({ bodyStream: true });
  socket.destroy();
  server.stop();
});

test("Queues 2026-11-05: a delivery that never comes back is a retry, and past max_retries goes to the dead letter queue", async () => {
  const delivered: JsonObject[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    delivered.push(obj(parseJsonValue(String(init?.body))));
    throw new Error("the sprout died");
  };
  const b = make({
    bindings: {
      queues: ["JOBS", "DEAD"],
      queueConfig: [
        { binding: "JOBS", queue: "jobs", maxRetries: 1, deadLetterQueue: "dead" },
        { binding: "DEAD", queue: "dead" },
      ],
    },
    sproutUrl: "http://127.0.0.1:1/",
    fetchImpl,
    deliveryTimeoutMs: 100,
    deliveryLeaseMs: 200,
  });
  await b.dispatch({ op: "queue.consumer", queue: "JOBS" });
  await b.dispatch({ op: "queue.send", queue: "JOBS", body: "work" });
  await Bun.sleep(2500);
  // max_retries 1: two deliveries, then the dead letter queue (whose consumer is this sprout too).
  expect(delivered.filter((d) => d.queue === "JOBS").length).toBe(2);
  expect(delivered.filter((d) => d.queue === "DEAD").length).toBeGreaterThan(0);
  expect(await b.dispatch({ op: "queue.metrics", queue: "JOBS" })).toMatchObject({ metrics: { backlogCount: 0 } });
});

test("Queues: without the 2026-11-05 announcement a lost delivery is retried after 5 s, as before", async () => {
  const delivered: JsonObject[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    delivered.push(obj(parseJsonValue(String(init?.body))));
    throw new Error("the sprout died");
  };
  const b = make({
    bindings: {
      queues: ["JOBS", "DEAD"],
      queueConfig: [
        { binding: "JOBS", queue: "jobs", maxRetries: 1, deadLetterQueue: "dead" },
        { binding: "DEAD", queue: "dead" },
      ],
    },
    sproutUrl: "http://127.0.0.1:1/",
    fetchImpl,
    deliveryTimeoutMs: 100,
    deliveryLeaseMs: 200,
  });
  await b.dispatch({ op: "queue.send", queue: "JOBS", body: "work" });
  await Bun.sleep(1500);
  expect(delivered.filter((d) => d.queue === "DEAD").length).toBe(0);
  expect(delivered.filter((d) => d.queue === "JOBS").length).toBe(1);
});
