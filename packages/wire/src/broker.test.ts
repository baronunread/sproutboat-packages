import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBroker,
  cronMatches,
  encodeFrame,
  encodeV1,
  listen,
  type Broker,
  type Frame,
  type FetchLike,
} from "./broker";
import { createHash } from "node:crypto";
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
  const b = createBroker(opts);
  brokers.push(b);
  return b;
}

test("ping round-trips", async () => {
  const b = make();
  expect(await b.dispatch({ op: "ping", msg: "hi" })).toMatchObject({ ok: true, op: "pong", echo: "hi" });
});

test("KV put / get / list / delete, scoped to a bound namespace", async () => {
  const b = make({ bindings: { kv: ["CACHE"] } });
  expect(await b.dispatch({ op: "kv.get", ns: "CACHE", key: "k" })).toEqual({ ok: true, found: false, value: null });
  await b.dispatch({ op: "kv.put", ns: "CACHE", key: "k", value: "v" });
  await b.dispatch({ op: "kv.put", ns: "CACHE", key: "k2", value: "v2" });
  expect(await b.dispatch({ op: "kv.get", ns: "CACHE", key: "k" })).toEqual({ ok: true, found: true, value: "v" });
  expect(await b.dispatch({ op: "kv.list", ns: "CACHE", prefix: "k" })).toEqual({ ok: true, keys: ["k", "k2"] });
  await b.dispatch({ op: "kv.delete", ns: "CACHE", key: "k" });
  expect(await b.dispatch({ op: "kv.get", ns: "CACHE", key: "k" })).toMatchObject({ found: false });
});

test("an unbound KV namespace is rejected", async () => {
  const b = make({ bindings: { kv: ["CACHE"] } });
  await expect(b.dispatch({ op: "kv.put", ns: "OTHER", key: "k", value: "v" })).rejects.toThrow("not bound");
});

test("secrets resolve only when both bound and present", async () => {
  const b = make({ bindings: { secrets: ["API_KEY", "MISSING"] }, secrets: { API_KEY: "s3cr3t" } });
  expect(await b.dispatch({ op: "secret.get", name: "API_KEY" })).toEqual({ ok: true, value: "s3cr3t" });
  await expect(b.dispatch({ op: "secret.get", name: "MISSING" })).rejects.toThrow("no value");
  await expect(b.dispatch({ op: "secret.get", name: "UNBOUND" })).rejects.toThrow("not bound");
});

test("fetch is gated by the exact-host allowlist", async () => {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(String(url));
    return new Response("body", { status: 200, headers: { "x-mark": "1" } });
  };
  const b = make({ bindings: { outbound: ["api.example.com"] }, fetchImpl });

  await expect(b.dispatch({ op: "fetch", url: "https://evil.example.com/x" })).rejects.toThrow("allowlist");
  expect(calls).toEqual([]);

  const res = await b.dispatch({ op: "fetch", url: "https://api.example.com/x" });
  expect(res).toMatchObject({ ok: true, status: 200, body: "body" });
  expect(calls).toEqual(["https://api.example.com/x"]);
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
    expect(await second.dispatch({ op: "kv.get", ns: "SHORTENER", key: "a" })).toEqual({
      ok: true,
      found: true,
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

test("service: a call is not subject to the outbound allowlist", async () => {
  // The target is reached internally through the edge, so a project with no
  // `outbound` hosts can still call a service binding.
  const fetchImpl: FetchLike = async () => new Response("ok", { status: 200 });
  const b = make({
    bindings: { ...svcBindings, outbound: [] },
    services: { AUTH: "auth-api.andrea.example.com" },
    edgeUrl: "http://127.0.0.1:8080/",
    fetchImpl,
  });
  expect((await b.dispatch({ op: "service.fetch", binding: "AUTH", url: "https://service/" })).status).toBe(200);
  // ...while real egress to the same host is still refused.
  await expect(b.dispatch({ op: "fetch", url: "https://auth-api.andrea.example.com/" })).rejects.toThrow(
    /outbound allowlist/,
  );
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
      notFound: "none",
      runSproutFirst: false,
      files: { "/fixture.bin": { type: "application/octet-stream", hash: "fixture" } },
    }),
  );
  const b = make({ bindings: { assets: "ASSETS" }, assetsDir: assets, token: "tok" });
  const server = listen(b, "127.0.0.1", 0);
  const got = await v1(server, { v: 1, token: "tok", op: "assets.get", path: "/fixture.bin" });
  expect(got.json.found).toBe(true);
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
