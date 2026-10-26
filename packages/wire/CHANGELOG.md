# @sproutboat/wire

## 0.20.1

### Patch Changes

- Updated dependencies [90434e0]
  - @sproutboat/runtime@0.33.0

## 0.20.0

### Minor Changes

- 482a55c: Queues like Cloudflare's, from compatibility date 2026-10-31, with queue names and consumer
  settings in `sproutboat.jsonc` at every date.
  
  - **Config (`@sproutboat/config`):** a `queues` entry may be `{ "binding": "QUEUE", "queue": "q",
    "max_batch_size": 10, "max_batch_timeout": 1, "max_retries": 3, "retry_delay": 0,
    "dead_letter_queue": "dlq" }`, the settings named as in wrangler's `queues.consumers`; `id`
    is optional there. `queueSettings()` normalizes the entries for the build, and `pinBindingId`
    adds an id to such an object.
  - **Names and settings, at every date (opt-in):** `batch.queue` is the queue's name (the binding
    name when unset). `max_batch_size` (1 to 100, default 10) and `max_batch_timeout` (0 to 60 s,
    default 0: delivered at once, where Cloudflare waits up to 5 s) shape batches; `max_retries`,
    `retry_delay` and `dead_letter_queue` decide what a retry does. A dead letter queue the worker
    doesn't bind keeps its messages until one does.
  - **From 2026-10-31:**
    - `send()` and `sendBatch()` return Promises of `{ metadata: { metrics } }`, the queue's backlog
      after the send as Cloudflare documents it (miniflare answers zeros); `metrics()` is added.
    - Bodies keep their content type: `json` (the default), `text`, `bytes` (arrives as an
      ArrayBuffer) and `v8` (structured clone). A string that looks like JSON or a number arrives as
      the same string.
    - workerd's argument errors: an undefined or BigInt `json` body, a `text` body that isn't a
      string, an unknown content type, a body over 128 KiB, an empty batch, more than 100 messages
      or 256 KiB in a batch, a batch that isn't iterable.
    - A message is `{ id, timestamp, body, attempts }`, `timestamp` a Date of when it was sent, with
      `ack()` and `retry({ delaySeconds })` on its prototype; a batch has `queue`, `messages` and
      `metadata`, with `ackAll()` and `retryAll({ delaySeconds })`. The first of `ack()` and `retry()`
      wins, and a message's own call wins over `ackAll()`/`retryAll()`, as Cloudflare documents
      (miniflare lets a later `retryAll()` win).
    - By default a message is retried at once, 3 times, then dropped or sent to the dead letter
      queue. Earlier dates keep 5 s between attempts and 5 attempts.
  - **Stores (embedded transport and `@sproutboat/wire`'s broker):** messages keep their send time
    (an additive `sent_at` column), `queue.send` answers the backlog when asked, `queue.metrics` is
    new, and a batch's outcome may carry retry delays and messages for the dead letter queue. An
    older broker ignores those and retries as before; bodies sent from 2026-10-31 are tagged text, so
    they travel through it unchanged.

### Patch Changes

- Updated dependencies [482a55c]
  - @sproutboat/runtime@0.32.0

## 0.19.1

### Patch Changes

- Updated dependencies [a04d0aa]
  - @sproutboat/runtime@0.31.0

## 0.19.0

### Minor Changes

- 140f0f7: Durable Objects `ctx.storage.sql` from compatibility date `2026-10-29`, on every
  transport. Each object gets its own SQLite database.
  
  - `exec(query, ...bindings)` runs one statement and returns a cursor with `toArray()`,
    `one()`, `raw()`, `next()`, iteration, `columnNames`, `rowsRead` and `rowsWritten`.
  - BLOBs come back as ArrayBuffers.
  - Foreign keys are enforced.
  - `BEGIN`, `SAVEPOINT` and the other transaction statements throw workerd's error. Use
    `storage.transactionSync(fn)`, which rolls back if `fn` throws.
  - `sql.databaseSize` gives the database's size in bytes.
  - Errors read as in workerd, for example `near "SELEKT": syntax error at offset 0:
    SQLITE_ERROR`.
  
  Every Durable Object class gets `sql`, since `sproutboat.jsonc` has no
  `new_sqlite_classes`. The key-value API keeps its own store.
  
  Where the databases live:
  - **Standalone executables and sproutd:** in `<data>/do-sql/CLASS/ID.sqlite`. At most 8
    stay open, and the one used longest ago closes for the next one.
  - **Broker (wire):** new op `do.sql`. With `doDb`, the databases sit in
    `<doDb without .sqlite>.do-sql/` next to it, so they survive a redeploy and stay
    separate per project. Without a SQL pool, the broker keeps at most 64 open
    (`createD1Store`'s new `maxOpen`).

### Patch Changes

- Updated dependencies [9167b44]
- Updated dependencies [140f0f7]
  - @sproutboat/runtime@0.30.0

## 0.18.0

### Minor Changes

- 8df17ef: Durable Objects like workerd from compatibility date `2026-10-28`:
  
  - **Input gate.** While an object's storage read is in flight, no other event
    (`stub.fetch()`, an alarm) enters it, so `const v = await storage.get("n"); await
    storage.put("n", v + 1)` is safe under concurrent calls. Ten concurrent increments used
    to end at 1. An event that awaits anything else (a fetch, a timer) lets the next one
    in, as in workerd. `blockConcurrencyWhile()` and `transaction()` hold the gate until
    they settle, and `stub.fetch()` always returns a Promise.
  - **Storage returns Promises** (`get`, `put`, `delete`, `deleteAll`, `list`, the alarm
    methods), and adds `sync()` and `transaction()` (with `txn.rollback()`; a throw rolls
    back; a transaction reads its own writes).
  - **Structured values.** Date, Map, Set, RegExp, ArrayBuffer and typed arrays, BigInt,
    `undefined` inside containers, NaN, the infinities and -0 round-trip.
    `put(k, undefined)` throws a TypeError and a function throws a DataCloneError, before
    anything is written.
  - `list()` takes `start`, `startAfter`, `end` and `reverse`, and `limit: 0` throws.
    `setAlarm()` refuses a value that is not a Date or a number. `deleteAll()` also drops
    the alarm.
  
  Earlier dates keep synchronous JSON storage and no gate. Values written from
  `2026-10-28` start with `#sb1:`, and every date reads both formats.
  
  Both transports' `do.storage.list` take `start`, `startAfter`, `end` and `reverse`, and
  match the prefix exactly (SQL `LIKE` also matched `_` and `%` as wildcards, ignoring
  case, so a prefix such as `user_` listed other keys).

### Patch Changes

- Updated dependencies [8df17ef]
- Updated dependencies [8df17ef]
  - @sproutboat/runtime@0.29.0

## 0.17.0

### Minor Changes

- 829ed12: Request bodies stream, from compatibility date `2026-10-27`, as in workerd:
  
  - **Ingress.** The native server runs the handler as soon as a request's headers arrive. `request.body` hands out the bytes as they come in, and the server pauses the socket while more than 1 MiB waits unread, so a large upload read through the stream keeps memory flat (a 128 MiB upload peaks at 38 MiB RSS). `text()`, `json()`, `arrayBuffer()` and `bytes()` read the whole body and return Promises.
  - **Limit.** `SB_REQUEST_BODY_MAX` defaults to 100 MiB for streamed bodies (it stays 1 MiB before the date, where the body is held in memory whole). A larger `Content-Length` gets `413 Payload Too Large` before the handler runs; a chunked body that grows past it closes the connection, and the handler's stream fails.
  - **Service bindings and `fetch()`.** On the broker transport, a `ReadableStream` request body goes out as it is read, in `FRAME_V1_MORE` frames after the request's head, instead of being read to the end first. The broker feeds them to the upstream request as a stream (with backpressure) and says so in its `ping` reply (`bodyStream: true`); against an older broker, bodies are sent whole as before. A streamed body can't follow a 307 or 308 redirect.
  
  Internal trigger and RPC calls keep buffered bodies. Before `2026-10-27` nothing changes: the handler gets the whole body at once and `request.text()` answers synchronously, which a deployed handler may rely on, hence the new date.

### Patch Changes

- Updated dependencies [829ed12]
  - @sproutboat/runtime@0.28.0

## 0.16.0

### Minor Changes

- 9be9c74: R2 matches workerd from compatibility date `2026-10-26`:
  
  - `get`, `put`, `head`, `delete`, `list` and `createMultipartUpload` return Promises, and errors reject them.
  - An object's `etag` is the MD5 of its bytes, with `checksums.md5`. Objects written before keep their old etag.
  - Objects have `uploaded` as a `Date`, `version`, `storageClass`, `range` and `writeHttpMetadata(headers)`. A body has `body` (a `ReadableStream`), `bodyUsed`, `text()`, `json()`, `arrayBuffer()` and `blob()`.
  - `get(key, { range, onlyIf })` takes `{ offset, length }`, `{ suffix }` or a `Range` header, and `etagMatches`, `etagDoesNotMatch`, `uploadedBefore`, `uploadedAfter` or `If-*` headers. When the condition fails it returns the object without a body.
  - `put(key, value, { onlyIf, httpMetadata })` takes a `ReadableStream` or a `Blob`, and `httpMetadata` as `Headers`. When the condition fails it returns `null`.
  - `delete([keys])` deletes several keys.
  - `list({ prefix, limit, cursor, delimiter, include })` pages at up to 1,000 entries, groups keys into `delimitedPrefixes`, and returns `httpMetadata` and `customMetadata` only when `include` asks for them.
  - A value of the wrong type and a key longer than 1,024 bytes fail with R2's errors.
  
  Earlier dates keep the synchronous shim. One change applies at every date: **a `list()` prefix now matches exactly.** It used SQL `LIKE`, so it ignored case and read `_` and `%` as wildcards. Both transports store an object's MD5 in a new column, added to existing stores when they open.
  
  Against miniflare 4.20260730, `conformance/bindings/r2.js` in sproutd passes 48/48 at `2026-10-26` (16/48 before).

### Patch Changes

- Updated dependencies [9be9c74]
  - @sproutboat/runtime@0.27.0

## 0.15.0

### Minor Changes

- 9b15539: KV matches workerd from compatibility date `2026-10-25`:
  
  - `get`, `getWithMetadata`, `put`, `delete` and `list` return Promises, and errors reject them.
  - `get(key, type)` takes `"text"`, `"json"`, `"arrayBuffer"` and `"stream"`, and `get([keys])` returns a `Map`.
  - `getWithMetadata(key, type)` returns `{ value, metadata, cacheStatus }`.
  - `put(key, value, { expiration, expirationTtl, metadata })` takes strings, bytes and `ReadableStream`s, and stores the metadata.
  - `list({ prefix, limit, cursor })` returns `{ keys: [{ name, expiration?, metadata? }], list_complete, cursor?, cacheStatus }` and pages at up to 1,000 keys.
  - Keys, values, expirations, metadata and list limits fail with KV's own errors. For example: `Key name cannot be empty.`, `KV PUT failed: 414 UTF-8 encoded length of 513 exceeds key length limit of 512.`, `KV PUT failed: 400 Invalid expiration_ttl of 30. Expiration TTL must be at least 60.`, and `KV PUT failed: 413 Metadata length of 1110 exceeds limit of 1024.`
  
  Earlier dates keep the synchronous shim. Two changes apply at every date:
  
  - **A `list()` prefix now matches exactly.** It used SQL `LIKE`, so it ignored case and read `_` and `%` as wildcards. For example, the prefix `a_` also listed `ab`, and `a` also listed `AB`.
  - **Both transports store KV metadata in a new column.** It's added to existing stores when they open.

### Patch Changes

- Updated dependencies [9b15539]
- Updated dependencies [1c36119]
- Updated dependencies [3cad1f0]
  - @sproutboat/runtime@0.26.0

## 0.14.6

### Patch Changes

- Updated dependencies [ef40955]
- Updated dependencies [95f6bd7]
  - @sproutboat/runtime@0.25.0

## 0.14.5

### Patch Changes

- 9a5363e: D1 matches workerd from compatibility date `2026-10-24`:
  
  - `all()`, `run()`, `first()`, `raw()`, `batch()` and `exec()` return Promises, and errors reject them. `bind()` stays synchronous and still throws `D1_TYPE_ERROR` at once.
  - `meta` has D1's keys: `served_by`, `duration`, `changes`, `last_row_id`, `changed_db`, `size_after` (always 0 here), `rows_read` and `rows_written`.
  - `raw({ columnNames: true })` puts the column names first, and keeps duplicate names.
  - `first("name")` throws `D1_COLUMN_NOTFOUND` for a column the result doesn't have.
  - Empty SQL and an empty `batch([])` throw `D1_ERROR: No SQL statements detected.`
  - `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT` and `RELEASE` are refused, as in D1. A batch is already one transaction.
  - `exec()` runs line by line, all or nothing, and returns the number of lines. A failing line throws `D1_EXEC_ERROR: Error in line N: ...`.
  - `withSession()` returns a session with `prepare`, `batch` and `getBookmark()`, which returns `null`. `dump()` rejects; use `backup()` instead.
  
  Apps with an earlier `compatibility_date` keep the synchronous API unchanged. To opt in, move the date to `2026-10-24` or later and rebuild. `await` code needs no other change, but code that reads results without `await` does.
  
  Not yet like D1: `rows_read` counts the rows returned, not the rows scanned, and pragmas are not limited to D1's allow-list.
  
  With LTX capture on (from `2026-10-22`), a capture failure during a D1 call now reports `SQLITE_IOERR` with a message saying the write is not durable in the replication log, instead of SQLite's "not an error". Writes stay refused until restart.
- Updated dependencies [9a5363e]
  - @sproutboat/runtime@0.24.0

## 0.14.4

### Patch Changes

- 7a7fd34: D1 correctness fixes, in the standalone (embedded) transport and the broker:
  
  - **Bytes are no longer lost.** Binding a `Uint8Array`, another typed array, a `DataView` or an `ArrayBuffer` stored NULL in a standalone sprout, along with every parameter after it. It now stores a BLOB, at every compatibility date. On earlier dates a BLOB still reads back as before: as one character per byte.
  - **`batch()` is one transaction** in a standalone sprout, as it already was through the broker and is in D1: if a statement fails, the ones before it are rolled back. This applies at every compatibility date.
  - **From compatibility date `2026-10-24`**, D1 follows workerd's rules:
    - a parameter must be `null`, a number, a string, a boolean or bytes, or the call throws `D1_TYPE_ERROR` (before, `undefined` and objects became NULL);
    - the number of parameters must match the statement (`D1_ERROR: Wrong number of parameter bindings for SQL query.`);
    - foreign keys are enforced (`PRAGMA foreign_keys = ON`);
    - errors read `D1_ERROR: <message>: SQLITE_<CODE>`;
    - a BLOB reads back as an array of byte values.
  
    Apps with an earlier `compatibility_date` keep the old behaviour. To opt in, move the date to `2026-10-24` or later and rebuild.
  - `meta.changes` is 0 for a statement that only reads. It used to repeat the previous write's count.
- Updated dependencies [7a7fd34]
  - @sproutboat/runtime@0.23.1

## 0.14.3

### Patch Changes

- Updated dependencies [df612fc]
  - @sproutboat/runtime@0.23.0

## 0.14.2

### Patch Changes

- Updated dependencies [3f95234]
  - @sproutboat/runtime@0.22.0

## 0.14.1

### Patch Changes

- Updated dependencies [581c2f4]
- Updated dependencies [6f253b9]
  - @sproutboat/runtime@0.21.0

## 0.14.0

### Minor Changes

- f2d2b72: Service-binding calls behave as in workerd in two more ways, on a platform edge that vouches for them:
  
  - **The callee sees the caller's URL.** `request.url` is the URL the caller passed (`https://peer/path`), where it used to be the callee deployment's own hostname.
  - **A callee that throws makes the caller throw.** The caller's `fetch()` rejects with the callee's error, keeping its class for standard errors and its message, where it used to get a plain 500 response.
  
  How the platform vouches for a call:
  
  1. The broker sends each service call with the edge's secret (`SB_EDGE_SECRET`, which the edge gives only to brokers) and the caller's URL.
  2. The edge forwards the call to the callee with that sprout's own token (`SB_EDGE_TOKEN`).
  3. The callee trusts a call only when the token matches.
  
  A client can forge none of this. The edge removes its headers from every other request, and the error marker never reaches a client.
  
  A vouched call also no longer shows the broker's loopback address as `x-sb-remote-addr`. The edge's internal headers are removed before any handler sees a request.
  
  In `@sproutboat/wire`, the broker reads `SB_EDGE_SECRET` and takes an `edgeSecret` option.
- b287117: `fetch()` and service bindings honour an abort signal, set as `init.signal` or a `Request`'s `signal`:
  
  - A signal that is already aborted rejects the call at once.
  - Aborting it later, by hand or through `AbortSignal.timeout()`, rejects the pending call with the signal's reason.
  
  In a deployed sprout the abort also stops the work. The sprout closes the call's broker connection, the broker aborts its upstream request when a sprout's connection closes, and the platform's edge stops the callee's request in turn. Before, an abandoned call ran to the end anyway.
  
  In sproutd the request still runs to the end, and its late reply is dropped.
  
  In `@sproutboat/wire`, `Broker.handleFrame` takes an optional `AbortSignal`, which the broker server aborts when the connection closes.
- 3798994: Responses to `fetch()` and service-binding calls stream. In a deployed sprout with compatibility date `2026-10-21` or later, the call resolves as soon as the status and headers arrive. `response.body` is then a `ReadableStream` that receives each chunk as the upstream sends it.
  
  Before, the whole body had to arrive first. A response streamed over several seconds, such as server-sent events or a long download, reached the caller only at the end.
  
  The 32 MiB `SB_FETCH_MAX_BYTES` cap still applies to the total. Cancelling the body, or aborting the call's signal, stops the upstream request.
  
  In `@sproutboat/wire`:
  - the broker streams a `fetch` or `service.fetch` that asks for it (`stream: true`), sending the head and each chunk as `FRAME_V1_MORE` frames through the new `emit` argument of `handleFrame`;
  - the final frame ends the response;
  - a request that doesn't ask is answered whole, as before.

### Patch Changes

- Updated dependencies [85aa74d]
- Updated dependencies [f2d2b72]
- Updated dependencies [b287117]
- Updated dependencies [9773e45]
- Updated dependencies [3798994]
  - @sproutboat/runtime@0.20.0

## 0.13.2

### Patch Changes

- Updated dependencies [4274bef]
  - @sproutboat/runtime@0.19.0

## 0.13.1

### Patch Changes

- Updated dependencies [116ee47]
- Updated dependencies [145e3dc]
- Updated dependencies [2541458]
  - @sproutboat/runtime@0.18.0

## 0.13.0

### Minor Changes

- 6880f60: Add an opt-in bounded multi-session broker worker with private supervisor control.
  Fence queue acknowledgements to durable delivery claims and retain recoverable alarm deliveries across process crashes in broker and embedded transports.
  
  Resume native R2 downloads until completion or renewed backpressure instead of leaving large responses stalled.
  
  Retain partially written TCP replies until drain and serialize pipelined replies so large broker-backed R2 reads cannot truncate or interleave frames.
  
  Honor wildcard, weak and list-based If-None-Match conditions on broker direct downloads.
  
  Move D1 queries, batches, exec and backups off the shared broker event loop into two lazy SQL threads per broker process. Preserve database affinity, transaction rollback and session isolation, and bound queued work with per-session admission and queue deadlines. Running SQLite statements remain non-preemptible; keep shared mode opt-in.
  
  Enforce shared D1 execution budgets through a capability-protected native SQLite progress hook. Interrupted batches roll back and lanes remain usable. A broker watchdog revokes all sessions if native work cannot be interrupted; uncertain SQL outcomes are never automatically retried. Build the small SQLite extension during host/image preparation.
- a96a443: Apply static asset redirects and header rules in dev and standalone asset bindings, preserving binary response bodies.

### Patch Changes

- Updated dependencies [5d4d40b]
- Updated dependencies [6880f60]
- Updated dependencies [846519f]
- Updated dependencies [b47aad4]
- Updated dependencies [f19ca0d]
- Updated dependencies [ddb0f9d]
- Updated dependencies [f201b58]
- Updated dependencies [08d0192]
- Updated dependencies [6d6ae43]
- Updated dependencies [9fdf3fa]
- Updated dependencies [4c78d83]
- Updated dependencies [088cad0]
- Updated dependencies [a96a443]
- Updated dependencies [6e42051]
- Updated dependencies [6e88627]
- Updated dependencies [9dc109d]
- Updated dependencies [28b0c39]
- Updated dependencies [6b64985]
- Updated dependencies [eec94f1]
  - @sproutboat/runtime@0.17.0

## 0.12.2

### Patch Changes

- Updated dependencies [14546a0]
  - @sproutboat/runtime@0.16.0

## 0.12.1

### Patch Changes

- Updated dependencies
  - @sproutboat/runtime@0.15.0

## 0.12.0

### Minor Changes

- 9e9638d: An egress service for `fetch()` (baronunread/sproutboat#252). `@sproutboat/wire/egress` runs as its own process (`SB_EGRESS_TOKEN=... bun egress.ts --port 8070`), listens on loopback, requires a token on every call, and performs the vetted fetch itself. A broker given `SB_EGRESS_URL` and `SB_EGRESS_TOKEN` sends `fetch()` through it instead of connecting directly, so on a host where the broker's own unit has no network, sprouts can still reach the internet. The address checks and `SB_EGRESS_ALLOW` behave the same in both modes; refusals read the same; compressed bodies and redirects come back as a direct fetch would see them.
  
  `fetch()` also moves on to the next resolved address when one can't be connected to, such as an IPv6 answer on a host with no IPv6 route. It only does so on failures where nothing was sent.

## 0.11.0

### Minor Changes

- 4dd16b7: `fetch()` reaches any public address and never a private or reserved one (baronunread/sproutboat#174). The `outbound` allowlist is gone.
  
  - Both backends, the broker and the standalone client, check the address they resolved, not the hostname, so DNS rebinding can't get past the check. The broker connects to the vetted address and verifies TLS against the name.
  - Blocked: loopback, RFC 1918, link-local and cloud metadata, CGNAT, benchmarking, documentation, multicast and reserved ranges, IPv6 ULA and link-local, and the IPv4 address inside IPv4-mapped, NAT64 and 6to4 addresses.
  - An operator can let addresses through with `SB_EGRESS_ALLOW` (`*` or exact addresses) in the broker's or the binary's environment. Handler code can't.
  - `@sproutboat/runtime`: `URL.hostname` and `URL.port` handle IPv6 literals (`[::1]:9` used to give hostname `[`). Every sprout gets `fetch()`, with no binding needed. `validateHttpSyncSource` no longer takes an `outboundAllowed` argument, and `Bindings` loses `outbound`.
  - `@sproutboat/wire`: `Bindings` loses `outbound`.
  - `@sproutboat/config`: `outbound` is accepted but ignored, with a warning in the new `warnings` field of a successful parse (`OUTBOUND_IGNORED`). It will be refused in a later minor release.

### Patch Changes

- Updated dependencies [4dd16b7]
  - @sproutboat/runtime@0.14.0

## 0.10.0

### Minor Changes

- 276fd90: New `doDb` option and `--do-db` flag: Durable Object storage and alarms can live in their own SQLite file instead of the per-deployment database (baronunread/sproutboat#207). The platform points it at a per-project file so an object's state survives redeploys, as on Workers. Without it, behaviour is unchanged.

## 0.9.3

### Patch Changes

- 5dba469: Binary data survives KV and outbound `fetch()` bodies (baronunread/sproutboat#233, and the request half of #232).
  - **KV:** `put()` of an `ArrayBuffer` or any typed array stores its bytes, flagged binary, instead of `String(view)` (`"0,1,2,..."`). `get(key, type | { type })` supports `"text"`, `"json"` and `"arrayBuffer"` as in Workers: a binary value read as text decodes as UTF-8, and a text value read as `arrayBuffer` is its UTF-8 encoding. `"stream"` throws a clear error. Existing stores gain the `binary` column on first use.
  - **`fetch()` and service-binding request bodies:** an `ArrayBuffer` or view is sent as its exact bytes in both transports, instead of `"0,1,2,..."`. The standalone HTTP client also stopped truncating bodies at the first NUL byte.

## 0.9.2

### Patch Changes

- 733bd9e: Outbound `fetch()` and service-binding responses keep binary bodies intact (baronunread/sproutboat#232). `arrayBuffer()` and `bytes()` on a fetched response used to go through Porffor's `text()`, which the runtime overrides to decode UTF-8, so binary bodies collapsed; they now read the raw bytes. Through the broker, `fetch` and `service.fetch` sent over a v1 frame now get the upstream body as raw bytes in the frame's binary section instead of `TextDecoder` output. v0 frames, which already-deployed sprouts use, are unchanged, and a new sprout talking to an older broker falls back to the previous text behaviour.

## 0.9.1

### Patch Changes

- ed9640a: Point Porffor patch diagnostics, runtime comments, and historical notes to the
  shared upstream notes in the Sproutboat platform repository.

## 0.9.0

### Minor Changes

- 4a7fe62: Cache API: `caches.default` / `caches.open(name)` (baronunread/sproutboat#59), with `match()`/`put()`/`delete()` backed by both transports (broker's `cache.*` ops and the standalone embedded transport, so behavior matches whichever way the app deploys). Keyed on method+URL for v1 (no `Vary` support yet). `put()` throws for a non-GET request, matching the spec; a 206 status or an explicit `no-store`/`private` `Cache-Control` is a silent no-op rather than an error, matching Workers' own `caches.default`. TTL derives from `s-maxage` (preferred) or `max-age`; entries with neither have no expiry.
  
  Deliberately synchronous, not Promise-returning: every other buffered-body method this runtime already ships (`text()`/`json()`/`arrayBuffer()`/`blob()`/`formData()`) is sync too, and this runtime's own coroutine machinery has a known, still-open memory-corruption issue tied specifically to nested `async function` calls accumulating across many requests (baronunread/sproutboat#168) — no reason to add more async surface here. `await caches.default.match(...)` still reads correctly: awaiting a non-promise value resolves to it immediately.

### Patch Changes

- Updated dependencies [6145afe]
  - @sproutboat/assets@0.3.0

## 0.8.0

### Minor Changes

- 7287d9b: KV: native key expiration (baronunread/sproutboat#58). `env.KV.put(key, value, { expirationTtl })` / `{ expiration }` now match the Cloudflare Workers contract: `expirationTtl` is seconds from now (rejected below 60, matching CF), `expiration` is an absolute unix-seconds timestamp. An expired key reads as absent from `get()` and is omitted from `list()`; the row is hard-deleted lazily the next time it's touched by a get. No new transport op — both `expirationTtl` and `expiration` are optional fields on the existing `kv.put` frame, so an older broker/prelude pair that ignores them keeps working exactly as before.

## 0.7.0

### Minor Changes

- 493e4e3: Add short-lived R2 direct-transfer tickets for broker-backed sprouts. A
  loopback HTTP listener streams PUT bodies to file-backed R2 storage, and serves
  GET and HEAD requests with single-range support without placing object bytes
  in a binding frame.
  
  Tickets are random bearer capabilities with a byte limit, expiry, one-use
  claim, and optional SHA-256 verification. Native standalone direct transfers
  remain unavailable until the native HTTP ingress can stream request bodies.
  
  For broker deployments, ticket issuance now reserves account-level capacity
  across every R2 resource. Reservations survive redeploys, expired and orphaned
  temporary uploads are reclaimed, and the broker retains a configurable free
  disk floor with capacity and rejected-transfer counters for the dashboard.
- 5acb93c: Add Cloudflare-shaped resumable R2 multipart uploads. Parts are persisted
  independently, and standalone completion assembles the final object through a
  fixed 64 KiB native buffer to keep memory bounded by part size rather than total
  object size.
  
  Unfinished multipart uploads expire after seven days and their persisted part
  files are removed automatically.
  
  Store completed objects as immutable blob generations so a failed overwrite
  cannot expose new bytes under the previous metadata.

## 0.6.0

### Minor Changes

- 6998a15: R2 object bytes no longer live inside SQLite, on either transport (baronunread/sproutboat#56). Every `put()` used to bind the whole object into a `body` column, and every `get()` read it back out — doubling the object through SQLite's own page cache/WAL machinery on top of the buffer it already arrived in, which was the real driver of #56's "large uploads make memory skyrocket" complaint (the JSON-escaping half of that was already fixed in #63).
  
  Objects now live in their own file under `r2-blobs/`, named by a hash of bucket+key (so unicode keys and directory traversal are non-issues):
  
  - **Embedded (standalone):** `<data-dir>/r2-blobs/` — `sb_r2_put_c`/`sb_r2_get_c` write/read the file directly via C `fopen`/`fwrite`/`fread`, no SQLite blob column at all. `sb_r2_delete_blob` removes the file on delete.
  - **Broker:** colocated with whichever store file already holds that bucket's metadata — the main `db` for a bare-string binding, the resource's own file under `resourceDir` for an account-level one (#74) — so blobs persist across a redeploy exactly when that metadata does. `:memory:` stores (tests, local dev) fall back to an in-memory map.
  
  No migration: this is a schema change for new writes going forward, not a converter for objects already stored inline from before.
  
  Verified end-to-end against both transports (kitchen-sink's full conformance suite, 24/24 standalone + 27/27 broker) and with new unit tests for file-backed persistence, the `:memory:` fallback, and a real binary round-trip over the v1 wire protocol.
  
  **Known limitation found while verifying this, not fixed here:** a binary `put()` body (bytes ≥ 0x80) is corrupted on the way *in*, before it ever reaches storage: `porf_native_fetch_read_value` (the function every inline-C string read in the runtime goes through) always UTF-8-encodes a Latin-1-range string on read, which is correct for genuine text but wrong for opaque bytes coming off a raw HTTP body. This predates this change (the old SQLite-blob path had the identical corruption) and is not something the storage backend can fix. It needs an input-side counterpart to `#176`'s `x-sb-raw-body` marker, or real `ArrayBuffer`/`Uint8Array` body support (the upstream ask was filed as Porffor #386 and later retracted; see `https://github.com/baronunread/sproutboat/blob/main/patches/upstream/request-body-report-386.md`).

## 0.5.0

### Minor Changes

- Rate limiter (baronunread/sproutboat#69): `env.<NAME>.limit({ key })` now
  returns `{ success, resetAt }`. `resetAt` is epoch milliseconds for when the
  fixed window rolls and the counter clears, returned on every call (hit or
  miss), so a rejection can carry an accurate `Retry-After`:
  `Math.ceil((resetAt - Date.now()) / 1000)`. The `ratelimit.check` op already
  had `windowStart` and `period` in hand; it just stopped discarding them.
  Additive: existing callers reading only `success` are unaffected.

## 0.4.0

### Minor Changes

- Rate Limiting binding (baronunread/sproutboat#69): `env.<NAME>.limit({ key }) ->
  { success }`.
  
  - Config: `ratelimiters: [{ binding, limit, period }]` in `sproutboat.jsonc` —
    at most `limit` calls per `period` seconds, per key.
  - A fixed-window counter (`ratelimit` table) on **both** transports: the
    embedded one for standalone binaries, and the broker (`ratelimit.check` op,
    in the replay-dedup set) for deployed sprouts. `limit` / `period` travel in
    the message so the op stays stateless.
  - `ponytail`: fixed window, so a burst across the boundary can briefly reach
    ~2x; swap for a two-window weighted count if that matters.

## 0.3.0

### Minor Changes

- Standalone runtime: client IP, D1 online backup, and a prepared-statement cache.
  
  - `request.cf.clientIp` is populated from the connection's remote address
    (`x-sb-remote-addr`, appended by the server and stripped from client input),
    with `SB_TRUSTED_PROXIES` resolving `X-Forwarded-For` behind a reverse proxy.
    IPv4-mapped IPv6 peers are folded to dotted form. (baronunread/sproutboat#163)
  - `env.<D1>.backup(name?)` — a Sproutboat extension: an online, integrity-checked
    single-file snapshot via `VACUUM INTO`, on both the embedded and broker
    transports. New `d1.backup` op. (baronunread/sproutboat#164)
  - The embedded transport caches prepared statements per database (FIFO, 32/db)
    instead of recompiling the SQL on every binding op. (baronunread/sproutboat#155)

## 0.2.0

### Minor Changes

- c45098e: Adopt broker, JSON utilities, assets, wrapper, source validation, both transports and the prelude from sproutboat-cli (moved verbatim). First publishable versions; consumed via `file:` links until the npm publish flow lands.

### Patch Changes

- Updated dependencies [c45098e]
  - @sproutboat/assets@0.2.0
