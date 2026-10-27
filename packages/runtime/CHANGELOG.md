# @sproutboat/runtime

## 0.34.2

### Patch Changes

- a0ba6a3: Faster requests: about 57% of a request's CPU was Porffor's `globalThis` getter.
  
  - **Toolchain, the root cause.** Porffor's `#get_globalThis` re-synced every top-level function and `var` of the module into the global object on every read, one hashed write per binding (about 20 µs with the prelude's ~120 bindings, so every `globalThis.x` in user code paid it too). Every binding is now written when the object is built, and a later read rewrites only the bindings whose value changed (a packed copy of the last value written is kept per binding: an unchanged binding costs one compare). 20,000 reads with 600 top-level functions: 9,300 ms before, a few ms after.
  - **Runtime and toolchain, the request path.** The runtime's `globalThis.__sbCompat` / `globalThis.env` reads go through accessors over module-level `let`s that the app tail sets once, and `Request`/`Response` cache the class lookups and take the date and WebSocketPair state from statics the runtime sets. Until the tail has run (the shared template, unit tests) everything reads `globalThis` as before.
  - **Client IP.** `request.cf` no longer reads and splits `SB_TRUSTED_PROXIES` four times a request: it is read once per process, and with no trusted proxy (the usual case) the peer is the client and the forwarded-header lookups are skipped.
  - **`x-sb-cpu-ms`.** The stamp is appended to the handler's own Response instead of building a second Response with a copy of every header. The same responses are stamped, with the same headers and body.
  
  A 404 on one pinned x86 core, CPU per request when saturated, standalone: 319 µs before, 127 µs with the getter patch alone, 113 µs with the request-path change, 81 µs with the client-IP and stamp changes.

## 0.34.1

### Patch Changes

- e62b72d: An unhandled promise rejection no longer ends the process. A D1 call that failed and was never awaited (`db.prepare("INSERT ...").run()` that broke a foreign key) threw its error out of Porffor's promise job loop into the host's "Uncaught ..." exit, taking every in-flight request down even with a try/catch around the call. As on Workers it is now reported: a log line (`Uncaught (in promise) ...`) and an `unhandledrejection` event (`PromiseRejectionEvent` with `promise` and `reason`) on the global scope when `addEventListener("unhandledrejection", ...)` has a listener, and the process and other requests carry on. This applies at every compatibility date, because a crash is a bug rather than a behaviour an app can depend on. The toolchain's `patchUnhandledRejections` calls the runtime's `globalThis.__sbOnUnhandledRejection`; plain Porffor without it keeps the throw. Applies to every binding call that returns a rejecting Promise (D1, KV, R2, Durable Objects, Queues, fetch). An un-awaited `async function` that throws is reported the same way (it used to be dropped silently): the C runtime that rejects it now hands the promise to the same check.

## 0.34.0

### Minor Changes

- 85ec3fe: WebSockets on every host, and outbound WebSockets, from compatibility date `2026-11-01`:
  
  - **Client sockets on standalone and platform sprouts.** The native server (toolchain) carries the client end of a 101 response: it upgrades the connection, passes text and binary messages both ways, applies the 1 MiB read window, caps messages at 32 MiB (1009), and answers a close with the code and reason. A message the app sent before the 101 goes out right after it, and the app's `Sec-WebSocket-Protocol` is the one the client gets. Before 2026-11-01 these sprouts still answer a 101 with 501 (sproutd, which sets `sb_ws_hook` itself, carries them from 2026-10-30). The toolchain needs `@sproutboat/runtime` 0.33 or later.
  - **Outbound WebSockets.** `new WebSocket(url, protocols)` (CONNECTING, then `open`, as in a browser) and `fetch(url, { headers: { Upgrade: "websocket" } })`, whose Response carries the connected socket as `response.webSocket` (call `accept()`); a server that answers the upgrade with another status is the Response. `ws`, `wss`, `http` and `https` URLs. Returning that Response from a handler relays the client's socket to the upstream. One I/O thread per socket (up to 64) connects through the egress policy, does TLS with BearSSL, and wakes the loop through the async pipe (sproutd) or the server's waker (standalone). On the embedded transport (standalone, sproutd); the broker transport (platform, `sproutboat dev`) answers `fetch` upgrades with a rejection for now.
  - `validateHttpSyncSource(source, compatibilityDate)` accepts `WebSocket(` from 2026-11-01 and keeps refusing it before.
  - **Hibernation, on a host that keeps client sockets open while the worker is gone (sproutd).** A Durable Object's hibernatable socket (`ctx.acceptWebSocket`) is recorded in storage scoped to the object (its id, tags, attachment, and the object's auto-response, kept current by `serializeAttachment` and `setWebSocketAutoResponse`), so the host may stop the worker while the socket is idle. When a message or close arrives, a new worker constructs the object again with `ctx.getWebSockets()` listing its sockets (tags and attachments intact) from the start of the constructor, and the event runs as `webSocketMessage` or `webSocketClose`. Socket ids are random. A host without this (standalone, platform) keeps every socket resident, as before.

## 0.33.0

### Minor Changes

- 90434e0: WebSockets, from compatibility date `2026-10-30`, as in workerd:
  
  - **`WebSocketPair` and `WebSocket`.** `accept()`, `send()` (text, `ArrayBuffer` or a typed array), `close(code, reason)`, `readyState`, `binaryType` (binary messages are `Blob`s unless it is `"arraybuffer"`, workerd's standard binary type), `addEventListener` and `on<type>`. Messages sent before the other end accepts wait for it; each message is delivered in its own turn, so a reply reaches the other end before the next message, as in workerd. A close is answered automatically; invalid close codes throw `InvalidAccessError`, reasons over 123 bytes `SyntaxError`. Checked against workerd 1.20260730 (`test/native-websockets.ts`).
  - **`new Response(null, { status: 101, webSocket })`** and `response.webSocket` (`null` when there is none). Any other status with a `webSocket` throws `RangeError`, as in workerd.
  - **Durable Objects: the hibernation API.** `ctx.acceptWebSocket(ws, tags)`, `getWebSockets(tag)`, `getTags(ws)`, `setWebSocketAutoResponse` / `getWebSocketAutoResponse` with `WebSocketRequestResponsePair`, `serializeAttachment` / `deserializeAttachment`, and the `webSocketMessage` / `webSocketClose` handlers, run through the object's input gate.
  - **Client sockets.** The client end of a 101 response becomes a real socket on a host that carries it (sproutd, which sets the runtime's `sb_ws_hook`). A standalone or platform sprout answers such a response with `501` for now; a pair whose ends both stay in the worker (a Worker and its Durable Object) works everywhere.
  
  Before `2026-10-30` nothing is defined and `response.webSocket` stays `undefined`.

## 0.32.0

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

## 0.31.0

### Minor Changes

- a04d0aa: Background work on sproutd (sproutd B22), and cron-only Workers everywhere:
  
  - A Worker may export only `scheduled()` or `queue()`, with no `fetch()`, as on workerd
    (Cloudflare's `cron-trigger` example used to be refused at build). An HTTP request to such
    a Worker answers 500 and logs workerd's "Handler does not export a fetch() function.".
  - A Worker whose only binding-like setting is `triggers.crons` now runs its crons in a
    standalone executable; before, the local triggers started only when another binding existed.
  - The embedded transport's cron runs `scheduled()` with `env` from compatibility date
    2026-09-28, like the broker path, and logs a throw instead of leaving it unhandled. Queue
    consumers and `scheduled()` may be `WorkerEntrypoint` methods.
  - When the worker host takes notes (sproutd's bridge sets `sb_host_note_hook`; nothing else
    does), the embedded transport starts no trigger timers. It reports its crons, and when queued
    messages and Durable Object alarms fall due, and the host delivers them with an
    `x-sb-trigger: scheduled` or `due` request, waking a reaped app for them. Standalone and
    platform sprouts behave as before.

## 0.30.0

### Minor Changes

- 9167b44: Durable Objects like workerd from compatibility date `2026-10-29`:
  
  - **RPC on stubs.** In a class that extends `DurableObject` (from `cloudflare:workers`),
    any method can be called as `await stub.method(args)`. Arguments and results are
    copied as structured clone does (the 2026-10-28 storage codec: Date, Map, Set,
    BigInt, `Uint8Array`, `undefined` in containers and so on), and a function argument
    becomes a callback the object can call. The call goes through the object's input
    gate like `fetch()`. An exception in the method rejects the caller's Promise with the
    same error. A getter is read with `await stub.prop`. A method the class does not
    define rejects with workerd's TypeError, and a Symbol argument with a DataCloneError.
    `this.ctx` and `this.env` are set on the instance.
  - **Ids are 64 hex digits**, with `equals()` and, from `idFromName`, `name`.
    `idFromName` is deterministic and differs per class. `idFromString` throws a
    TypeError for anything other than 64 hex digits and for an id made by another
    namespace. `newUniqueId()` is random.
  - `namespace.getByName(name)`, `namespace.jurisdiction()`, and `stub.id` and `stub.name`.
  - **An exception in the object rejects `stub.fetch()`** with that error, as in workerd.
    It used to resolve to a 500 response.
  
  No data is lost by moving an app to `2026-10-29`. The storage and the alarm of an object
  named under an earlier date (`name:NAME`) move to its 64-hex id the first time a process
  creates the object. `idFromString` still accepts the `name:` and `uid:` strings that
  earlier dates gave out.
  
  At `2026-10-28` too, a Symbol given to Durable Object storage is named in its DataCloneError
  (`Symbol(s) could not be cloned.`) instead of `value`.
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

## 0.29.1

### Patch Changes

- 65f03ae: Cold standalone builds are fast again. Runtime 0.29.0's Durable Object storage codec named
  eight typed-array constructors, which linked each builtin into every app and added about
  7 s (45%) to an uncached build (16 s to 23 s for a one-line app on an M-series Mac). The
  CLI's native-restore test passed its 600 s CI timeout.
  
  From compatibility date `2026-10-28`, Durable Object storage round-trips `Uint8Array`,
  `DataView` and `ArrayBuffer`. Any other typed array now throws a DataCloneError in
  `put()` instead of being stored: keep its bytes in a `Uint8Array`. Before this change
  they came back with the wrong type. Earlier dates are unchanged.

## 0.29.0

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

- 8df17ef: Queues fixes at every compatibility date (data loss, so not gated):
  
  - On the embedded transport (standalone sprouts and sproutd), `sendBatch()` stored every
    body as the text `"[object Object]"`. It now stores the body it was given, and both
    `send()` and `sendBatch()` honour `delaySeconds` there, as the broker already did.
  - A consumer whose `queue()` throws now retries every message it had not explicitly
    acked or retried, as on Workers. The embedded transport used to ack the whole batch,
    so a failing consumer lost its messages. Explicit `ack()` / `ackAll()` calls made
    before the throw still count (Cloudflare's documented behaviour; miniflare retries
    those too).
  
  From compatibility date `2026-10-28`, `sendBatch(messages, { delaySeconds })` delays
  every message whose own `delaySeconds` is unset or 0. Earlier dates ignore the batch
  option.

## 0.28.0

### Minor Changes

- 829ed12: Request bodies stream, from compatibility date `2026-10-27`, as in workerd:
  
  - **Ingress.** The native server runs the handler as soon as a request's headers arrive. `request.body` hands out the bytes as they come in, and the server pauses the socket while more than 1 MiB waits unread, so a large upload read through the stream keeps memory flat (a 128 MiB upload peaks at 38 MiB RSS). `text()`, `json()`, `arrayBuffer()` and `bytes()` read the whole body and return Promises.
  - **Limit.** `SB_REQUEST_BODY_MAX` defaults to 100 MiB for streamed bodies (it stays 1 MiB before the date, where the body is held in memory whole). A larger `Content-Length` gets `413 Payload Too Large` before the handler runs; a chunked body that grows past it closes the connection, and the handler's stream fails.
  - **Service bindings and `fetch()`.** On the broker transport, a `ReadableStream` request body goes out as it is read, in `FRAME_V1_MORE` frames after the request's head, instead of being read to the end first. The broker feeds them to the upstream request as a stream (with backpressure) and says so in its `ping` reply (`bodyStream: true`); against an older broker, bodies are sent whole as before. A streamed body can't follow a 307 or 308 redirect.
  
  Internal trigger and RPC calls keep buffered bodies. Before `2026-10-27` nothing changes: the handler gets the whole body at once and `request.text()` answers synchronously, which a deployed handler may rely on, hence the new date.

## 0.27.1

### Patch Changes

- 0d2d079: Bodies of megabytes no longer take hundreds of megabytes of memory (sproutd #22). Converting bytes to text and text to bytes made one string per character, so reading a 5 MiB R2 object with `text()` peaked at about 400 MiB, and R2 multipart uploads with real (5 MiB) parts ran sproutd's workers out of memory. The conversions now run in one C pass and give exactly the same results. On a standalone build, at 5 MiB:
  
  | | before | after |
  |---|---|---|
  | `put()` of a string | 82 MiB | 16 MiB |
  | `put()` then `get()` and `text()` | 400 MiB | 26 MiB |
  | multipart upload, then `get()` and `text()` | 396 MiB | 21 MiB |
  | `request.text()` of the request body | 402 MiB | 24 MiB |
  
  Also:
  
  - At every date, `uploadPart()` stores an `ArrayBuffer` or a typed array as its bytes. It stored the text `[object ArrayBuffer]`.
  - From `2026-10-26`, `uploadPart()` takes what `put()` takes (a `ReadableStream` or a `Blob` too), and stores text as its UTF-8 bytes, as in workerd. It stored text whose characters all fit in one byte as Latin-1.
  - From `2026-10-26`, an R2 object body's `body` stream is made when first read, and a whole-object `get()` keeps one copy of the bytes, not two.

## 0.27.0

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

## 0.26.0

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

- 1c36119: Create the LTX page-index scratch file inside the database's replication spool
  instead of libc's global temporary directory, fixing capture initialization when
  a worker's filesystem sandbox permits writes only beneath its own state directory.
  The scratch file is private and immediately unlinked. If a kill lands before
  unlink, the next capture-lock owner removes the stale regular index file before
  recovery. After unlink, closing the writer or killing the process releases it.
  Its anonymous transient disk use is not counted by the
  directory-walk quota. Capture retains its existing explicit opt-in and compatibility
  date of 2026-10-22; capture-off apps and earlier dates keep their existing behavior.
- 3cad1f0: The storage quota counts a D1 database's WAL file, which can hold space the app has already freed. While the app is over its quota, the runtime now checkpoints and truncates each D1 database's WAL before measuring again, at most once a second. So `DELETE` then `VACUUM` is enough to get back under the quota, and the app no longer has to run a checkpoint itself. Databases under LTX capture are left alone: capture owns their checkpoints, and they stay frozen until the quota is raised or other data is deleted.

## 0.25.0

### Minor Changes

- ef40955: The storage quota is a hard bound when LTX capture is on. A D1 database under capture can't be capped by pinning its page count: a same-size `UPDATE`, or a `DELETE`, still adds a file to the replication spool, and the spool counts toward the app's quota. So while the app is over its quota, every write to a captured database is refused with `D1_ERROR: storage quota exceeded: writes are refused while this app's data, including its replication log, is over its quota: SQLITE_FULL`. That covers `exec()` and `batch()` too.
  
  - Reads, read-only batches and transaction control still run.
  - No LTX file is ever dropped to make room: the policy fails closed.
  - Writes resume once the app is under its quota again, at the next rescan: for example after the operator raises the quota, or the app deletes R2 or KV data. The freeze holds across a restart.
  
  This freezes statements after the quota scan; it is not a hard filesystem cap. The write that crosses the quota is accepted.
  
  Databases without capture are unchanged: they are pinned at their size, so deletes still work.
- 95f6bd7: A storage quota for standalone sprouts and sproutd. An app's data directory (KV, D1, R2, Durable Object storage, queues) holds at most `SB_STORAGE_MAX_BYTES` bytes; sproutd sets it per app, and it defaults to 10 GiB. Each D1 database is also capped at 10 GB, as in D1. Past the quota:
  
  - writes fail with an error that says so, such as `KV put() failed: storage quota exceeded (this app stores N bytes; the limit is M)`, or `D1_ERROR: database or disk is full: SQLITE_FULL` for D1;
  - reads and deletes keep working, so an app can make room (for D1, `DELETE` and then `VACUUM`).
  
  This is a check after a scan, not a hard filesystem cap with zero overshoot. The size is measured at most once a second, by walking the directory, and a write is checked against the last measurement. The write that crosses the limit is accepted (an R2 object, say), and so is anything else written within that second. Writes after it are refused.

## 0.24.0

### Minor Changes

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

## 0.23.1

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

## 0.23.0

### Minor Changes

- df612fc: `fetch(Request)`, `fetch(Request, init)` and `new Request(request, init)` behave as in workerd from compatibility date `2026-10-23`. This covers outgoing `fetch()`, service-binding `fetch()` and Durable Object stubs, on the broker and embedded transports alike. Every behaviour was checked against workerd 2026-09-27 by the platform's service-binding suite.
  
  From `2026-10-23`:
  
  - `fetch(input, init)` is `fetch(new Request(input, init))`, as the Fetch spec says. The Request's method, headers, body, redirect mode and signal apply unless `init` replaces them, and `init.headers` replaces all of the Request's headers.
  - A Request given as `init` brings its method, headers and body.
  - A body can be used once. `fetch(request)`, `new Request(request)` and reading it through `request.body` all use it, after which `bodyUsed` is true. Sending or copying a used Request throws `TypeError: Cannot reconstruct a Request with a used body.`, and reading it again throws workerd's "Body has already been used..." message. With a body in `init`, the source Request is left alone.
  - A GET or HEAD Request with any body throws, even `""` or one inherited from another Request. An incoming GET or HEAD has `request.body === null`.
  - Methods are workerd's: known names in any case are uppercased, and anything else throws `Invalid HTTP method string`. That includes `CONNECT` and custom names.
  - `redirect` must be `"follow"` or `"manual"`. As in workerd, `"error"` throws when the Request is made.
  - The headers of an incoming request, a fetched or service-binding response, and `Response.redirect()` are immutable: `set`, `append` and `delete` throw `TypeError: Can't modify immutable headers.` Copies are mutable, so `new Request(request)`, `new Response(body, response)` and `new Headers(h)` can still be changed.
  - `AbortSignal.abort()`'s default reason reads "The operation was aborted", as in workerd.
  
  With an earlier `compatibility_date` these keep their old behaviour: a copy shares the body, any method name and redirect mode passes, and headers stay mutable. To get the new behaviour, move `compatibility_date` to `2026-10-23` and rebuild.
  
  These are fixed at every date, since no app can depend on the old behaviour:
  
  - `Request.signal` exists. A Request made with `signal` passes it on to copies and to `fetch()`, which aborts with it.
  - A `ReadableStream` body in an outgoing `fetch()` is sent as its bytes. Before, it went out as the text `[object ReadableStream]`.
  - `request.clone()` and `response.clone()` tee a stream body, so both copies can read it. Before, the second reader failed.
  - A copy of an incoming request keeps its raw bytes. Its `text()` decodes UTF-8, and `fetch()` sends the bytes unchanged.

## 0.22.0

### Minor Changes

- 3f95234: Add experimental bounded local LTX replication to the embedded SQLite transport.
  Opt in with compatibility date 2026-10-22 and SB_LTX_ENABLE=1. A single writer
  owns the database, commits are captured durably before checkpoint, and the WAL
  has an enforced byte ceiling. Default behavior and the broker are unchanged.
  Verified clean-checkpoint restarts reuse their generation without rewriting a base.
  
  Developed with AI assistance from OpenAI Codex (GPT-6.1).

## 0.21.1

### Patch Changes

- 98800ca: The asynchronous `fetch()` and service-binding behaviour from 0.20.0 now starts at compatibility date `2026-10-22`. Before, it applied at every date, which broke apps that use the result without `await`, such as the CLI's kitchen-sink: `const r = fetch(url); r.body`.
  
  From `2026-10-22`, in a deployed sprout:
  
  - `fetch()` and `env.SERVICE.fetch()` return promises and run off the event loop;
  - responses stream;
  - redirects are followed;
  - a callee's error is thrown in the caller;
  - a callee sees its caller's URL.
  
  With an earlier `compatibility_date`, a deployed sprout's `fetch()` and binding calls answer at once with a `Response`, as they did before 0.20.0. To get the new behaviour, move `compatibility_date` to `2026-10-22` and rebuild.
  
  These stay ungated:
  
  - sproutd answered with promises at every date, and still does;
  - RPC calls are always asynchronous;
  - abort signals, `Set-Cookie` and `Content-Type` work at every date.

## 0.21.0

### Minor Changes

- 6f253b9: Service bindings support Workers RPC.
  
  **Callee.** A deployment whose default export extends `WorkerEntrypoint`, imported from `cloudflare:workers`, exposes its methods:
  
  - `env.SERVICE.add(2, 3)` runs `add(2, 3)` on a fresh instance, with `this.env` and `this.ctx` set, and resolves to its result.
  - Arguments and results are copied as structured clone does: `undefined`, `NaN`, `-0`, `Date`, `RegExp`, binary data, `Map`, `Set` and errors survive the trip.
  - An error the method throws rejects the call with the same class and message.
  - An unknown method rejects with workerd's `TypeError`.
  - Passing functions or RPC stubs is not supported yet.
  
  **Where it works.** RPC travels over the service-binding calls a platform edge vouches for, so no client can invoke a method.
  
  **Imports.** `cloudflare:workers` provides `WorkerEntrypoint`, `DurableObject`, `RpcTarget` and `env`. The runtime turns the import into globals, so a handler that imports it runs both bundled and as plain ESM.
  
  **Default exports.**
  - A class default export is instantiated per request, for `fetch`, `scheduled` and `queue`.
  - A `WorkerEntrypoint` may have no `fetch` at all.

### Patch Changes

- 581c2f4: `atob()` and `btoa()` give the right result for any string. They used Porffor's own implementations, which read how a string is stored, so they went wrong on strings held as UTF-16, such as ones from `JSON.parse` or `TextDecoder`:
  
  - `atob(JSON.parse('"AQL/"'))` returned two wrong bytes instead of `01 02 ff`;
  - `btoa` of a parsed `"héllo"` encoded the UTF-16 storage.
  
  Both are now plain JavaScript, with the same validation and errors as before.

## 0.20.0

### Minor Changes

- 85aa74d: Service-binding calls and outbound `fetch()` no longer block a deployed sprout. In a deployed sprout, each call runs off the event loop on one I/O thread, so the sprout keeps answering other requests while a call is in flight. Concurrent calls overlap: eight 500 ms calls finish in about 510 ms, where they used to queue for about 4 s. A deployment can also call itself through a binding, to any depth, where this used to deadlock. The toolchain installs the loop hook the runtime uses for this; with an older runtime it does nothing.
  
  `env.SERVICE.fetch()` now always returns a promise, as in Workers, and reads its arguments as `fetch()` does:
  
  - a `URL` object works as input;
  - `fetch(request, init)` keeps the request's body when `init` sets no body of its own;
  - a `ReadableStream` body is sent whole, where it used to arrive as the text `[object ReadableStream]`.
  
  Responses from bindings and from `fetch()` keep every `Set-Cookie` header, where they used to keep only the last one.
  
  A broker exchange is now resent only when the broker cannot have acted on it: the request never fully left, or the connection had gone stale. A `fetch` or service call that the broker may already have run is no longer repeated.
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
- 9773e45: From compatibility date `2026-10-22`, `fetch()` and service bindings follow redirects as Fetch does:
  
  - Under `redirect: "follow"`, the default, the request goes again to the new location, up to 20 times. Each outbound hop is checked against the egress rules like the first.
  - A 303 turns the request into a GET with no body, and so does a 301 or 302 that answers a POST.
  - A hop to another origin drops `Authorization`.
  - A service binding follows through the same binding, as in workerd.
  - `redirect: "error"` rejects with a `TypeError`.
  - `redirect: "manual"` returns the 3xx as it is.
  
  Before this date, a 3xx came back to the handler whatever the mode, and still does for apps with an earlier `compatibility_date`.
  
  A response from `fetch()` or a service binding that has no `Content-Type` no longer gains `text/plain;charset=UTF-8`.
- 3798994: Responses to `fetch()` and service-binding calls stream. In a deployed sprout with compatibility date `2026-10-21` or later, the call resolves as soon as the status and headers arrive. `response.body` is then a `ReadableStream` that receives each chunk as the upstream sends it.
  
  Before, the whole body had to arrive first. A response streamed over several seconds, such as server-sent events or a long download, reached the caller only at the end.
  
  The 32 MiB `SB_FETCH_MAX_BYTES` cap still applies to the total. Cancelling the body, or aborting the call's signal, stops the upstream request.
  
  In `@sproutboat/wire`:
  - the broker streams a `fetch` or `service.fetch` that asks for it (`stream: true`), sending the head and each chunk as `FRAME_V1_MORE` frames through the new `emit` argument of `handleFrame`;
  - the final frame ends the response;
  - a request that doesn't ask is answered whole, as before.

## 0.19.2

### Patch Changes

- bc3fd25: `Response.body` and `Request.body` are `ReadableStream`s only from compatibility date `2026-10-21`. 0.19.0 changed this for every app, which broke handlers that read `request.body` as a string, such as `JSON.parse(request.body)` in the CLI's own D1 example. An app with an earlier `compatibility_date` keeps the raw body, as before. To opt in, move `compatibility_date` to `2026-10-21` or later and rebuild.

## 0.19.1

### Patch Changes

- 6676ead: `env.BUCKET.put(key, request.body)`, `env.KV.put(key, request.body)` and `fetch(url, { body: request.body })` store and send the request body again. Since 0.19.0, `body` is a `ReadableStream`, and these took its string form. Incoming request bodies are also read as the bytes they are, so `arrayBuffer()`, `blob()`, `body` and KV `put` no longer UTF-8 encode a non-ASCII upload twice. R2 `put` accepts bytes as well.

## 0.19.0

### Minor Changes

- 4274bef: `Response.body` and `Request.body` are `ReadableStream`s for every body type, as in the Fetch spec and workerd. Before, they held the value given (a string, bytes or a `Blob`). `res.body.getReader()`, `res.body.pipeThrough(...)` and `new Response(other.body)` now work on any response, including the incoming request. The value as given stays internal, so responses are still written with a fixed length unless the body really is a stream. A body whose stream has been locked can no longer be read with `text()` and the other readers, which throw a `TypeError`.

## 0.18.0

### Minor Changes

- 145e3dc: `HTMLRewriter`, matching Cloudflare's API and lol-html's output.
  
  - **Handlers:** `on(selector, { element, text, comments })` and `onDocument({ doctype, text, comments, end })`.
  - **Element methods:** attributes, `tagName`, `before`/`after`/`prepend`/`append`/`replace`/`setInnerContent` with `{ html }`, `remove`, `removeAndKeepContent` and `onEndTag`.
  - **Selectors:** type, `*`, `#id`, `.class`, the attribute operators, descendant and child combinators, and lists.
  - **Async:** handlers may be async.
  
  It reads the whole body before rewriting rather than streaming it. 37 cases are checked against Bun's lol-html-based HTMLRewriter, including where lol-html keeps attributes byte for byte and does not imply end tags.
- 2541458: More of the Web platform, from sproutd's W2 conformance suite against workerd:
  
  - `CompressionStream` and `DecompressionStream` for `gzip`, `deflate` and `deflate-raw`, in JavaScript, because the native runtime links no zlib. Output decompresses with zlib, and zlib's output (stored, fixed and dynamic blocks) decompresses here. A corrupt or truncated input errors with a `TypeError`.
  - A `Response` or `Request` whose body is a `ReadableStream` is read to the end by `text()`, `json()`, `arrayBuffer()` and `blob()`. Before, these returned `"[object ReadableStream]"`. Chunks must be bytes, as in workerd.
  - `JSON.parse` applies its reviver: children first, `undefined` deletes the property, and `this` is the holder.

### Patch Changes

- 116ee47: sproutd builds the runtime again. In split builds Porffor cannot type a prelude function's parameters, and the compression checksums' `let c = ~crc` compiled to C that assigned a boxed value to a number. The checksums now start from the parameter itself.

## 0.17.1

### Patch Changes

- 3dabc97: Scheduled, queue and Durable Object alarm triggers answer `204` with no body again. The prelude built that reply as `new Response("", { status: 204 })`, which the Fetch-spec `Response` of 0.17.0 rejects (an empty string is still a body), so the first cron or alarm failed, and on the alarm path the error took the server down.

## 0.17.0

### Minor Changes

- a96a443: Apply static asset redirects and header rules in dev and standalone asset bindings, preserving binary response bodies.
- 6e88627: Standalone sprouts stream `ReadableStream` response bodies. The status and headers go out as soon as the handler returns, and each chunk reaches the client as it is produced (chunked encoding), so Server-Sent Events, progress output and long responses work. A client that disconnects cancels the stream. Hosts without the streaming server (sproutd's workers, for now) still read the stream to the end and send it buffered.

### Patch Changes

- 5d4d40b: A host that runs an event loop can let `fetch()` run without blocking the sprout: after `sb_async_enable()`, outbound requests run on up to 8 threads and resolve their promises when the host calls `sb_async_drain()`. Nothing changes for standalone sprouts, where `fetch()` stays synchronous.
- 6880f60: Add an opt-in bounded multi-session broker worker with private supervisor control.
  Fence queue acknowledgements to durable delivery claims and retain recoverable alarm deliveries across process crashes in broker and embedded transports.
  
  Resume native R2 downloads until completion or renewed backpressure instead of leaving large responses stalled.
  
  Retain partially written TCP replies until drain and serialize pipelined replies so large broker-backed R2 reads cannot truncate or interleave frames.
  
  Honor wildcard, weak and list-based If-None-Match conditions on broker direct downloads.
  
  Move D1 queries, batches, exec and backups off the shared broker event loop into two lazy SQL threads per broker process. Preserve database affinity, transaction rollback and session isolation, and bound queued work with per-session admission and queue deadlines. Running SQLite statements remain non-preemptible; keep shared mode opt-in.
  
  Enforce shared D1 execution budgets through a capability-protected native SQLite progress hook. Interrupted batches roll back and lanes remain usable. A broker watchdog revokes all sessions if native work cannot be interrupted; uncertain SQL outcomes are never automatically retried. Build the small SQLite extension during host/image preparation.
- 846519f: Fixes found by the new differential conformance suite against workerd:
  
  - `JSON.stringify` of a cyclic object throws `TypeError` instead of crashing the process (it recursed until the native stack overflowed), so one request can no longer take a worker down.
  - `structuredClone` follows the structured-clone algorithm: cycles, `Map`, `Set`, `Date`, `RegExp`, typed arrays, `DataView` and errors survive the copy, and functions and symbols throw `DataCloneError`. It was a JSON round-trip that lost every non-JSON type and also crashed on cycles.
  - `Event`, `CustomEvent`, `EventTarget`, `AbortSignal` (`abort`, `timeout`, `any`, `throwIfAborted`) and `AbortController` exist.
  - `Object.prototype.toString` names typed arrays (`[object Uint8Array]`, not `[object Object]`).
- b47aad4: Outbound `fetch()` sends the port in `Host` when it isn't the scheme's default (`Host: api.example.com:8080`), as HTTP/1.1 requires. A sandboxed host can now open outbound connections on a sprout's behalf: with `SB_EGRESS_FD` set, `fetch()` asks that socket for a connected socket instead of resolving and connecting itself.
- f19ca0d: `error.stack` is a string, V8's first line (`TypeError: message`), instead of `undefined`, for every error type including errors the runtime throws. Porffor keeps no frames to list after it.
- ddb0f9d: Response, Request and Blob follow the Fetch spec, and binary bodies reach the client intact:
  
  - A `Uint8Array` or `ArrayBuffer` response body is sent as its bytes. It was sent as text: `new Response(new Uint8Array([104, 105]))` reached the client as `104,105`, and an `ArrayBuffer` as `[object ArrayBuffer]`.
  - `Response` has `statusText`, `type`, `bodyUsed` and `Response.error()`. A status outside 200–599 throws `RangeError`, a body with 101/204/205/304 throws `TypeError`, and `arrayBuffer()`/`text()` handle byte bodies (UTF-8 both ways).
  - `Request` normalizes its URL and rejects relative or invalid ones, has `redirect` and `bodyUsed`, rejects a body on GET/HEAD, and sets the default content type for string and `URLSearchParams` bodies.
  - A body can be read once: a second `text()`/`json()`/`arrayBuffer()`/`blob()` throws `TypeError`.
  - `Blob` holds bytes, with `size`, `type`, `slice` (negative indices too), and promise-returning `text`/`arrayBuffer`/`bytes`. `File` exists. `FormData` stores a `Blob` value as a `File` named by its filename, and `new Response(formData)` sends multipart/form-data.
- f201b58: `fetch(request)` sends the Request's method, headers and body (it sent a plain GET), and `init` overrides them field by field as in workerd. `fetch(new URL(...))` works. An uncaught exception's 500 response has no content type again, as in workerd.
- 08d0192: Builds are fast again: the URLSearchParams serializer added in the previous release doubled native compile time (a hello-world handler went from 6.6 s to 13.4 s); it now encodes in one pass and compiles in 6.8 s.
- 6d6ae43: `Headers` is iterable (`new Map(headers)`, `[...headers]`, `Object.fromEntries(headers)`), and `new Headers([["name", "value"]])` reads the pairs instead of producing headers named "0", "1"...
- 9fdf3fa: Upgrade the verified vendored Porffor pin to Alpha 18 (`deda494`). Alpha 18 brings spec BigInt arithmetic and bitwise operators, iterator helpers, Set methods, `Array.fromAsync`, Atomics, resizable ArrayBuffers, explicit resource management, a rewritten Temporal, an on-demand Intl polyfill, and many RegExp, Promise and Object spec fixes. Three downstream workarounds are dropped because upstream now covers them: the typed-array read and write bounds checks (#238, #241), the `toJSON` step in `JSON.stringify` (Alpha 18 also adds the replacer argument), and the Web Streams adapter for dynamic array iterator lookup. The remaining patches are unchanged.
- 4c78d83: Match the Fetch spec and workerd for common responses: string bodies default to `text/plain;charset=UTF-8`, `Response.json` sets `application/json`, and `Response.redirect` serializes its URL (`https://example.com` becomes `https://example.com/`) with a null body.
- 088cad0: Shared-object (split) builds no longer crash on start or lose the Web Streams classes.
  
  - **Toolchain:** split output prefixes module globals with `pg_`. A global named like a libc symbol (the prelude's `clone`, or an app's `hash` or `search`) bound to libc instead, so the runtime wrote into libc's code and every worker crashed. Internal `__` globals keep their names. Standalone builds are unchanged, because their globals are `static`.
  - **Runtime:** the Web Streams polyfill installs each class with its own `globalThis.X =` assignment. Where the prelude is a separate unit, Porffor resolved `new ReadableStream()` in app code at compile time and, seeing only a dynamic install, compiled it to a ReferenceError. `gen-streams.ts` now fails if an export of the polyfill is not installed.
- 6e42051: A `ReadableStream` response body is sent. The stream is read to the end and the body sent buffered (at most 32 MiB). Before, the client received the text `[object ReadableStream]`. As in workerd, chunks must be bytes, and a stream of strings answers 500. Streamed (progressive) delivery is a separate step.
- 9dc109d: `TextEncoderStream` and `TextDecoderStream` exist. The decoder runs `TextDecoder` in streaming mode, so a character split across chunks decodes correctly, and the encoder holds a lone high surrogate until the next chunk.
- 28b0c39: `URL` behaves like the WHATWG URL: `new URL(path, base)`, setters for every part (`url.hostname = ...`, `port`, `protocol`, `host`, `search`, `hash`, `href`), default ports dropped, dot segments resolved, percent-encoding, `URL.canParse`, and `searchParams` changes written back into the URL. `JSON.stringify` calls `toJSON`, so a `Date` serializes as its ISO string (it was `{}`) and a `URL` as its href.
- 6b64985: A fetch handler's response no longer waits for its `ctx.waitUntil` work: the response goes out as soon as the handler returns and the background work keeps running, still capped at 25 s, as in workerd. A handler that scheduled 1.5 s of background work used to answer 1.5 s late. The cap's timer is also cleared once the work finishes, so a sprout no longer keeps a timer pending for 25 s after every `waitUntil`. `scheduled` and `queue` handlers still finish their `waitUntil` work before they reply.
- eec94f1: Web API fixes found by the conformance suite against workerd:
  
  - `Headers` follows the Fetch spec: `get` joins repeated values with `", "`, iteration is sorted by name with values combined (each `Set-Cookie` listed separately), `getSetCookie()` exists, values are trimmed, and invalid names or values throw `TypeError`. Each appended header still reaches the wire as its own line.
  - `TextDecoder` is the WHATWG UTF-8 decoder. Characters outside the BMP (emoji) decode correctly, invalid bytes become U+FFFD (or throw with `fatal`), the BOM is stripped unless `ignoreBOM`, and `{ stream: true }` keeps an incomplete sequence for the next chunk.
  - `toLowerCase`/`toUpperCase` map non-ASCII letters (Latin, Greek, Cyrillic and the rest of the BMP's simple mappings). They mapped ASCII only.
  - `new URLSearchParams(init)` accepts a record, a sequence of pairs or another `URLSearchParams`. Only strings worked; `{ a: "1" }` gave `%5Bobject+Object%5D=`.
  - `atob` ignores ASCII whitespace and throws `InvalidCharacterError` on invalid input, and `btoa` throws on characters above U+00FF.
  - `queueMicrotask` exists.
  - URL hosts are converted to ASCII (Punycode): `new URL("http://münchen.test").host` is `xn--mnchen-3ya.test`.
  - `crypto.subtle.digest` supports SHA-1 and MD5, and HMAC works with SHA-1. `exportKey("raw")`, `generateKey` for HMAC and workerd's `crypto.subtle.timingSafeEqual` exist, and imported keys report `algorithm.length`. Errors carry WebCrypto's names (`NotSupportedError`, `InvalidAccessError`), and `getRandomValues` over 65,536 bytes throws `QuotaExceededError`.
  - `setTimeout(fn, 0)` and `setInterval(fn, 0)` fire on Linux. uSockets arms timers with `timerfd_settime`, and a zero expiry disarms the timer, so a zero-delay timer never ran (macOS fired it). Timers are armed at 1 ms at least.

## 0.16.0

### Minor Changes

- 14546a0: Add Web Streams globals from web-streams-polyfill 4.3.0, including readable, writable and transform streams, with native regression coverage. Streams run in memory; HTTP request and response bodies remain buffered by the native transport. Together with the compiler fixes, Better Auth 1.7.1 passes email/password and signed-cookie session flows with an explicit memory database adapter. Database-free encrypted sessions still require unsupported AES crypto.

  Expose the existing native timeout and interval functions on globalThis, supporting host-task yields in noble hashes 2.4 without changing timer semantics.

## 0.15.0

### Minor Changes

- Pin and vendor Porffor alpha-16 (43087d4). Enable Proxy and revocable Proxy in handler validation, add native regression coverage for traps and iterators, and drop three typed-array patches now implemented upstream. URLSearchParams and FormData now provide live, self-iterable keys, values and entries iterators. See PORFFOR_ALPHA16.md for the complete change audit and remaining package compatibility limits.

## 0.14.0

### Minor Changes

- 4dd16b7: `fetch()` reaches any public address and never a private or reserved one (baronunread/sproutboat#174). The `outbound` allowlist is gone.
  
  - Both backends, the broker and the standalone client, check the address they resolved, not the hostname, so DNS rebinding can't get past the check. The broker connects to the vetted address and verifies TLS against the name.
  - Blocked: loopback, RFC 1918, link-local and cloud metadata, CGNAT, benchmarking, documentation, multicast and reserved ranges, IPv6 ULA and link-local, and the IPv4 address inside IPv4-mapped, NAT64 and 6to4 addresses.
  - An operator can let addresses through with `SB_EGRESS_ALLOW` (`*` or exact addresses) in the broker's or the binary's environment. Handler code can't.
  - `@sproutboat/runtime`: `URL.hostname` and `URL.port` handle IPv6 literals (`[::1]:9` used to give hostname `[`). Every sprout gets `fetch()`, with no binding needed. `validateHttpSyncSource` no longer takes an `outboundAllowed` argument, and `Bindings` loses `outbound`.
  - `@sproutboat/wire`: `Bindings` loses `outbound`.
  - `@sproutboat/config`: `outbound` is accepted but ignored, with a warning in the new `warnings` field of a successful parse (`OUTBOUND_IGNORED`). It will be refused in a later minor release.

## 0.13.5

### Patch Changes

- 5dba469: Binary data survives KV and outbound `fetch()` bodies (baronunread/sproutboat#233, and the request half of #232).
  - **KV:** `put()` of an `ArrayBuffer` or any typed array stores its bytes, flagged binary, instead of `String(view)` (`"0,1,2,..."`). `get(key, type | { type })` supports `"text"`, `"json"` and `"arrayBuffer"` as in Workers: a binary value read as text decodes as UTF-8, and a text value read as `arrayBuffer` is its UTF-8 encoding. `"stream"` throws a clear error. Existing stores gain the `binary` column on first use.
  - **`fetch()` and service-binding request bodies:** an `ArrayBuffer` or view is sent as its exact bytes in both transports, instead of `"0,1,2,..."`. The standalone HTTP client also stopped truncating bodies at the first NUL byte.

## 0.13.4

### Patch Changes

- 5bf4ea6: The handler bundle runs in its own function scope inside the generated module (part of baronunread/sproutboat#238). It used to be spliced into the prelude's top level, and Porffor resolves top-level names module-wide, so a bundle with its own top-level `const URL = ...` (uuid exports one) replaced the `URL` class the prelude extends and the binary died at startup with `Cannot get property of null`. Static imports from a direct-ESM handler stay at module top level.

## 0.13.3

### Patch Changes

- 733bd9e: Outbound `fetch()` and service-binding responses keep binary bodies intact (baronunread/sproutboat#232). `arrayBuffer()` and `bytes()` on a fetched response used to go through Porffor's `text()`, which the runtime overrides to decode UTF-8, so binary bodies collapsed; they now read the raw bytes. Through the broker, `fetch` and `service.fetch` sent over a v1 frame now get the upstream body as raw bytes in the frame's binary section instead of `TextDecoder` output. v0 frames, which already-deployed sprouts use, are unchanged, and a new sprout talking to an older broker falls back to the previous text behaviour.

## 0.13.2

### Patch Changes

- dc6539c: Log uncaught handler exceptions to stderr before answering 500, as `Uncaught (in fetch) Error: ...` (and `scheduled` / `alarm` for those triggers). A thrown or rejected handler used to produce a bare 500 with nothing logged, which hid baronunread/sproutboat#168 entirely.

## 0.13.1

### Patch Changes

- ebee2ad: Non-ASCII text read back from bindings no longer comes back garbled (baronunread/sproutboat#189). D1 rows, KV values, cached bodies, R2 metadata and SQLite error messages returned "café" as "cafÃ©" in both standalone builds and broker-backed deployments: the reply JSON is UTF-8, but it reached the handler one char per byte. Replies are now escaped to ASCII before parsing. Outbound `fetch()` bodies and BLOB columns keep their raw bytes.

## 0.13.0

### Minor Changes

- 34083e1: Pass `(request, env, ctx)` to handlers built with compatibility dates from 2026-09-28. Older builds retain `(request, ctx)`. Add `Response.redirect()` for native fetch and decode request text as UTF-8 while preserving raw body bytes. The matching compiler Unicode fix shipped in `@sproutboat/toolchain@0.4.14`.

## 0.12.1

### Patch Changes

- ed9640a: Point Porffor patch diagnostics, runtime comments, and historical notes to the
  shared upstream notes in the Sproutboat platform repository.

## 0.12.0

### Minor Changes

- 4a7fe62: Cache API: `caches.default` / `caches.open(name)` (baronunread/sproutboat#59), with `match()`/`put()`/`delete()` backed by both transports (broker's `cache.*` ops and the standalone embedded transport, so behavior matches whichever way the app deploys). Keyed on method+URL for v1 (no `Vary` support yet). `put()` throws for a non-GET request, matching the spec; a 206 status or an explicit `no-store`/`private` `Cache-Control` is a silent no-op rather than an error, matching Workers' own `caches.default`. TTL derives from `s-maxage` (preferred) or `max-age`; entries with neither have no expiry.
  
  Deliberately synchronous, not Promise-returning: every other buffered-body method this runtime already ships (`text()`/`json()`/`arrayBuffer()`/`blob()`/`formData()`) is sync too, and this runtime's own coroutine machinery has a known, still-open memory-corruption issue tied specifically to nested `async function` calls accumulating across many requests (baronunread/sproutboat#168) — no reason to add more async surface here. `await caches.default.match(...)` still reads correctly: awaiting a non-promise value resolves to it immediately.
- 96f97e2: `Request`/`Response` gain `formData()` (baronunread/sproutboat#60), parsing the buffered body synchronously — `application/x-www-form-urlencoded` via the existing `URLSearchParams` shim, `multipart/form-data` by hand (RFC 7578 boundary parsing, file fields come back as `Blob`s). Also adds `bytes()` (the `Uint8Array` shorthand over `arrayBuffer()`) to both classes. Everything is feature-detected, so this is a no-op the moment Porffor ships either natively.

### Patch Changes

- 81dc1f7: Preserve raw bytes in `crypto.subtle.digest`, HMAC signing, and `crypto.scryptVerify`. The runtime's byte conversion already produces UTF-8 bytes for text and copies BufferSource inputs exactly, so the native bridge must pass those bytes through without encoding them again. This fixes repeated HMAC signing with digest bytes above `0x7f`.

## 0.11.0

### Minor Changes

- d0e2c05: `request.cf` gains `httpProtocol`, `tlsVersion`, and `tlsCipher` (baronunread/sproutboat#128). Like `clientIp` (#163), these are only populated when the direct peer is listed in `SB_TRUSTED_PROXIES` and it forwarded the corresponding `x-sb-http-protocol` / `x-sb-tls-version` / `x-sb-tls-cipher` header — otherwise they stay absent rather than a guessed or faked value. `colo`, ASN, and geo fields remain out of scope (no GeoIP database on the box).

## 0.10.0

### Minor Changes

- 7287d9b: KV: native key expiration (baronunread/sproutboat#58). `env.KV.put(key, value, { expirationTtl })` / `{ expiration }` now match the Cloudflare Workers contract: `expirationTtl` is seconds from now (rejected below 60, matching CF), `expiration` is an absolute unix-seconds timestamp. An expired key reads as absent from `get()` and is omitted from `list()`; the row is hard-deleted lazily the next time it's touched by a get. No new transport op — both `expirationTtl` and `expiration` are optional fields on the existing `kv.put` frame, so an older broker/prelude pair that ignores them keeps working exactly as before.
- 7287d9b: Version metadata binding (baronunread/sproutboat#126). `sproutboat.jsonc` gains a `version_metadata` key naming a binding (like wrangler's `[version_metadata]`), and `wrapNativeFetchHandler` bakes `env.<binding> = { id, tag, timestamp }` directly into the module at build time — no broker round trip. `id`/`tag`/`timestamp` are supplied by the caller (the CLI derives them from the artifact digest, the project name, and the build time); this package only wires the config field through and does the baking.

## 0.9.6

### Patch Changes

- f070d70: Revert native R2 transfer size-gating (#202). It saved ~11KB of `__text`
  (~1.3% of a typical binary) and on macOS didn't even change the shipped
  file size, since `__TEXT` is page-aligned. Not worth the `#ifdef`
  guard-placement bug class it introduced. R2 transfer support is native code
  again, always compiled in with 404 stubs where unused, same as before #202.

## 0.9.5

### Patch Changes

- a357b91: Compile direct R2 transfer support only into artifacts that declare an R2 binding.

## 0.9.4

### Patch Changes

- 38db17d: Fix broker-backed native-fetch builds after the direct R2 download ABI gained an ETag accessor.

## 0.9.3

### Patch Changes

- 5ee065c: Stream standalone direct R2 byte ranges safely and support ETag conditionals.

## 0.9.2

### Patch Changes

- d8b7877: Add native standalone R2 direct-download tickets with bounded, backpressure-aware
  file reads, including upgrades for existing patched Porffor caches.

## 0.9.1

### Patch Changes

- e0944a4: Provide the native direct-transfer ABI in broker builds so the shared
  uWebSockets patch does not introduce unresolved symbols outside standalone
  mode.

## 0.9.0

### Minor Changes

- 0b0a666: Add a native standalone R2 direct-upload bridge that streams transfer-ticket
  request chunks to a temporary blob file, validates the digest, and atomically
  publishes the object without buffering the upload in the Porffor request body.

## 0.8.0

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

## 0.7.1

### Patch Changes

- b0c5bbd: Fix #177: `new Response(obj.body)` on an `R2Object` UTF-8-re-encoded raw
  bytes, corrupting any binary content (each byte 0x80-0xFF doubled on the
  wire). Added `R2Object.toResponse(init?)`, which serves the bytes
  unmodified via the same `x-sb-raw-body` marker `__sbRawBodyResponse` already
  uses for assets/fetch/service-binding responses. Defaults `content-type`
  from `httpMetadata` and `etag` from `httpEtag` when not set in `init`.

## 0.7.0

### Minor Changes

- 6998a15: R2 object bytes no longer live inside SQLite, on either transport (baronunread/sproutboat#56). Every `put()` used to bind the whole object into a `body` column, and every `get()` read it back out — doubling the object through SQLite's own page cache/WAL machinery on top of the buffer it already arrived in, which was the real driver of #56's "large uploads make memory skyrocket" complaint (the JSON-escaping half of that was already fixed in #63).
  
  Objects now live in their own file under `r2-blobs/`, named by a hash of bucket+key (so unicode keys and directory traversal are non-issues):
  
  - **Embedded (standalone):** `<data-dir>/r2-blobs/` — `sb_r2_put_c`/`sb_r2_get_c` write/read the file directly via C `fopen`/`fwrite`/`fread`, no SQLite blob column at all. `sb_r2_delete_blob` removes the file on delete.
  - **Broker:** colocated with whichever store file already holds that bucket's metadata — the main `db` for a bare-string binding, the resource's own file under `resourceDir` for an account-level one (#74) — so blobs persist across a redeploy exactly when that metadata does. `:memory:` stores (tests, local dev) fall back to an in-memory map.
  
  No migration: this is a schema change for new writes going forward, not a converter for objects already stored inline from before.
  
  Verified end-to-end against both transports (kitchen-sink's full conformance suite, 24/24 standalone + 27/27 broker) and with new unit tests for file-backed persistence, the `:memory:` fallback, and a real binary round-trip over the v1 wire protocol.
  
  **Known limitation found while verifying this, not fixed here:** a binary `put()` body (bytes ≥ 0x80) is corrupted on the way *in*, before it ever reaches storage: `porf_native_fetch_read_value` (the function every inline-C string read in the runtime goes through) always UTF-8-encodes a Latin-1-range string on read, which is correct for genuine text but wrong for opaque bytes coming off a raw HTTP body. This predates this change (the old SQLite-blob path had the identical corruption) and is not something the storage backend can fix. It needs an input-side counterpart to `#176`'s `x-sb-raw-body` marker, or real `ArrayBuffer`/`Uint8Array` body support (the upstream ask was filed as Porffor #386 and later retracted; see `https://github.com/baronunread/sproutboat/blob/main/patches/upstream/request-body-report-386.md`).

### Patch Changes

- 188d8e4: Fix (baronunread/sproutboat#184): a `put()` body (R2, both transports) with bytes ≥ 0x80 was corrupted on the way *in*, before storage: `porf_native_fetch_read_value` (the one function every inline-C string read in the runtime funnels through) always UTF-8-encodes a Latin-1-range value, correct for genuine text, wrong for opaque bytes off a raw HTTP upload. A 256-byte binary upload landed as 384 stored bytes.
  
  `__sbR2PutRaw` (embedded) and `__sbCallBin` (broker, the only caller that ever passes it a real body) now try `porf_native_fetch_read_raw_bytes` first, falling back to the normal encoding path only for a genuine multi-byte JS string (which isn't a "bytestring" and so isn't eligible for the raw read anyway). This predates the #56 storage change — the old SQLite-blob `put()` called the identical `read_value`, so it was equally corrupted; the existing R2 conformance check never caught it because it only ever exercises a plain ASCII string.
  
  Also fixes an adjacent, independently pre-existing bug found while verifying this: `R2Object.text()`/`.json()` returned the raw stored bytes without UTF-8-decoding them, producing mojibake for any object holding real text beyond ASCII — the same gap `__sbRawBodyResponse` already closed for assets/fetch/service-binding responses. Same fix here (lazy, memoized `__sbFromUtf8` decode).
  
  Verified end-to-end against both transports with a real binary upload (`curl --data-binary`, not a synthetic string): stored bytes and `.body`/`.text()` now round-trip byte-for-byte/correctly for binary content, Latin-1 text, and multi-byte Unicode (CJK). Full kitchen-sink conformance stays green on both transports (24/24 standalone, 27/27 broker).
  
  **Known remaining gap, not fixed here:** a genuine astral-plane character (an emoji, anything outside the Basic Multilingual Plane, encoded as a UTF-16 surrogate pair) still encodes to the wrong number of UTF-8 bytes on write — confirmed identical before and after this fix, so it's a separate, deeper bug in Porffor's own UTF-16→UTF-8 encoder (the `porf_native_fetch_read_value` "string" branch), not something in sproutboat's own code. Filing separately if it recurs; out of scope for this fix.

## 0.6.6

### Patch Changes

- c2b0359: Fix (baronunread/sproutboat#179): `__sbEntry` called `handlers.fetch()` (and
  the `scheduled`/`queue`/`alarm` trigger paths) with no try/catch at all. Any
  synchronous throw, or an async handler's rejected promise, propagated all the
  way up and took down the entire process — not just the request that hit it,
  but every other in-flight and future request on that sprout, until whatever
  supervises it restarts the binary.
  
  A throw from `fetch()` now returns a 500 instead. `scheduled()` and `alarm()`
  still reply 204 either way (they had no failure signal before this either).
  A throw from `queue()` falls through to the existing default-ack pass, the
  same outcome as a handler that returns without calling `ack()`/`retry()` on
  every message.
  
  `entry-crash.test.js` covers the fetch path: a sync throw, an async
  rejection, and that a throwing request doesn't stop the next one from being
  served.

## 0.6.5

### Patch Changes

- d798206: Fix (baronunread/sproutboat#181): 0.6.4's `__sbToBytes` rewrite fixed the large
  input it targeted and badly regressed the small one. An app hashing ~150-byte
  values through `crypto.subtle.digest` on every request lost **64% of its
  throughput** (4,700 to 1,680 req/s), tripled its p50 (4.6ms to 13.4ms) and grew
  41% in RSS (66.5 to 93.8 MB). 0.6.4 replaced a `s +=` loop with an
  array-push-then-join unconditionally, and below about 512 bytes the array is
  pure overhead: one boxed element per input byte, allocated and joined, where
  the string append had nothing to allocate at all.
  
  `__sbToBytes` now accumulates into a window and only creates an array once a
  window fills. An input under 512 bytes touches no array and runs exactly like
  the pre-0.6.4 code; a larger one caps the quadratic copy at one window and
  joins the windows once, keeping the #180 fix (a 43KB body encodes in ~3ms
  instead of ~52ms). Both branches flush only on a complete character, so a
  surrogate pair can never be split across a window boundary. 512 is where the
  two costs cross on a `porf native` build, and the curve is flat either side, so
  it is a plateau rather than a tuned constant.
  
  Measured end to end on the reporter's real workload, not just a microbench
  (which under-predicted the regression by two orders of magnitude and would have
  shipped the wrong fix): 4,690 req/s, p50 4.62ms, RSS 66.4 MB, matching the
  pre-regression baseline on every axis.
  
  Three other 0.6.4 changes are reverted to byte-identical 0.6.3, since they were
  made for consistency rather than against a measured problem, and #181 is
  evidence that array allocation at small sizes is the wrong trade in this
  runtime: `__sbHex` and the outbound-fetch header builder in
  `transport-embedded.js`, and `__SproutboatURLSearchParams.prototype.toString()`.
  `__sbHexOrBytes` keeps its nibble fix, which drops a `slice(0, -1)` rewrite that
  copied the accumulator twice per byte, but goes back to `+=`: it decodes an HMAC
  signature, which is tens of bytes.
  
  `to-bytes.test.js` gains the small-input coverage this needed: sizes either side
  of the window boundary (0, 1, 150, 511, 512, 513, 1024, 1025) on both branches,
  and a surrogate pair walked across the boundary.

## 0.6.4

### Patch Changes

- 8ef3148: Fix (baronunread/sproutboat#180): `__sbToBytes` built its result with repeated
  `s +=` in a loop, the same `O(n^2)` bug class the `__sbFromUtf8` fix in 0.6.3
  addressed, just on the encode side. Porffor's strings have no rope/cons
  optimization, so `+=` in a loop copies the whole accumulated string on every
  append. Both of its branches were affected: the UTF-8 encode loop over string
  input, and the byte-for-byte copy out of an ArrayBuffer or typed array.
  
  This one matters because `__sbToBytes` sits behind every `crypto.subtle` call a
  handler makes: `digest`, `importKey`, `sign`, `verify` and the PBKDF2/scrypt
  path all funnel their data, keys, salts and signatures through it. Hashing a
  request body was quadratic in the body's size.
  
  `__sbHexOrBytes` had the same shape on a third crypto path (it decodes the
  `expected` side of an HMAC verify) and was worse than a plain `+=` loop: on odd
  iterations it rewrote the last character with `out = out.slice(0, -1) + ...`,
  copying the accumulated string a second time per byte. It now holds the high
  nibble in a local until its pair arrives and pushes one character per byte.
  
  Three further accumulators converted to the same array-and-join idiom for
  consistency. These are bounded by header count, id length or parameter count
  rather than by handler input, so they are hygiene rather than a fix:
  `__SproutboatURLSearchParams.prototype.toString()` in the prelude, and `__sbHex`
  plus the outbound-fetch header builder in `transport-embedded.js`.
  
  Covered by a new `to-bytes.test.js`, following the `utf8-decode.test.js`
  convention of lifting the pure functions out of the text-only prelude: ASCII,
  2-byte, 3-byte and surrogate-pair encodes checked byte-identical against
  `TextEncoder`, the existing unpaired-surrogate behaviour pinned, typed-array and
  ArrayBuffer input with high bytes, hex decode in both cases with its non-hex and
  odd-length fallbacks, and long inputs (46KB string, 50,000-byte array, 20,000-byte
  hex) for correctness at the size the quadratic version hurt.

## 0.6.3

### Patch Changes

- Fix two compounding performance regressions in the `#181` fix, caught after
  it went live and made sproutboat.com's homepage take 2.6-2.8s per request:
  
  1. `__sbRawBodyResponse` decoded eagerly at construction, paying the cost of
     `__sbFromUtf8` on every asset/proxied response regardless of whether the
     handler ever called `.text()`/`.json()` on it (the common case is a
     response handed straight back to the client, never read as text). Now
     decodes lazily on first call and memoizes.
  
  2. `__sbFromUtf8` built its result with repeated `out +=`. Porffor's strings
     have no rope/cons optimization, so `+=` in a loop copies the whole
     accumulated string on every append, making a large decode `O(n^2)`.
     Measured directly against the real broker-sourced 43KB homepage body,
     each successive 8000-character chunk took visibly longer than the last.
     Now builds into an array and joins once.
  
  Together these took the homepage from ~2.7s to ~25ms (measured via the
  runtime's own `x-sb-cpu-ms` header, confirming real CPU time, not I/O wait).
  Every other route was already unaffected by fix 1 alone, since they never
  call `.text()`. Verified against a real compiled `porf native` binary with
  the actual page content, and end to end on sproutboat-site's own deployment.

## 0.6.2

### Patch Changes

- bd06ce7: Fix (baronunread/sproutboat#181): a handler calling `.text()`/`.json()` on a
  Response built from raw wire bytes — the assets binding, outbound `fetch()`,
  or a service-binding `fetch()`, the three places that set the `x-sb-raw-body`
  marker for #176 — got the bytes back undecoded instead of as real text. Those
  Response bodies are Porffor `bytestring`s (one raw byte per code unit), and
  `Response.prototype.text()` returns that verbatim rather than UTF-8-decoding
  it, so any multi-byte UTF-8 sequence came back as multiple wrong Latin-1
  characters. A handler that transforms and re-emits that text (sproutboat-
  site's homepage does this to inline its live counter into the fetched
  `index.html`) then re-encodes the corruption as ordinary UTF-8 on the way
  out — this is what turned `·` into `Â·` live on sproutboat.com.
  
  Fixed at the sproutboat glue layer, not in Porffor: the three `x-sb-raw-body`
  producers in `native-fetch-prelude.js` now build their Response through a new
  `__sbRawBodyResponse()`, which overrides `.text()`/`.json()` on just that
  instance with a proper UTF-8 decode (`__sbFromUtf8`, validates each
  continuation byte before consuming it). This is deliberately *not* a patch to
  Porffor's generic `Response`/`Request` classes — Porffor represents any
  string whose characters are all <= 0xFF as this same `bytestring` shape,
  whether it's opaque bytes or a handler's own Latin-1-range text (e.g.
  `"café"`), and the type alone can't tell those apart. Decoding generically
  would corrupt the second case; scoping the fix to the three call sites that
  know for certain their body is bytes avoids that entirely (verified: a
  genuine `"héllo"`/`"café"` string passes through `__sbFromUtf8` unchanged).
  
  Verified against a real compiled native-fetch binary (`porf native`, not just
  plain Bun): the override pattern works as expected, the decode round-trips
  real multi-byte and 4-byte UTF-8 correctly, and genuine Latin-1 text is left
  alone. Also verified end to end on sproutboat-site's own deployment.

## 0.6.1

### Patch Changes

- 806c21e: Fix (baronunread/sproutboat#176): #172's bytestring UTF-8 encoding fix broke
  the assets binding, which reads a file's bytes off disk into a `bytestring`
  specifically so they pass through the wire untouched — a `bytestring`
  carrying real text a handler built and one carrying opaque file bytes are the
  same type with no way to tell them apart, so #172's blanket encoding also
  re-encoded already-finished bytes, corrupting any binary asset (and any
  proxied `fetch()`/service-binding response body).
  
  Adds a second, dedicated `porf_native_fetch_read_raw_bytes` (zero-copy,
  bytestring-only, no encoding, ever) alongside the untouched original —
  `porf_native_fetch_read_value` is called from ~30 places across sproutboat's
  own inline C, all genuine text, so its signature and behavior stay exactly as
  #172 left them. `write_response_value` picks between the two based on a new
  reserved `x-sb-raw-body` response header (same pattern as #163's
  `x-sb-remote-addr`), which the assets binding, outbound `fetch()`, and
  service-binding `fetch()` now set — the three places sproutboat's own
  prelude constructs a Response from wire bytes rather than a string a handler
  built. Verified end-to-end: a 256-byte all-values fixture now round-trips
  byte-for-byte through a real standalone build's assets binding, and #172's
  original UTF-8 fix still holds for genuine text.
  
  Not fixed here: `env.<R2>.get()`'s `.body` is exposed directly to handler
  code, which then constructs its own `new Response(obj.body)` — no
  sproutboat-owned call site to attach the marker to, so R2 binary objects
  served this way carry the same corruption. Needs either a real binary body
  type upstream in Porffor or a different API shape; tracked as a known gap on
  #176, not resolved by this fix.

## 0.6.0

### Minor Changes

- ae8c7a8: `ctx.waitUntil` (baronunread/sproutboat#57): `fetch(request, ctx)` now takes a
  second argument with `waitUntil(promise)`. Registered promises are drained,
  in-process and sequentially, after the handler returns and before the turn
  completes, capped at 25s for the whole batch — a task still running past that
  keeps running, but stops holding up the response. A rejected task is
  swallowed rather than failing the response.
  
  `DurableObjectState.waitUntil` was a silent no-op stub; it now actually queues
  and drains the same way, scoped to the instance. `alarm()` also used to be
  fire-and-forget (its promise and any `state.waitUntil()` it queued were
  dropped the moment the 204 went out) — both are now awaited.
  
  Additive: a handler that ignores the second `fetch` argument is unaffected.
- ae8c7a8: `ctx.waitUntil` for `scheduled` and `queue` (baronunread/sproutboat#171):
  both now take the same second `ctx` argument as `fetch`, drained the same way.
  
  Also fixes a real bug found while wiring it up: `scheduled` and `queue` were
  fire-and-forget regardless of `ctx` — an async handler's own promise was
  dropped the instant the reply went out. For `queue` specifically, the default
  "unhandled messages are acked" pass ran synchronously right after the
  (discarded) call to the handler, so `ack()`/`retry()` calls made after the
  handler's first `await` never reached the response. Both are now properly
  awaited, on every delivery path: broker-dispatched, and the embedded
  standalone binary's own local cron/queue/DO-alarm timers (the latter had the
  same gap for `DurableObjectState.waitUntil` from #57 — that local path
  bypassed the fix there entirely).
  
  Additive: a handler that ignores the second argument is unaffected.

### Patch Changes

- 5b76f6b: Fix (baronunread/sproutboat#132): the banned-API capability check matched a bare
  identifier (`\bprocess\b`), so a locally-declared `function process()` — zod v4
  declares exactly that — failed the check as readily as a real read of the Node
  global. Now requires a member access (`process.env`, no whitespace around the
  `.`, to avoid matching a sentence like "...unique to this process. The...") or
  `new Buffer(...)`; `node:` now only matches as the start of a quoted string
  (specifier-shaped), not as a substring anywhere. A handler that imports zod (or
  anything built on it, e.g. better-auth) and only uses APIs the compiler
  otherwise supports now passes the capability check and builds.
  
  Not fixed here: zod still throws an uncaught `TypeError` at runtime on
  `.safeParse()` even for the simplest schema (`z.string()`) — a separate,
  deeper Porffor compatibility gap this change does not touch. This fix removes
  an incorrect early rejection; it does not make zod usable end to end.

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

- `crypto.subtle` subset (baronunread/sproutboat#133): `digest` (SHA-256 / SHA-384
  / SHA-512) and HMAC `importKey` / `sign` / `verify` over a raw key. Enough for
  JWTs and hand-rolled sessions; no ECDSA, AES or key wrapping.
  
  Backed by ~300 lines of reference SHA-2 as inline C rather than BearSSL —
  BearSSL links only in `--standalone` builds and the prelude C is shared with the
  broker transport, so a link dependency would break non-standalone builds. Pure C
  is transport-independent and lets a handler drop a vendored pure-JS SHA-256.
  Verified against NIST vectors on both transports; surface is exactly standard so
  it deletes cleanly when Porffor ships Web Crypto (CanadaHonk/porffor#347).
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
- `crypto.scryptVerify(password, salt, expected, { N, r, p })` (baronunread/sproutboat#153):
  a scrypt (RFC 7914) implementation as inline C — PBKDF2-HMAC-SHA256 (reusing
  #133's HMAC) + Salsa20/8 + BlockMix + ROMix.
  
  Deliberately verify-only (re-derive and constant-time compare, no exposed raw
  `scrypt()`): a migration path for password hashes made by Node/Bun `scrypt`
  (e.g. `N=32768 r=8 p=3`), not a KDF blessed for new credentials — those should
  use HMAC/PBKDF2 via `crypto.subtle`. Verified against the RFC 7914 §12 vector.
  `N*r` is capped so a bad config cannot ask for gigabytes of scratch.

### Patch Changes

- Embedded transport: set `PRAGMA busy_timeout=5000` on every connection. Within
  one binary all binding ops are serial so there is no self-contention, but when
  several copies of a standalone binary share a data dir behind `SO_REUSEPORT`
  (the #154 scaling recipe) a writer now waits for the WAL lock instead of
  failing `SQLITE_BUSY`.

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
