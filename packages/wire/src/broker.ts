#!/usr/bin/env bun
/**
 * Per-deployment binding broker.
 *
 * A native-fetch sprout has no syscalls of its own beyond an inbound HTTP
 * server; the prelude's inline-C transport opens a loopback TCP connection to
 * this process for every `env.<KV>` / `env.<SECRET>` / `fetch()` call. The
 * supervisor starts one broker per deployment, on its own loopback port, and
 * passes `SB_BROKER_PORT` + `SB_BROKER_TOKEN` to the sprout next to `$PORT`.
 *
 * Wire frame (both directions): [u32 LE length][payload].
 *   request payload : "<token>\n<json>"
 *   reply payload   : "<json>"
 *
 * ponytail: one SQLite file for KV, secrets from a plain JSON file, fetch
 * allowlisted by exact host. Encryption at rest, per-key TTLs, redirect
 * re-validation and private-IP blocking are v2 — the exact-host allowlist is
 * the only SSRF control today.
 */
import { Database, type Statement } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveAssetKey, type AssetManifest } from "@sproutboat/assets";
import { isSafeInteger } from "./json";
import { isBoolean, isString, jsonObject, parseJsonValue, type JsonObject, type JsonValue } from "./json";

export type Bindings = {
  kv: string[];
  secrets: string[];
  outbound: string[];
  d1: string[];
  r2: string[];
  queues: string[];
  analytics: string[];
  do: Array<{ binding: string; className: string }>;
  /** #48 — worker-to-worker: binding name -> the project it calls. */
  services: Array<{ binding: string; service: string }>;
  crons: string[];
  /** #69 — rate limiters. Only the names are used here; the message carries
   *  `limit` / `period` (both come from the same baked config as the handler). */
  ratelimiters: Array<{ binding: string; limit: number; period: number }>;
  /** Static-asset binding name, or `""` when assets are edge-only. */
  assets: string;
  /**
   * #74 — binding name -> account-level resource it resolves to. A binding with
   * an entry here stores in a per-resource SQLite file under `resourceDir`,
   * keyed by `id`, shared across this owner's deployments; a binding without one
   * falls back to the per-broker `db` partitioned by its own name (local dev).
   */
  resources: Record<string, { kind: "kv" | "d1" | "r2" | "queue"; id: string }>;
};
/** One decoded wire frame. `undefined` fields are dropped by `JSON.stringify`, so
 *  an optional reply field can be left off without a second object shape. */
export type Frame = { [key: string]: JsonValue | undefined };

/** The only shape of `fetch` the broker calls — the global `fetch` satisfies it. */
export type FetchLike = (input: URL | string, init?: RequestInit) => Promise<Response>;

export type BrokerOptions = {
  db?: string;
  /** Directory for per-D1-binding SQLite files. Defaults to `<dirname(db)>/d1`, or in-memory when `db` is `:memory:`. */
  dataDir?: string;
  /**
   * #48 — where to send a service-binding call: the node's edge, on loopback.
   * Forwarding through the edge rather than dialling the target sprout directly
   * reuses everything the request path already does — routing, the process
   * pool, cold start, metrics, logs — and means the broker needs no knowledge
   * of where a deployment is running.
   */
  edgeUrl?: string;
  /**
   * #48 — binding name -> the target's hostname, resolved by the control plane
   * at activation. Not part of the artifact: the same binary deploys to boxes
   * with different domains, and a target can be redeployed without rebuilding
   * its callers.
   */
  services?: Record<string, string>;
  /**
   * #74 — directory holding one `<resource-id>.sqlite` per account-level KV / R2 /
   * queue / D1 resource. Defaults to `<dirname(db)>/resources`, in-memory when
   * `db` is `:memory:`. The supervisor points this at an owner-stable path so the
   * data outlives a redeploy.
   */
  resourceDir?: string;
  token?: string;
  bindings?: Partial<Bindings>;
  secrets?: Record<string, string>;
  /**
   * `http://127.0.0.1:<PORT>` of this deployment's sprout. When set, the broker
   * runs the cron scheduler and the queue consumer, delivering to the sprout
   * with an `x-sb-trigger` header authenticated by `token`.
   */
  sproutUrl?: string;
  /** Lets a supervisor prepare a replacement without two brokers claiming
   * queues, alarms, or cron ticks at once. Defaults to active. */
  dispatchEnabled?: () => boolean;
  /** Directory of published static assets (its sibling `assets.json` is the manifest). Backs `assets.get`. */
  assetsDir?: string;
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
};

type SqlParam = string | number | null;
/** The `{ results, meta }` shape Cloudflare's D1 client expects back per statement. */
type D1Result = {
  results: JsonValue[];
  meta: { duration: number; changes: number; last_row_id: number; rows_read: number };
};
type R2Row = {
  key: string;
  /** TEXT from a v0 write, BLOB from a v1 one; sqlite hands each back as-is. */
  body: string | Uint8Array;
  size: number;
  etag: string;
  uploaded: string;
  http_json: string;
  custom_json: string;
};
const isNumber = (v: JsonValue | undefined): v is number => Number.isFinite(v);
const sqlParams = (v: JsonValue | undefined): SqlParam[] => {
  if (!Array.isArray(v)) return [];
  return v.map((p) => (p === null || isNumber(p) || isString(p) ? p : isBoolean(p) ? (p ? 1 : 0) : String(p)));
};

// One binding call = one frame, and an R2/KV value travels inside it as a JSON
// string (escaping can inflate binary content several ×). 32 MiB keeps a ~25 MB
// upload working; true large-object streaming is v2.
const MAX_FRAME = 32 * 1024 * 1024;
const str = (v: JsonValue | undefined): string => (isString(v) ? v : String(v ?? ""));

export type Broker = {
  /** Run one parsed request object through the op dispatch. */
  dispatch(msg: Frame): Promise<Frame>;
  /** Verify the token line and dispatch a raw "<token>\n<json>" payload. */
  handlePayload(payload: string): Promise<Frame>;
  /**
   * #63 — one wire frame in, one out, binary included.
   *
   * v0 payloads are `"<token>\n<json>"` and stay exactly as they were: a
   * deployment built before this existed keeps working against a newer broker.
   * v1 starts with a 0x01 marker and carries `[u32 LE json length][json][bytes]`,
   * so an object body never has to be escaped into the JSON. A token's first
   * character is never 0x01, which is what makes the two tellable apart without
   * negotiation.
   */
  handleFrame(payload: Buffer): Promise<Buffer>;
  close(): void;
};

/** First byte of a v1 payload. */
export const FRAME_V1 = 1;

/** Wrap a payload in the [u32 LE length] header every frame carries. */
export function frameOf(payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(4 + payload.length);
  out.writeUInt32LE(payload.length, 0);
  payload.copy(out, 4);
  return out;
}

/** Build a v1 payload: marker, json length, json, then the bytes. */
export function encodeV1(json: Frame, binary?: Uint8Array): Buffer {
  const body = Buffer.from(JSON.stringify(json), "utf8");
  const bin = binary ?? new Uint8Array(0);
  const out = Buffer.allocUnsafe(1 + 4 + body.length + bin.length);
  out.writeUInt8(FRAME_V1, 0);
  out.writeUInt32LE(body.length, 1);
  body.copy(out, 5);
  if (bin.length) Buffer.from(bin.buffer, bin.byteOffset, bin.length).copy(out, 5 + body.length);
  return out;
}

export function createBroker(opts: BrokerOptions = {}): Broker {
  const bindings: Bindings = {
    kv: [],
    secrets: [],
    outbound: [],
    d1: [],
    r2: [],
    queues: [],
    analytics: [],
    do: [],
    services: [],
    crons: [],
    ratelimiters: [],
    assets: "",
    resources: {},
    ...opts.bindings,
  };
  const secrets = opts.secrets ?? {};

  // Static assets: read the manifest once. Files are read from disk per request
  // (small, OS-cached); no need to hold bodies in memory.
  const assetsDir = opts.assetsDir ? resolve(opts.assetsDir) : null;
  let assetManifest: AssetManifest | null = null;
  if (assetsDir) {
    const manifestPath = join(dirname(assetsDir), "assets.json");
    if (existsSync(manifestPath)) {
      // SAFETY: assets.json sits beside the published assets dir and is written
      // only by `sproutboat build` from the AssetManifest contract.
      assetManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as AssetManifest;
    }
  }
  const readAsset = (path: string): { type: string; hash: string; body: Uint8Array } | null => {
    if (!assetsDir || !assetManifest) return null;
    const entry = assetManifest.files[path];
    if (!entry) return null;
    // path keys are `/`-prefixed and `..`-free (walkAssets), but re-check.
    const abs = normalize(join(assetsDir, path));
    if (!abs.startsWith(assetsDir)) return null;
    return { type: entry.type, hash: entry.hash, body: readFileSync(abs) };
  };
  const token = opts.token ?? "";
  /** #63 §3 — replies to recent non-idempotent requests, keyed by op and id. */
  const replayed = new Map<string, Frame>();
  const serviceHosts = opts.services ?? {};
  const doFetch = opts.fetchImpl ?? fetch;

  const dbPath = opts.db ?? ":memory:";
  const inMemory = dbPath === ":memory:" || dbPath === "";
  const d1Dir = opts.dataDir ?? (inMemory ? null : join(dirname(resolve(dbPath)), "d1"));
  const resourceDir = opts.resourceDir ?? (inMemory ? null : join(dirname(resolve(dbPath)), "resources"));

  // WAL + NORMAL is the standard pairing: a write no longer fsyncs the WAL, so
  // host power loss can drop the last few committed txns, but a process crash
  // never can and the file never corrupts. Right trade for a single-VPS
  // KV/queue/DO store; on real block storage this is ~10-100x on writes.
  const openStore = (path: string): Database => {
    const conn = new Database(path, { create: true });
    conn.exec("PRAGMA journal_mode = WAL");
    conn.exec("PRAGMA synchronous = NORMAL");
    conn.exec(
      "CREATE TABLE IF NOT EXISTS kv (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (ns, key))",
    );
    conn.exec(
      "CREATE TABLE IF NOT EXISTS r2 (bucket TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, size INTEGER NOT NULL, " +
        "etag TEXT NOT NULL, uploaded TEXT NOT NULL, http_json TEXT NOT NULL DEFAULT '{}', custom_json TEXT NOT NULL DEFAULT '{}', " +
        "PRIMARY KEY (bucket, key))",
    );
    conn.exec(
      "CREATE TABLE IF NOT EXISTS mq (queue TEXT NOT NULL, id TEXT PRIMARY KEY, body TEXT NOT NULL, " +
        "visible_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, dead INTEGER NOT NULL DEFAULT 0)",
    );
    // Every queue poll filters one partition's live rows and takes its earliest
    // visible batch. This additive index also upgrades existing resource files.
    conn.exec("CREATE INDEX IF NOT EXISTS mq_due ON mq (queue, dead, visible_at)");
    return conn;
  };

  const db = openStore(dbPath);
  // Durable Object storage and Analytics Engine rows stay in the per-broker db —
  // neither is an account-level resource (#74).
  db.exec(
    "CREATE TABLE IF NOT EXISTS do_storage (cls TEXT NOT NULL, id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, " +
      "PRIMARY KEY (cls, id, key))",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS ae (dataset TEXT NOT NULL, ts INTEGER NOT NULL, indexes_json TEXT NOT NULL, " +
      "blobs_json TEXT NOT NULL, doubles_json TEXT NOT NULL)",
  );
  // #125 — at most one pending alarm per object, which is the Workers rule: a
  // later setAlarm replaces the earlier one rather than queueing beside it.
  db.exec(
    "CREATE TABLE IF NOT EXISTS do_alarm (cls TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, " +
      "attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (cls, id))",
  );
  // Alarm polling reads the earliest due objects across classes.
  db.exec("CREATE INDEX IF NOT EXISTS do_alarm_due ON do_alarm (at)");
  // #69 — fixed-window rate-limiter counters, per binding name + key.
  db.exec(
    "CREATE TABLE IF NOT EXISTS ratelimit (name TEXT NOT NULL, key TEXT NOT NULL, window_start INTEGER NOT NULL, " +
      "count INTEGER NOT NULL, PRIMARY KEY (name, key))",
  );

  // #74 — one SQLite file per account-level resource id, opened on first use.
  const resourceDbs = new Map<string, Database>();
  const resourceDb = (id: string): Database => {
    let conn = resourceDbs.get(id);
    if (!conn) {
      if (resourceDir) mkdirSync(resourceDir, { recursive: true });
      conn = openStore(resourceDir ? join(resourceDir, `${id}.sqlite`) : ":memory:");
      resourceDbs.set(id, conn);
    }
    return conn;
  };

  /**
   * Where a KV / R2 / queue binding stores: its resource's own file keyed by
   * `id` when the config bound it to one, else the per-broker `db` partitioned
   * by the binding name (bare-string bindings / local dev).
   */
  const storeFor = (kind: "kv" | "r2" | "queue", binding: string): { store: Database; part: string } => {
    const resource = bindings.resources[binding];
    return resource && resource.kind === kind
      ? { store: resourceDb(resource.id), part: resource.id }
      : { store: db, part: binding };
  };

  type KvStmts = {
    get: Statement<{ value: string }, [string, string]>;
    put: Statement<unknown, [string, string, string]>;
    del: Statement<unknown, [string, string]>;
    list: Statement<{ key: string }, [string, string]>;
  };
  const kvStmtCache = new Map<Database, KvStmts>();
  const kvStmts = (store: Database): KvStmts => {
    let stmts = kvStmtCache.get(store);
    if (!stmts) {
      stmts = {
        get: store.query<{ value: string }, [string, string]>("SELECT value FROM kv WHERE ns = ? AND key = ?"),
        put: store.query(
          "INSERT INTO kv (ns, key, value) VALUES (?1, ?2, ?3) ON CONFLICT (ns, key) DO UPDATE SET value = ?3",
        ),
        del: store.query("DELETE FROM kv WHERE ns = ? AND key = ?"),
        list: store.query<{ key: string }, [string, string]>(
          "SELECT key FROM kv WHERE ns = ? AND key LIKE ? || '%' ORDER BY key LIMIT 1000",
        ),
      };
      kvStmtCache.set(store, stmts);
    }
    return stmts;
  };

  const bound =
    (list: string[], kind: string) =>
    (name: JsonValue | undefined): string => {
      const n = str(name);
      if (!list.includes(n)) throw new Error(`${kind} not bound: ${n}`);
      return n;
    };
  const requireKv = bound(bindings.kv, "KV namespace");
  const requireD1 = bound(bindings.d1, "D1 database");
  const requireR2 = bound(bindings.r2, "R2 bucket");
  const requireQueue = bound(bindings.queues, "queue");
  const requireAe = bound(bindings.analytics, "analytics dataset");
  const rateLimiterNames = bindings.ratelimiters.map((r) => r.binding);
  const requireRateLimiter = bound(rateLimiterNames, "rate limiter");
  const doClasses = new Set(bindings.do.map((d) => d.className));
  const requireDoClass = (cls: JsonValue | undefined): string => {
    const n = str(cls);
    if (!doClasses.has(n)) throw new Error(`Durable Object class not bound: ${n}`);
    return n;
  };
  const newId = () => createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 24);

  // One SQLite database per bound D1 binding — independent SQL namespaces. A
  // binding wired to an account-level resource (#74) opens `<resource-id>.sqlite`
  // under `resourceDir` (survives redeploys); a bare-string binding keeps its
  // per-broker `<name>.sqlite` under `d1Dir`.
  const d1Conns = new Map<string, Database>();
  const d1 = (name: string): Database => {
    const resource = bindings.resources[name];
    const key = resource && resource.kind === "d1" ? resource.id : name;
    let conn = d1Conns.get(key);
    if (!conn) {
      const dir = resource && resource.kind === "d1" ? resourceDir : d1Dir;
      if (dir) mkdirSync(dir, { recursive: true });
      conn = new Database(dir ? join(dir, `${key}.sqlite`) : ":memory:", { create: true });
      conn.exec("PRAGMA journal_mode = WAL");
      conn.exec("PRAGMA synchronous = NORMAL");
      d1Conns.set(key, conn);
    }
    return conn;
  };

  // Run one statement, return CF-D1-shaped { results, meta }.
  const d1Run = (conn: Database, sql: string, params: SqlParam[]): D1Result => {
    const started = performance.now();
    // SQLite hands back column->(string|number|null|blob) rows, i.e. a JSON object.
    const results = conn.query<JsonObject, SqlParam[]>(sql).all(...params);
    const m = conn
      .query<{ changes: number; last_row_id: number }, []>(
        "SELECT changes() AS changes, last_insert_rowid() AS last_row_id",
      )
      .get();
    return {
      results,
      meta: {
        duration: performance.now() - started,
        changes: m?.changes ?? 0,
        last_row_id: m?.last_row_id ?? 0,
        rows_read: results.length,
      },
    };
  };

  // #164 — an online, integrity-checked snapshot of a D1 database via
  // VACUUM INTO. Standalone (transport-embedded) is the primary target; the
  // broker carries it too so one conformance suite covers both backends.
  const d1Backup = (conn: Database, dbName: string, name: string) => {
    const source = conn.filename;
    if (!source || source === ":memory:") throw new Error("d1 backup needs a file-backed database");
    // A caller-supplied name must be a plain basename; else use the default.
    const file = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
      ? name
      : `${dbName}-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`;
    const dir = join(dirname(dirname(resolve(source))), "backups");
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, file);
    if (existsSync(dest)) rmSync(dest); // VACUUM INTO refuses an existing target
    conn.run("VACUUM INTO ?", [dest]);
    const copy = new Database(dest, { readonly: true });
    try {
      const row = copy.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
      if (row?.integrity_check !== "ok") {
        rmSync(dest, { force: true });
        throw new Error("integrity check failed on the backup");
      }
    } finally {
      copy.close();
    }
    return { path: dest, bytes: statSync(dest).size };
  };

  /** An object body as bytes, whichever storage class it came back in. */
  const r2Bytes = (body: string | Uint8Array): Uint8Array =>
    body instanceof Uint8Array ? body : new TextEncoder().encode(body);

  /** An object body as text, for the v0 reply shape that carries it in JSON.
   *  A binary object stored by a v1 client cannot survive this, which is why
   *  v1 exists — but returning a decoded string beats returning `{"0":...}`. */
  const r2Text = (body: string | Uint8Array): string =>
    body instanceof Uint8Array ? new TextDecoder().decode(body) : body;

  const r2Row = (r: R2Row) => ({
    key: r.key,
    size: r.size,
    etag: r.etag,
    uploaded: r.uploaded,
    httpMetadata: parseJsonValue(r.http_json),
    customMetadata: parseJsonValue(r.custom_json),
  });

  /**
   * An outbound response body, refused past a cap.
   *
   * The size is the remote host's choice, and the body is held whole: measured
   * on a standalone binary, a 100 MB response took resident memory from 43 MB
   * to 321 MB. One allowlisted upstream having a bad day should not be able to
   * end the process. 32 MiB by default, and the same variable the embedded
   * transport reads so both backends agree.
   */
  async function readCapped(response: Response, host: string): Promise<string> {
    const cap = Number(process.env.SB_FETCH_MAX_BYTES) || 32 * 1024 * 1024;
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > cap) throw new Error(`response exceeds SB_FETCH_MAX_BYTES from ${host}`);
    const reader = response.body?.getReader();
    if (!reader) return "";
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        throw new Error(`response exceeds SB_FETCH_MAX_BYTES from ${host}`);
      }
      parts.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(parts));
  }

  async function proxyFetch(msg: Frame): Promise<Frame> {
    let url: URL;
    try {
      url = new URL(str(msg.url));
    } catch {
      throw new Error(`invalid url: ${str(msg.url)}`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`unsupported protocol: ${url.protocol}`);
    if (!bindings.outbound.includes(url.host)) throw new Error(`host not in outbound allowlist: ${url.host}`);

    const headers = new Headers();
    if (Array.isArray(msg.headers)) {
      for (const pair of msg.headers) {
        if (Array.isArray(pair) && pair.length === 2) headers.set(str(pair[0]), str(pair[1]));
      }
    }
    const method = str(msg.method || "GET").toUpperCase();
    const res = await doFetch(url, {
      method,
      headers,
      body: msg.body == null || method === "GET" || method === "HEAD" ? undefined : str(msg.body),
      redirect: "manual",
    });
    const outHeaders: Array<[string, string]> = [];
    res.headers.forEach((v, k) => outHeaders.push([k, v]));
    return { ok: true, status: res.status, headers: outHeaders, body: await readCapped(res, url.host) };
  }

  /**
   * #48 — forward a service-binding call to the target deployment via the edge.
   *
   * The Host header is the whole routing decision: the edge matches a route by
   * hostname, so this is exactly the request the outside world would make,
   * minus the trip through the network (and therefore minus TLS and the
   * default-deny egress rules, which is why this is not `fetch`).
   */
  async function serviceFetch(msg: Frame): Promise<Frame> {
    const binding = str(msg.binding);
    const declared = bindings.services.find((entry) => entry.binding === binding);
    if (!declared) throw new Error(`service not bound: ${binding}`);
    const host = serviceHosts[binding];
    // Declared in the artifact but unresolved at activation: the target project
    // does not exist, or is not deployed yet. Say which, rather than 502.
    if (!host) throw new Error(`service ${binding} -> "${declared.service}" is not deployed on this control plane`);
    if (!opts.edgeUrl) throw new Error(`service ${binding} cannot be called: this broker has no edge url`);

    let path = "/";
    try {
      const parsed = new URL(str(msg.url));
      path = `${parsed.pathname}${parsed.search}`;
    } catch {
      path = str(msg.url) || "/";
      if (!path.startsWith("/")) path = `/${path}`;
    }
    const headers = new Headers();
    if (Array.isArray(msg.headers)) {
      for (const pair of msg.headers) {
        if (Array.isArray(pair) && pair.length === 2) headers.set(str(pair[0]), str(pair[1]));
      }
    }
    headers.set("host", host);
    const method = str(msg.method || "GET").toUpperCase();
    const target = new URL(path, opts.edgeUrl);
    const res = await doFetch(target, {
      method,
      headers,
      body: msg.body == null || method === "GET" || method === "HEAD" ? undefined : str(msg.body),
      redirect: "manual",
    });
    const outHeaders: Array<[string, string]> = [];
    res.headers.forEach((v, k) => outHeaders.push([k, v]));
    return { ok: true, status: res.status, headers: outHeaders, body: await readCapped(res, host) };
  }

  async function dispatch(msg: Frame): Promise<Frame> {
    switch (msg.op) {
      case "ping":
        return { ok: true, op: "pong", echo: msg.msg ?? null, pid: process.pid };
      case "kv.get": {
        const { store, part } = storeFor("kv", requireKv(msg.ns));
        const row = kvStmts(store).get.get(part, str(msg.key));
        return row ? { ok: true, found: true, value: row.value } : { ok: true, found: false, value: null };
      }
      case "kv.put": {
        const { store, part } = storeFor("kv", requireKv(msg.ns));
        kvStmts(store).put.run(part, str(msg.key), str(msg.value));
        return { ok: true };
      }
      case "kv.delete": {
        const { store, part } = storeFor("kv", requireKv(msg.ns));
        kvStmts(store).del.run(part, str(msg.key));
        return { ok: true };
      }
      case "kv.list": {
        const { store, part } = storeFor("kv", requireKv(msg.ns));
        return {
          ok: true,
          keys: kvStmts(store)
            .list.all(part, str(msg.prefix))
            .map((r) => r.key),
        };
      }
      case "secret.get": {
        const name = str(msg.name);
        if (!bindings.secrets.includes(name)) throw new Error(`secret not bound: ${name}`);
        if (!(name in secrets)) throw new Error(`secret has no value: ${name}`);
        return { ok: true, value: secrets[name] };
      }
      case "fetch":
        return proxyFetch(msg);

      case "service.fetch":
        return serviceFetch(msg);

      case "d1.query": {
        const conn = d1(requireD1(msg.db));
        return { ok: true, ...d1Run(conn, str(msg.sql), sqlParams(msg.params)) };
      }
      case "d1.batch": {
        const conn = d1(requireD1(msg.db));
        const stmts = Array.isArray(msg.statements) ? msg.statements.map((s) => jsonObject(s) ?? {}) : [];
        const runAll = conn.transaction(() => stmts.map((s) => d1Run(conn, str(s.sql), sqlParams(s.params))));
        return { ok: true, results: runAll() };
      }
      case "d1.exec": {
        const conn = d1(requireD1(msg.db));
        conn.exec(str(msg.sql));
        return { ok: true };
      }
      case "d1.backup": {
        const name = requireD1(msg.db);
        return { ok: true, ...d1Backup(d1(name), name, msg.name == null ? "" : str(msg.name)) };
      }

      case "ratelimit.check": {
        // #69 — fixed window; limit/period arrive in the message. Same upsert as
        // the embedded transport so one conformance suite covers both.
        const name = requireRateLimiter(msg.name);
        const limit = Math.max(Number(msg.limit) || 1, 1);
        const period = Math.max(Number(msg.period) || 60, 1);
        const now = Math.floor(Date.now() / 1000);
        const windowStart = now - (now % period);
        const row = db
          .query<{ count: number }, [string, string, number]>(
            "INSERT INTO ratelimit (name, key, window_start, count) VALUES (?1, ?2, ?3, 1) " +
              "ON CONFLICT (name, key) DO UPDATE SET count = CASE WHEN window_start = ?3 THEN count + 1 ELSE 1 END, " +
              "window_start = ?3 RETURNING count",
          )
          .get(name, msg.key == null ? "" : str(msg.key), windowStart);
        return { ok: true, success: (row?.count ?? 1) <= limit, resetAt: (windowStart + period) * 1000 };
      }

      case "r2.put": {
        const { store, part: bucket } = storeFor("r2", requireR2(msg.bucket));
        const body = str(msg.body);
        const etag = createHash("sha256").update(body).digest("hex");
        store
          .query(
            "INSERT INTO r2 (bucket, key, body, size, etag, uploaded, http_json, custom_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) " +
              "ON CONFLICT (bucket, key) DO UPDATE SET body=?3, size=?4, etag=?5, uploaded=?6, http_json=?7, custom_json=?8",
          )
          .run(
            bucket,
            str(msg.key),
            body,
            Buffer.byteLength(body),
            etag,
            new Date().toISOString(),
            JSON.stringify(msg.httpMetadata ?? {}),
            JSON.stringify(msg.customMetadata ?? {}),
          );
        return {
          ok: true,
          object: { key: str(msg.key), size: Buffer.byteLength(body), etag, uploaded: new Date().toISOString() },
        };
      }
      case "r2.get":
      case "r2.head": {
        const { store, part: bucket } = storeFor("r2", requireR2(msg.bucket));
        const row = store
          .query<R2Row, [string, string]>("SELECT * FROM r2 WHERE bucket = ? AND key = ?")
          .get(bucket, str(msg.key));
        if (!row) return { ok: true, found: false };
        return { ok: true, found: true, object: r2Row(row), body: msg.op === "r2.get" ? r2Text(row.body) : undefined };
      }
      case "r2.delete": {
        const { store, part: bucket } = storeFor("r2", requireR2(msg.bucket));
        store.query("DELETE FROM r2 WHERE bucket = ? AND key = ?").run(bucket, str(msg.key));
        return { ok: true };
      }
      case "r2.list": {
        const { store, part: bucket } = storeFor("r2", requireR2(msg.bucket));
        const prefix = str(msg.prefix);
        const cursor = str(msg.cursor);
        const limit = Math.min(Math.max(Number(msg.limit) || 1000, 1), 1000);
        const rows = store
          .query<R2Row, [string, string, string, number]>(
            "SELECT * FROM r2 WHERE bucket = ? AND key LIKE ? || '%' AND key > ? ORDER BY key LIMIT ?",
          )
          .all(bucket, prefix, cursor, limit + 1);
        const truncated = rows.length > limit;
        const page = truncated ? rows.slice(0, limit) : rows;
        return {
          ok: true,
          objects: page.map(r2Row),
          truncated,
          cursor: truncated ? page[page.length - 1].key : null,
        };
      }

      case "queue.send": {
        const { store, part: q } = storeFor("queue", requireQueue(msg.queue));
        const at = Date.now() + Math.max(0, Number(msg.delaySeconds) || 0) * 1000;
        store
          .query("INSERT INTO mq (queue, id, body, visible_at) VALUES (?, ?, ?, ?)")
          .run(q, newId(), str(msg.body), at);
        return { ok: true };
      }
      case "queue.send_batch": {
        const { store, part: q } = storeFor("queue", requireQueue(msg.queue));
        const msgs = Array.isArray(msg.messages) ? msg.messages.map((m) => jsonObject(m) ?? {}) : [];
        const ins = store.query("INSERT INTO mq (queue, id, body, visible_at) VALUES (?, ?, ?, ?)");
        store.transaction(() => {
          for (const m of msgs)
            ins.run(q, newId(), str(m.body), Date.now() + Math.max(0, Number(m.delaySeconds) || 0) * 1000);
        })();
        return { ok: true, count: msgs.length };
      }

      case "ae.write": {
        const ds = requireAe(msg.dataset);
        db.query("INSERT INTO ae (dataset, ts, indexes_json, blobs_json, doubles_json) VALUES (?, ?, ?, ?, ?)").run(
          ds,
          Date.now(),
          JSON.stringify(msg.indexes ?? []),
          JSON.stringify(msg.blobs ?? []),
          JSON.stringify(msg.doubles ?? []),
        );
        return { ok: true };
      }
      case "ae.query": {
        // Sproutboat extension: Cloudflare AE is write-only from a Worker (you
        // query it via the SQL API). Exposed here so a dashboard can read back.
        const ds = requireAe(msg.dataset);
        const limit = Math.min(Math.max(Number(msg.limit) || 20, 1), 200);
        const rows = db
          .query<{ ts: number; indexes_json: string; blobs_json: string; doubles_json: string }, [string, number]>(
            "SELECT ts, indexes_json, blobs_json, doubles_json FROM ae WHERE dataset = ? ORDER BY ts DESC, rowid DESC LIMIT ?",
          )
          .all(ds, limit);
        const total = db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM ae WHERE dataset = ?").get(ds);
        return {
          ok: true,
          count: total?.n ?? 0,
          rows: rows.map((r) => ({
            timestamp: r.ts,
            indexes: parseJsonValue(r.indexes_json),
            blobs: parseJsonValue(r.blobs_json),
            doubles: parseJsonValue(r.doubles_json),
          })),
        };
      }

      case "do.storage.get": {
        const cls = requireDoClass(msg.cls);
        const row = db
          .query<{ value: string }, [string, string, string]>(
            "SELECT value FROM do_storage WHERE cls = ? AND id = ? AND key = ?",
          )
          .get(cls, str(msg.id), str(msg.key));
        return row ? { ok: true, found: true, value: row.value } : { ok: true, found: false };
      }
      case "do.storage.put":
        db.query(
          "INSERT INTO do_storage (cls, id, key, value) VALUES (?1,?2,?3,?4) " +
            "ON CONFLICT (cls, id, key) DO UPDATE SET value = ?4",
        ).run(requireDoClass(msg.cls), str(msg.id), str(msg.key), str(msg.value));
        return { ok: true };
      case "do.storage.delete": {
        const r = db
          .query("DELETE FROM do_storage WHERE cls = ? AND id = ? AND key = ?")
          .run(requireDoClass(msg.cls), str(msg.id), str(msg.key));
        return { ok: true, deleted: r.changes > 0 };
      }
      case "do.storage.delete_all":
        db.query("DELETE FROM do_storage WHERE cls = ? AND id = ?").run(requireDoClass(msg.cls), str(msg.id));
        return { ok: true };
      case "do.storage.list": {
        const cls = requireDoClass(msg.cls);
        const limit = Math.min(Math.max(Number(msg.limit) || 1000, 1), 10000);
        const rows = db
          .query<{ key: string; value: string }, [string, string, string, number]>(
            "SELECT key, value FROM do_storage WHERE cls = ? AND id = ? AND key LIKE ? || '%' ORDER BY key LIMIT ?",
          )
          .all(cls, str(msg.id), str(msg.prefix), limit);
        return { ok: true, entries: rows.map((r) => [r.key, r.value]) };
      }

      // #125 — alarms. `at` is epoch ms; setting one replaces any pending alarm
      // for that object, and attempts resets because this is a fresh schedule.
      case "do.alarm.set":
        db.query(
          "INSERT INTO do_alarm (cls, id, at, attempts) VALUES (?1,?2,?3,0) " +
            "ON CONFLICT (cls, id) DO UPDATE SET at = ?3, attempts = 0",
        ).run(requireDoClass(msg.cls), str(msg.id), Math.trunc(Number(msg.at) || 0));
        return { ok: true };
      case "do.alarm.get": {
        const row = db
          .query<{ at: number }, [string, string]>("SELECT at FROM do_alarm WHERE cls = ? AND id = ?")
          .get(requireDoClass(msg.cls), str(msg.id));
        return { ok: true, at: row ? row.at : null };
      }
      case "do.alarm.delete": {
        const r = db.query("DELETE FROM do_alarm WHERE cls = ? AND id = ?").run(requireDoClass(msg.cls), str(msg.id));
        return { ok: true, deleted: r.changes > 0 };
      }

      case "assets.get": {
        if (!bindings.assets) throw new Error("assets not bound");
        const reqPath = str(msg.path) || "/";
        const key = resolveAssetKey(reqPath, (k) => !!assetManifest?.files[k]);
        const hit = key ? readAsset(key) : null;
        if (hit)
          return {
            ok: true,
            found: true,
            status: 200,
            type: hit.type,
            hash: hit.hash,
            body: new TextDecoder().decode(hit.body),
          };
        const nfh = assetManifest?.notFound ?? "none";
        if (nfh === "single-page-application") {
          const shell = readAsset("/index.html");
          if (shell)
            return {
              ok: true,
              found: true,
              status: 200,
              type: shell.type,
              hash: shell.hash,
              body: new TextDecoder().decode(shell.body),
            };
        }
        if (nfh === "404-page") {
          const page = readAsset("/404.html");
          if (page)
            return {
              ok: true,
              found: false,
              status: 404,
              type: page.type,
              body: new TextDecoder().decode(page.body),
            };
        }
        return { ok: true, found: false, status: 404, body: "Not Found" };
      }

      default:
        throw new Error(`unknown op: ${str(msg.op)}`);
    }
  }

  /**
   * #63 — the ops that carry bytes rather than escaping them into the frame.
   * Everything else goes through `dispatch` untouched.
   */
  async function dispatchBinary(msg: Frame, binary: Uint8Array): Promise<{ reply: Frame; bytes?: Uint8Array }> {
    if (msg.op === "r2.put") {
      // The body arrived as bytes; store it as a blob rather than a string, so
      // a put costs one copy instead of an escape, a parse and a re-encode.
      const { store, part: bucket } = storeFor("r2", requireR2(msg.bucket));
      const etag = createHash("sha256").update(binary).digest("hex");
      const uploaded = new Date().toISOString();
      store
        .query(
          "INSERT INTO r2 (bucket, key, body, size, etag, uploaded, http_json, custom_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) " +
            "ON CONFLICT (bucket, key) DO UPDATE SET body=?3, size=?4, etag=?5, uploaded=?6, http_json=?7, custom_json=?8",
        )
        .run(
          bucket,
          str(msg.key),
          binary,
          binary.byteLength,
          etag,
          uploaded,
          JSON.stringify(msg.httpMetadata ?? {}),
          JSON.stringify(msg.customMetadata ?? {}),
        );
      return {
        reply: { ok: true, object: { key: str(msg.key), size: binary.byteLength, etag, uploaded } },
      };
    }

    if (msg.op === "r2.get") {
      const { store, part: bucket } = storeFor("r2", requireR2(msg.bucket));
      const row = store
        .query<R2Row, [string, string]>("SELECT * FROM r2 WHERE bucket = ? AND key = ?")
        .get(bucket, str(msg.key));
      if (!row) return { reply: { ok: true, found: false } };
      return { reply: { ok: true, found: true, object: r2Row(row) }, bytes: r2Bytes(row.body) };
    }

    if (msg.op === "assets.get") {
      if (!bindings.assets) throw new Error("assets not bound");
      const reqPath = str(msg.path) || "/";
      const key = resolveAssetKey(reqPath, (candidate) => !!assetManifest?.files[candidate]);
      let hit = key ? readAsset(key) : null;
      let found = Boolean(hit);
      let status = hit ? 200 : 404;
      if (!hit && assetManifest?.notFound === "single-page-application") {
        hit = readAsset("/index.html");
        found = Boolean(hit);
        status = hit ? 200 : 404;
      } else if (!hit && assetManifest?.notFound === "404-page") {
        hit = readAsset("/404.html");
      }
      if (!hit) return { reply: { ok: true, found: false, status: 404 }, bytes: new TextEncoder().encode("Not Found") };
      return {
        reply: { ok: true, found, status, type: hit.type, hash: hit.hash },
        bytes: hit.body,
      };
    }

    return { reply: await dispatchOnce(msg) };
  }

  /** One wire frame in, one out. See `handleFrame` on the Broker type. */
  async function handleFrame(payload: Buffer): Promise<Buffer> {
    if (payload.length === 0 || payload[0] !== FRAME_V1) {
      return encodeFrame(await handlePayload(payload.toString("utf8")));
    }
    try {
      const jsonLen = payload.readUInt32LE(1);
      const msg = jsonObject(parseJsonValue(payload.subarray(5, 5 + jsonLen).toString("utf8")));
      if (!msg) throw new Error("request frame was not a JSON object");
      if (token && str(msg.token) !== token) return frameOf(encodeV1({ ok: false, error: "unauthorized" }));
      const binary = new Uint8Array(payload.subarray(5 + jsonLen));
      const { reply, bytes } = await dispatchBinary(msg, binary);
      return frameOf(encodeV1(reply, bytes));
    } catch (e) {
      return frameOf(encodeV1({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    }
  }

  /**
   * #63 §3 — ops that must not be applied twice.
   *
   * The transport retries the same bytes when a connection dies, and a broker
   * that already applied a request but never got its reply out would otherwise
   * apply it again: a second queue message, a second INSERT. Reads are absent
   * deliberately — replaying a `d1.query` costs nothing and caching its reply
   * could hold megabytes.
   */
  const REPLAYABLE = new Set([
    "kv.put",
    "kv.delete",
    "queue.send",
    "queue.send_batch",
    "d1.query",
    "d1.exec",
    "d1.batch",
    "d1.backup",
    "ratelimit.check",
    "r2.put",
    "r2.delete",
    "do.storage.put",
    "do.storage.delete",
    "do.storage.delete_all",
    "do.alarm.set",
    "do.alarm.delete",
    "ae.write",
  ]);

  /** How many recent replies to keep. A resend follows its original within
   *  milliseconds, so this only has to outlive a reconnect, not a session. */
  const REPLAY_WINDOW = 256;

  /**
   * Run `msg`, or replay what it answered last time. Keyed by the id the sprout
   * put on the request; a request without one is always run.
   */
  async function dispatchOnce(msg: Frame): Promise<Frame> {
    const id = isSafeInteger(msg.id) ? msg.id : null;
    const op = str(msg.op);
    if (id === null || !REPLAYABLE.has(op)) return dispatch(msg);
    const key = `${op}:${id}`;
    const seen = replayed.get(key);
    if (seen) return seen;
    const reply = await dispatch(msg);
    replayed.set(key, reply);
    // Insertion-ordered, so the oldest key is the first one out.
    if (replayed.size > REPLAY_WINDOW) {
      const oldest = replayed.keys().next().value;
      if (oldest !== undefined) replayed.delete(oldest);
    }
    return reply;
  }

  async function handlePayload(payload: string): Promise<Frame> {
    const nl = payload.indexOf("\n");
    const gotToken = nl === -1 ? "" : payload.slice(0, nl);
    const json = nl === -1 ? payload : payload.slice(nl + 1);
    if (token && gotToken !== token) return { ok: false, error: "unauthorized" };
    try {
      const msg = jsonObject(parseJsonValue(json));
      if (!msg) throw new Error("request frame was not a JSON object");
      return await dispatchOnce(msg);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // --- cron + queue delivery (only when this broker knows its sprout) --------
  const timers: ReturnType<typeof setInterval>[] = [];
  const dispatchEnabled = () => opts.dispatchEnabled?.() ?? true;
  const QUEUE_BATCH = 10;
  const QUEUE_MAX_ATTEMPTS = 5;

  async function deliverTrigger(kind: "scheduled" | "queue" | "alarm", body: JsonObject): Promise<Response | null> {
    if (!opts.sproutUrl || !dispatchEnabled()) return null;
    try {
      return await doFetch(opts.sproutUrl, {
        method: "POST",
        headers: { "x-sb-trigger": kind, "x-sb-token": token, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      return null;
    }
  }

  function drainQueuesOnce(): void {
    if (!opts.sproutUrl || !dispatchEnabled() || bindings.queues.length === 0) return;
    const now = Date.now();
    for (const binding of bindings.queues) {
      // `store`/`part` route the rows to this queue's backing file (#74); the
      // trigger payload still carries the binding name the sprout matches on.
      const { store, part } = storeFor("queue", binding);
      const rows = store
        .query<{ id: string; body: string; attempts: number }, [string, number, number]>(
          "SELECT id, body, attempts FROM mq WHERE queue = ? AND dead = 0 AND visible_at <= ? ORDER BY visible_at LIMIT ?",
        )
        .all(part, now, QUEUE_BATCH);
      if (rows.length === 0) continue;
      // hide the batch so the next tick doesn't re-deliver it while in flight
      const hideUntil = now + 30_000;
      const hide = store.query("UPDATE mq SET visible_at = ? WHERE id = ?");
      for (const r of rows) hide.run(hideUntil, r.id);

      void deliverTrigger("queue", {
        queue: binding,
        messages: rows.map((r) => ({ id: r.id, body: r.body, timestamp: now, attempts: r.attempts + 1 })),
      }).then(async (res) => {
        let ack: string[] = rows.map((r) => r.id); // default: ack all if the sprout did not say
        let retry: string[] = [];
        if (res && res.ok) {
          try {
            const parsed = jsonObject(parseJsonValue(await res.text()));
            const ids = (value: JsonValue | undefined) => (Array.isArray(value) ? value.filter(isString) : null);
            ack = (parsed && ids(parsed.ack)) ?? ack;
            retry = (parsed && ids(parsed.retry)) ?? [];
          } catch {
            /* keep defaults */
          }
        } else {
          ack = [];
          retry = rows.map((r) => r.id); // delivery failed → retry all
        }
        const del = store.query("DELETE FROM mq WHERE id = ?");
        for (const id of ack) del.run(id);
        const bump = store.query(
          "UPDATE mq SET attempts = attempts + 1, visible_at = ?, dead = CASE WHEN attempts + 1 >= ? THEN 1 ELSE 0 END WHERE id = ?",
        );
        for (const id of retry) bump.run(Date.now() + 5_000, QUEUE_MAX_ATTEMPTS, id);
      });
    }
  }

  const ALARM_MAX_ATTEMPTS = 5;

  /**
   * #125 — fire alarms that are due.
   *
   * Claim-then-deliver, not deliver-then-delete: `alarm()` is allowed to call
   * `setAlarm()` for its next run, and that write lands *during* delivery. If
   * we deleted afterwards we would erase the alarm the handler just scheduled,
   * which is how a self-rescheduling object silently stops. Deleting first
   * means the handler's row is a fresh insert nothing else touches.
   *
   * A failed delivery re-arms with the queue consumer's policy — 5s apart, five
   * attempts — and `DO NOTHING` so a re-arm never overwrites an alarm the
   * handler set itself.
   */
  function fireAlarmsOnce(): void {
    if (!opts.sproutUrl || !dispatchEnabled() || bindings.do.length === 0) return;
    const now = Date.now();
    const due = db
      .query<{ cls: string; id: string; at: number; attempts: number }, [number]>(
        "SELECT cls, id, at, attempts FROM do_alarm WHERE at <= ? ORDER BY at LIMIT 10",
      )
      .all(now);
    if (due.length === 0) return;
    const claim = db.query("DELETE FROM do_alarm WHERE cls = ? AND id = ?");
    const rearm = db.query(
      "INSERT INTO do_alarm (cls, id, at, attempts) VALUES (?1,?2,?3,?4) ON CONFLICT (cls, id) DO NOTHING",
    );
    for (const row of due) {
      claim.run(row.cls, row.id);
      void deliverTrigger("alarm", { cls: row.cls, id: row.id, scheduledTime: row.at }).then((res) => {
        if (res && res.ok) return;
        const attempts = row.attempts + 1;
        if (attempts >= ALARM_MAX_ATTEMPTS) return; // give up rather than spin forever
        rearm.run(row.cls, row.id, Date.now() + 5_000, attempts);
      });
    }
  }

  if (opts.sproutUrl) {
    if (bindings.queues.length > 0) timers.push(setInterval(drainQueuesOnce, 500));
    if (bindings.do.length > 0) timers.push(setInterval(fireAlarmsOnce, 500));
    if (bindings.crons.length > 0) {
      let lastTick = "";
      timers.push(
        setInterval(() => {
          if (!dispatchEnabled()) return;
          const now = new Date();
          const stamp = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}-${now.getUTCMinutes()}`;
          if (stamp === lastTick) return; // once per minute
          lastTick = stamp;
          for (const expr of bindings.crons) {
            if (cronMatches(expr, now)) void deliverTrigger("scheduled", { cron: expr, scheduledTime: now.getTime() });
          }
        }, 15_000),
      );
    }
  }

  return {
    dispatch,
    handlePayload,
    handleFrame,
    close: () => {
      for (const t of timers) clearInterval(t);
      for (const conn of d1Conns.values()) conn.close();
      for (const conn of resourceDbs.values()) conn.close();
      db.close();
    },
  };
}

/**
 * Minimal 5-field cron match (`min hour dom month dow`, UTC). Each field is a
 * comma list of: `*`, a step `*` + `/n`, a range `a-b`, or a plain number.
 */
export function cronMatches(expr: string, when: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const fields = [
    when.getUTCMinutes(),
    when.getUTCHours(),
    when.getUTCDate(),
    when.getUTCMonth() + 1,
    when.getUTCDay(),
  ];
  const inField = (spec: string, value: number): boolean =>
    spec.split(",").some((token) => {
      if (token === "*") return true;
      const step = token.startsWith("*/") ? Number(token.slice(2)) : null;
      if (step) return value % step === 0;
      const range = token.split("-");
      if (range.length === 2) return value >= Number(range[0]) && value <= Number(range[1]);
      return Number(token) === value;
    });
  return parts.every((spec, i) => inField(spec, fields[i]));
}

export function encodeFrame(obj: Frame): Buffer {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

/** The bound TCP listener: the port actually assigned, and its shutdown handle. */
export type BrokerServer = { port: number; stop(): void };

/** Start the TCP listener. Returns the bound port. */
export function listen(broker: Broker, hostname: string, port: number): BrokerServer {
  // Chunks are held in a list and joined once, when a whole frame has arrived.
  // Concatenating on every chunk copies the accumulated buffer each time, which
  // is quadratic in the body size: an 8 MB object arriving in 64 KB pieces
  // copied hundreds of megabytes before anything was parsed.
  const server = Bun.listen<{ chunks: Buffer[]; size: number }>({
    hostname,
    port,
    socket: {
      open(socket) {
        socket.data = { chunks: [], size: 0 };
      },
      async data(socket, chunk) {
        const state = socket.data;
        state.chunks.push(chunk);
        state.size += chunk.length;
        for (;;) {
          if (state.size < 4) return;
          if (state.chunks.length > 1) {
            state.chunks = [Buffer.concat(state.chunks, state.size)];
          }
          const buf = state.chunks[0];
          const len = buf.readUInt32LE(0);
          if (len > MAX_FRAME) {
            socket.write(encodeFrame({ ok: false, error: "frame too large" }));
            socket.end();
            return;
          }
          if (state.size < 4 + len) return;
          // Kept as bytes: a v1 frame carries binary after its JSON, and
          // decoding the whole payload as utf8 would corrupt it.
          const payload = buf.subarray(4, 4 + len);
          const rest = buf.subarray(4 + len);
          state.chunks = rest.length ? [Buffer.from(rest)] : [];
          state.size = rest.length;
          socket.write(await broker.handleFrame(payload));
        }
      },
    },
  });
  return { port: server.port, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      token: { type: "string" },
      db: { type: "string" },
      "data-dir": { type: "string" },
      "resource-dir": { type: "string" },
      bindings: { type: "string" },
      secrets: { type: "string" },
      "sprout-url": { type: "string" },
      "assets-dir": { type: "string" },
      "edge-url": { type: "string" },
      services: { type: "string" },
      "dispatch-disabled": { type: "boolean" },
    },
  });
  // SAFETY: --bindings and --secrets are the artifact's own bindings.json /
  // secrets.json, written by `sproutboat build` and handed to us by the supervisor.
  const bindings: Partial<Bindings> | undefined = values.bindings
    ? (JSON.parse(readFileSync(values.bindings, "utf8")) as Partial<Bindings>)
    : undefined;
  // SAFETY: as above — secrets.json is a flat name->value map written by the build.
  const secrets: Record<string, string> | undefined = values.secrets
    ? (JSON.parse(readFileSync(values.secrets, "utf8")) as Record<string, string>)
    : undefined;
  // #48 — binding -> hostname, resolved by the control plane at activation and
  // passed as JSON. Malformed input disables service calls rather than taking
  // the broker down: every other binding still works.
  let services: Record<string, string> | undefined;
  if (values.services) {
    try {
      const parsed = jsonObject(parseJsonValue(values.services));
      if (parsed) {
        services = Object.fromEntries(
          Object.entries(parsed).flatMap(([binding, host]) => (isString(host) ? [[binding, host] as const] : [])),
        );
      }
    } catch {
      console.error("sproutboat broker: --services is not valid JSON; service bindings disabled");
    }
  }
  // Candidate brokers must be able to listen before they claim timers. The
  // supervisor promotes one only after the edge points at it, using a local
  // signal instead of a network-visible control endpoint.
  let dispatchEnabled = !values["dispatch-disabled"];
  process.on("SIGUSR1", () => {
    dispatchEnabled = true;
  });
  process.on("SIGUSR2", () => {
    dispatchEnabled = false;
  });
  const broker = createBroker({
    db: values.db,
    dataDir: values["data-dir"],
    resourceDir: values["resource-dir"],
    token: values.token ?? process.env.SB_BROKER_TOKEN,
    bindings,
    secrets,
    sproutUrl: values["sprout-url"] ?? process.env.SB_SPROUT_URL,
    assetsDir: values["assets-dir"],
    edgeUrl: values["edge-url"],
    services,
    dispatchEnabled: () => dispatchEnabled,
  });
  const { port } = listen(broker, "127.0.0.1", Number(values.port ?? process.env.SB_BROKER_PORT ?? 0));
  console.log(
    `sproutboat broker: 127.0.0.1:${port} db=${values.db ?? ":memory:"} sprout=${values["sprout-url"] ?? process.env.SB_SPROUT_URL ?? "(none)"} dispatch=${dispatchEnabled ? "enabled" : "disabled"}`,
  );
}
