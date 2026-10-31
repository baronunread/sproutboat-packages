# @sproutboat/toolchain

## 0.22.0

### Minor Changes

- 4341e6a: A standalone binary can be replaced without resetting a connection. The kernel resets every connection waiting in a listening socket's accept queue when the last descriptor for that socket closes, and a restart used to close it (the old process died, or closed its own `SO_REUSEPORT` listener while the new one came up): about one request in a few thousand was reset at each swap. The native server now keeps the socket alive across a restart and drains the old process:
  
  - It serves on the listening socket it is given when `LISTEN_PID` and `LISTEN_FDS` name it (systemd socket activation, fd 3), instead of binding `$PORT`. `systemctl restart` then stops and starts the service while the socket stays open, so connections wait in the queue.
  - `SIGUSR2` starts the binary now on disk (the running file's path, or `SB_EXEC_PATH`) as a child with the listening socket as fd 3, then drains. The successor waits until its parent has exited before it initialises anything, because a standalone binary holds its SQLite files exclusively. Without systemd this is the same swap.
  - `SIGTERM` and `SIGINT` drain: stop accepting, add `Connection: close` to every response so a keep-alive client stops reusing the connection, and exit once no socket is busy (nothing unread or unsent, no request waiting for its answer, nothing seen in the last `SB_DRAIN_QUIET_MS`, default 200) or after `SB_DRAIN_SECONDS` (default 10). A second signal exits at once. Before, `SIGTERM` killed the process with requests in flight.
  
  uSockets binds through `bsd_create_listen_socket`, which the CLI's standalone build now patches to ask the binary for an inherited socket first (a weak reference, so an unpatched uSockets just never asks). The change is in the native shim only, never `render.js`, so sproutd is untouched, and it does nothing in a binary without the embedded transport, so the broker's sprouts behave as before. Nothing an app can see changes, so there is no new compatibility date.
  
  `SB_MUSL_TARGET` (for example `aarch64-linux-musl`) and `SB_UWS_VARIANT` let the CLI build a musl binary for another architecture and keep a separate uWebSockets tree for it; both are inert when unset. `packages/runtime/test/standalone-restart-stress.py` is the load test: it replaces a binary N times under load and counts failed requests.

## 0.21.3

### Patch Changes

- 541a8ce: A minor collection no longer scans the entries block an object left behind when it grew. This is the object twin of the array fix: the block is garbage, but while it is old only a full collection frees it, and a minor one scanned it whenever a write to a neighbouring block dirtied its card. Its slots still pointed at objects that an earlier minor collection had freed, so the scan marked whatever had reused those blocks as the type the slot claimed (a reused array became a Promise, then SIGBUS or corruption). The abandoned block is now classed as a leaf. The other grow-and-copy sites were audited and need nothing: Map and Set keep their entries in arrays, the weak-object store zeroes its length before it is abandoned, and strings, typed-array buffers and bucket tables hold no references.

## 0.21.2

### Patch Changes

- 7030f76: Database clients that need only fetch or WebSocket (`@libsql/client`, `@neondatabase/serverless`, `@supabase/supabase-js`, `@upstash/redis`, `@planetscale/database`) run unmodified. In the runtime: `fetch()` returns a promise on the standalone binary from the compatibility date that already promises it (2026-10-22), so `fetch(url).then(...)` works and a refused request rejects; a fetched 204, 205 or 304 response no longer throws "Response with null body status cannot have body"; from the proposed compatibility date 2026-11-15 the Node/Bun/Deno global check in the bundle skips a use behind a `typeof` feature test, a global the bundle declares itself, and mentions inside strings and comments, and `Error.captureStackTrace` exists. In the toolchain: a typed array with an underlying object (a `Buffer` polyfill) shadows the builtin methods it redefines, so `buf.toString("utf8")` is the Buffer one.

## 0.21.1

### Patch Changes

- 5a03736: A minor collection no longer scans the entries block an array left behind when it grew. The block is garbage, but while it is old only a full collection frees it, and a minor one scanned it whenever a write to a neighbouring object dirtied its card. Its slots still pointed at objects that an earlier minor collection had freed, so the scan marked whatever had reused those blocks as the type the slot claimed: a reused array became a Promise, and the collector followed its "reaction chain" into unmapped memory (SIGBUS, exit 138) or corrupted what it found. Promise's list of pending rejections is such an array, and it grows whenever a single request rejects more promises than the list has room for; the Durable Object transaction guard (a rejection per refused call) tripped it about 220 requests into the conformance suite on the broker transport. The abandoned block is now classed as a leaf.
- 69c3c91: `TextDecoder` now decodes UTF-16LE, UTF-16BE and windows-1252 (with its `latin1`, `iso-8859-1` and `ascii` labels) besides UTF-8: BOM handling, `fatal`, `ignoreBOM`, lone surrogates and `{ stream: true }` across odd chunk boundaries follow the Encoding standard. Any other label still throws a RangeError. `Blob.prototype.stream()` now exists and returns a one-chunk byte stream, and a `Response` you construct has `url` "" and `redirected` false instead of `undefined`. Found while testing third-party packages.

## 0.21.0

### Minor Changes

- 7a9c1f9: `AsyncLocalStorage` (`import { AsyncLocalStorage } from "node:async_hooks"`, once the CLI maps the import), as Workers has it: `run`, `exit`, `getStore` and the static `snapshot`. `enterWith` and `disable` throw, as there. The static `bind` is not provided: Porffor compiles a `.bind(` call on a function value to `Function.prototype.bind`, so use `snapshot()`. The toolchain patches Porffor's job queue and timers to carry one current-context value: a promise reaction (then, await, a coroutine resume, a native response callback) and a timer record it when they are created and set it when they run, so the store follows a request across awaits, microtasks, timers, intervals, async fetch and WebSocket callbacks and `ctx.waitUntil`, and requests interleaved in one process never see each other's. Cost: a reaction is 56 bytes, not 40, and each job does one load. The context is only ever set by `AsyncLocalStorage`. Nothing an existing app observes changes, so there is no new compatibility date: `node:async_hooks` did not work at any date before (the import built and `new AsyncLocalStorage()` threw). New native test `test:native-async-local-storage` (needs `SB_CLI`).

## 0.20.1

### Patch Changes

- ab867c6: A collection no longer frees the entries of an array that Porffor compiles into its static data and that later grew onto the heap. Promise keeps its pending rejections in such an array: its entries block was swept at every collection while the array still pointed at it, so the next rejection or handled rejection wrote into whatever had reused that block (a string another request had built, an array's slot) and a request could resume to find a string it built before an await had become empty. Porffor's static-array shape check rejected any entries pointer outside the static image, so the entries were never marked. It now accepts a heap block start, as the check for ordinary arrays already did.

## 0.20.0

### Minor Changes

- 7f5e87b: A standalone binary now opens its SQLite databases in `PRAGMA locking_mode=EXCLUSIVE` by default, with the page cache at 2 MB (`cache_size=-2000`, unchanged). The lock is taken once and held, so a transaction no longer takes and releases file locks around itself, and the WAL index lives in heap memory instead of a shared `-shm` file. The cost: no other process can open the database while the binary runs, so the `sqlite3` shell, `sproutboat kv/d1 --local --data-dir` against a running binary, and the several-copies-behind-`SO_REUSEPORT` recipe do not work on a live binary. Set `SB_SQLITE_EXCLUSIVE=0` to opt out and keep shared locking. A database under LTX replication is never opened exclusive.
  
  The default belongs to the standalone binary only: the toolchain's native server shim sets `SB_SQLITE_EXCLUSIVE=1` at startup unless the variable is already set. The embedded transport itself reads only `SB_SQLITE_EXCLUSIVE` (`1` is exclusive, anything else is shared), so sproutd and the broker keep shared locking unless an operator sets it.
  
  `SB_SQLITE_CACHE_MB=<n>` (1 to 4096) sets each database's page cache in MiB; unset it stays at 2 MB.

### Patch Changes

- 004b8e7: A request's fixed cost in a native sprout drops five items. The CPU stamp and the streamed-body probe come back as numbers instead of formatted and parsed text (a `printf` and a `parseFloat` each, per request). The ingress reads of `x-sb-trigger` and `x-sb-remote-addr` scan the stored header names instead of validating and lowercasing a name for each, and the three `x-sb-` names the runtime strips are looked for in one pass. `SB_EDGE_TOKEN` is read once. `Headers` checks a name and a value in C and only falls back to its regular expression for a name it cannot judge there, so `get`, `has`, `set`, `append` and `new Response(body, { headers })` stop compiling that expression on every call. Behavior is unchanged.
- beebad1: A standalone binary writes a response's plain-ASCII header names, header values and body straight from the JavaScript heap. The native server used to copy each of them into a `malloc`ed UTF-8 buffer one byte at a time, twice for every header and once for the body: about 5% of the CPU of a 4 KB reply. A bytestring whose bytes are all below 0x80 already is its UTF-8 text, so it is now read in place; a UTF-16 string or a byte of 0x80 or more takes the same copying path as before. The change is in the native shim only (`compiler/uwebsockets.js`); `render.js`, and so sproutd, is untouched.

## 0.19.5

### Patch Changes

- 836640e: `JSON.stringify` hands back an 8-bit string when every character fits in one byte (it always returned UTF-16), and a plain string that needs no escape no longer takes a 4 KiB zeroed buffer. A response built from `JSON.stringify` pieces stays 8-bit, so concatenating it copies half the bytes and the server writes it without re-encoding each unit. The characters are unchanged (`test:native-json` and `test:native-json-strings` pass).

## 0.19.4

### Patch Changes

- 5bd4a25: Cheaper JWT verification. `atob` decodes in C for the usual input (no whitespace, valid characters, correct padding) and falls back to the existing JavaScript for everything else, so what throws and what it throws is unchanged. `TextEncoder.encode` sizes and fills the Uint8Array in two C passes instead of two `charCodeAt` loops (a lone surrogate is still U+FFFD). The ArrayBuffer returned by `crypto.subtle.sign` and `digest` is copied in with one `memcpy`, and the constant-time compare behind `verify` runs in C. A typical `authenticate()` (three base64url decodes, two `JSON.parse`, one `TextEncoder.encode`, one HMAC verify) goes from 21.5 to 7 us on an M-series host. New native test `test:native-jwt`: RFC 4231 HMAC vectors, the RFC 7515 and jwt.io tokens, wrong key, tampered header, payload and signature, short, long and missing signatures, bad base64url, typed-array windows and ArrayBuffers as verify input, and seeded random `atob`, `TextEncoder` and HMAC (SHA-256, 384, 512) inputs compared with Bun and node:crypto.
- 8ac6917: A standalone binary collects garbage every 8 requests, and once it has been quiet for about 50 ms, instead of after every response. A collection costs about the same whatever the request made, so a cheap request paid all of it: on the API-challenge mix at 900 req/s the CPU per request goes from about 550 to about 470 us, and the feed endpoint from 940 to 750 us, for about 2 MiB more resident memory. `SB_GC_EVERY=<n>` sets the interval (`1` restores a collection after each request). A request that needs more heap than is free still collects when it allocates. Only the standalone server's shim changes: sproutd's collector, and its density, are untouched. New native test `test:native-http` covers keep-alive, pipelining, split requests, large bodies, partial writes and many connections at both intervals.

## 0.19.3

### Patch Changes

- 7767f05: Faster `JSON.stringify` of strings: each character is read straight from the string and stored when it needs no escape, instead of a `charCodeAt` call per character. Quotes, backslashes, control characters and every surrogate still take the escaping branches, so the output is byte-identical to the spec's (new native test `test:native-json-strings`: control characters, DEL, U+2028 and U+2029, Latin-1, BMP and astral text, lone and misordered surrogates, as values, keys, array items and nested, compared with Bun).

## 0.19.2

### Patch Changes

- a0ba6a3: Faster requests: about 57% of a request's CPU was Porffor's `globalThis` getter.
  
  - **Toolchain, the root cause.** Porffor's `#get_globalThis` re-synced every top-level function and `var` of the module into the global object on every read, one hashed write per binding (about 20 µs with the prelude's ~120 bindings, so every `globalThis.x` in user code paid it too). Every binding is now written when the object is built, and a later read rewrites only the bindings whose value changed (a packed copy of the last value written is kept per binding: an unchanged binding costs one compare). 20,000 reads with 600 top-level functions: 9,300 ms before, a few ms after.
  - **Runtime and toolchain, the request path.** The runtime's `globalThis.__sbCompat` / `globalThis.env` reads go through accessors over module-level `let`s that the app tail sets once, and `Request`/`Response` cache the class lookups and take the date and WebSocketPair state from statics the runtime sets. Until the tail has run (the shared template, unit tests) everything reads `globalThis` as before.
  - **Client IP.** `request.cf` no longer reads and splits `SB_TRUSTED_PROXIES` four times a request: it is read once per process, and with no trusted proxy (the usual case) the peer is the client and the forwarded-header lookups are skipped.
  - **`x-sb-cpu-ms`.** The stamp is appended to the handler's own Response instead of building a second Response with a copy of every header. The same responses are stamped, with the same headers and body.
  
  A 404 on one pinned x86 core, CPU per request when saturated, standalone: 319 µs before, 127 µs with the getter patch alone, 113 µs with the request-path change, 81 µs with the client-IP and stamp changes.

## 0.19.1

### Patch Changes

- e62b72d: An unhandled promise rejection no longer ends the process. A D1 call that failed and was never awaited (`db.prepare("INSERT ...").run()` that broke a foreign key) threw its error out of Porffor's promise job loop into the host's "Uncaught ..." exit, taking every in-flight request down even with a try/catch around the call. As on Workers it is now reported: a log line (`Uncaught (in promise) ...`) and an `unhandledrejection` event (`PromiseRejectionEvent` with `promise` and `reason`) on the global scope when `addEventListener("unhandledrejection", ...)` has a listener, and the process and other requests carry on. This applies at every compatibility date, because a crash is a bug rather than a behaviour an app can depend on. The toolchain's `patchUnhandledRejections` calls the runtime's `globalThis.__sbOnUnhandledRejection`; plain Porffor without it keeps the throw. Applies to every binding call that returns a rejecting Promise (D1, KV, R2, Durable Objects, Queues, fetch). An un-awaited `async function` that throws is reported the same way (it used to be dropped silently): the C runtime that rejects it now hands the promise to the same check.

## 0.19.0

### Minor Changes

- 85ec3fe: WebSockets on every host, and outbound WebSockets, from compatibility date `2026-11-01`:
  
  - **Client sockets on standalone and platform sprouts.** The native server (toolchain) carries the client end of a 101 response: it upgrades the connection, passes text and binary messages both ways, applies the 1 MiB read window, caps messages at 32 MiB (1009), and answers a close with the code and reason. A message the app sent before the 101 goes out right after it, and the app's `Sec-WebSocket-Protocol` is the one the client gets. Before 2026-11-01 these sprouts still answer a 101 with 501 (sproutd, which sets `sb_ws_hook` itself, carries them from 2026-10-30). The toolchain needs `@sproutboat/runtime` 0.33 or later.
  - **Outbound WebSockets.** `new WebSocket(url, protocols)` (CONNECTING, then `open`, as in a browser) and `fetch(url, { headers: { Upgrade: "websocket" } })`, whose Response carries the connected socket as `response.webSocket` (call `accept()`); a server that answers the upgrade with another status is the Response. `ws`, `wss`, `http` and `https` URLs. Returning that Response from a handler relays the client's socket to the upstream. One I/O thread per socket (up to 64) connects through the egress policy, does TLS with BearSSL, and wakes the loop through the async pipe (sproutd) or the server's waker (standalone). On the embedded transport (standalone, sproutd); the broker transport (platform, `sproutboat dev`) answers `fetch` upgrades with a rejection for now.
  - `validateHttpSyncSource(source, compatibilityDate)` accepts `WebSocket(` from 2026-11-01 and keeps refusing it before.
  - **Hibernation, on a host that keeps client sockets open while the worker is gone (sproutd).** A Durable Object's hibernatable socket (`ctx.acceptWebSocket`) is recorded in storage scoped to the object (its id, tags, attachment, and the object's auto-response, kept current by `serializeAttachment` and `setWebSocketAutoResponse`), so the host may stop the worker while the socket is idle. When a message or close arrives, a new worker constructs the object again with `ctx.getWebSockets()` listing its sockets (tags and attachments intact) from the start of the constructor, and the event runs as `webSocketMessage` or `webSocketClose`. Socket ids are random. A host without this (standalone, platform) keeps every socket resident, as before.

## 0.18.0

### Minor Changes

- 25f9f05: Faster string building in compiled apps. A loop of `s += e;` statements on a function's local string variable now appends into the string's spare room instead of copying the whole string every time, so building a string is linear instead of quadratic: a compile-time pass gives the variable a hidden ownership flag, and any other read or write of it ends the in-place run (and gives spare memory back first, so a string that outlives its loop costs what an exact copy would). `replace(regex, fn)` with a global regexp finds its matches as positions instead of exec result objects and joins the pieces once (it also copied the whole result per match), as does `replace(regex, "$&...")`. `charCodeAt` with an in-range number index and `JSON.parse` read characters directly. On sproutd's regex-scan benchmark, plain Porffor goes from 5.5 to about 1.2 ms per call on an M1. Generated programs change, so compiled apps get a new toolchain fingerprint.

## 0.17.0

### Minor Changes

- 90434e0: WebSockets, from compatibility date `2026-10-30`, as in workerd:
  
  - **`WebSocketPair` and `WebSocket`.** `accept()`, `send()` (text, `ArrayBuffer` or a typed array), `close(code, reason)`, `readyState`, `binaryType` (binary messages are `Blob`s unless it is `"arraybuffer"`, workerd's standard binary type), `addEventListener` and `on<type>`. Messages sent before the other end accepts wait for it; each message is delivered in its own turn, so a reply reaches the other end before the next message, as in workerd. A close is answered automatically; invalid close codes throw `InvalidAccessError`, reasons over 123 bytes `SyntaxError`. Checked against workerd 1.20260730 (`test/native-websockets.ts`).
  - **`new Response(null, { status: 101, webSocket })`** and `response.webSocket` (`null` when there is none). Any other status with a `webSocket` throws `RangeError`, as in workerd.
  - **Durable Objects: the hibernation API.** `ctx.acceptWebSocket(ws, tags)`, `getWebSockets(tag)`, `getTags(ws)`, `setWebSocketAutoResponse` / `getWebSocketAutoResponse` with `WebSocketRequestResponsePair`, `serializeAttachment` / `deserializeAttachment`, and the `webSocketMessage` / `webSocketClose` handlers, run through the object's input gate.
  - **Client sockets.** The client end of a 101 response becomes a real socket on a host that carries it (sproutd, which sets the runtime's `sb_ws_hook`). A standalone or platform sprout answers such a response with `501` for now; a pair whose ends both stay in the worker (a Worker and its Durable Object) works everywhere.
  
  Before `2026-10-30` nothing is defined and `response.webSocket` stays `undefined`.

## 0.16.1

### Patch Changes

- 6f140b2: Faster allocation-heavy handlers on native-fetch builds: a collection after a request no longer unmaps the heap above its top. It keeps 16 MiB there, as plain Porffor does, and the idle collection still trims it. On othello, regex-scan made about 3,600 page faults per request and spent 17 ms more per request than the same code in the handler. Compiled apps get a new toolchain fingerprint.

## 0.16.0

### Minor Changes

- 7cc35f4: Smaller idle sprouts: the idle collection now returns every free heap run to the OS, not only runs of 256 KiB or more, so a small sprout gives back its request garbage once it goes quiet. Adds `porf_gc_seal_heap()`, which sproutd's fork template calls before fork so workers allocate in fresh pages instead of copying template pages (sproutd #32). Generated programs change, so compiled apps get a new toolchain fingerprint.

## 0.15.0

### Minor Changes

- a185ede: Add a versioned native bytes ABI for a trusted offline LTX restore build. The
  compiler rejects every adapter builtin unless the builder explicitly sets
  `--sb-native-bytes-v1`. Ordinary app builds never enable this flag. No runtime
  compatibility date changes: the feature is a build-only opt-in, and unused
  programs receive no helper bodies.
  
  The lazy builtins validate fixed Uint8Array views, bounded positioned I/O and
  file-control operations. CRC64 reuses `sb_ltx_crc` from the actual embedded
  transport being compiled; a missing provider fails compilation. Layout and
  patch guards fail on unexpected compiler changes. The patch fingerprint changes,
  so native hosts must regenerate and requalify before adoption.
  
  AI assistance: OpenAI Codex (GPT-6.1).

## 0.14.0

### Minor Changes

- 829ed12: Request bodies stream, from compatibility date `2026-10-27`, as in workerd:
  
  - **Ingress.** The native server runs the handler as soon as a request's headers arrive. `request.body` hands out the bytes as they come in, and the server pauses the socket while more than 1 MiB waits unread, so a large upload read through the stream keeps memory flat (a 128 MiB upload peaks at 38 MiB RSS). `text()`, `json()`, `arrayBuffer()` and `bytes()` read the whole body and return Promises.
  - **Limit.** `SB_REQUEST_BODY_MAX` defaults to 100 MiB for streamed bodies (it stays 1 MiB before the date, where the body is held in memory whole). A larger `Content-Length` gets `413 Payload Too Large` before the handler runs; a chunked body that grows past it closes the connection, and the handler's stream fails.
  - **Service bindings and `fetch()`.** On the broker transport, a `ReadableStream` request body goes out as it is read, in `FRAME_V1_MORE` frames after the request's head, instead of being read to the end first. The broker feeds them to the upstream request as a stream (with backpressure) and says so in its `ping` reply (`bodyStream: true`); against an older broker, bodies are sent whole as before. A streamed body can't follow a 307 or 308 redirect.
  
  Internal trigger and RPC calls keep buffered bodies. Before `2026-10-27` nothing changes: the handler gets the whole body at once and `request.text()` answers synchronously, which a deployed handler may rely on, hence the new date.

## 0.13.0

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

## 0.12.1

### Patch Changes

- 1ff15e6: Keep heap-backed BigInts alive during conservative garbage collection. The native scanner now recognizes the encoded floating-point pointer used by BigInt arithmetic, preventing crashes and incorrect checksums in workloads such as CRC64 and LTX encoding.

## 0.12.0

### Minor Changes

- feba29b: Upgrade the verified vendored Porffor pin to Alpha 19 (`0c135ce`). Alpha 19 brings `Map.groupBy`, private names that stay out of `Object.keys`, `for-in` and `JSON.stringify`, `JSON.stringify` throwing on cycles, a spec `JSON.parse` reviver (with source text), spec ISO date parsing, spec base64 and hex on `Uint8Array`, typed-array `toString` tags, the `Error.prototype.stack` accessor, spec `instanceof`, `+` and template literals converting objects with ToPrimitive, sloppy functions boxing a primitive `this`, unresolvable names read from the global object, `with`, and many String, Date, Function and Object spec fixes. These move compiled handlers closer to V8 (Workers), so they are not gated on a compatibility date, as with earlier Porffor upgrades.
  
  Seven downstream workarounds are dropped because upstream now does the same thing, each proven by its native test without the patch: the ISO date offset parser, the base64 option tags, `Map.groupBy` and non-enumerable private fields (sproutboat#286), the `JSON.stringify` cycle check, the `JSON.parse` reviver, and the typed-array `toString` tag. The Unicode JSON patch is re-anchored on the new `JSON.parse`: upstream now rejects trailing input itself, and the reviver's source-text records keep UTF-16 text. The #256 class self-name rewrite is kept (Alpha 19 still has the bug) and now places its synthesized read after the class, so Alpha 19's new TDZ check does not reject it. #287 (GC page discard), B16 (`repeat`), #237 (`replaceAll`), #168 (promise resolving to `null`) and the local function types patch are still needed.
  
  One patch is new: Alpha 19 added a `new Function` source specialization that walked the whole program twice per top-level function, so compiling the runtime prelude took 3.7 s instead of 0.6 s before any C was generated. The patch checks the function body first; the generated code is byte-identical.

## 0.11.0

### Minor Changes

- 85aa74d: Service-binding calls and outbound `fetch()` no longer block a deployed sprout. In a deployed sprout, each call runs off the event loop on one I/O thread, so the sprout keeps answering other requests while a call is in flight. Concurrent calls overlap: eight 500 ms calls finish in about 510 ms, where they used to queue for about 4 s. A deployment can also call itself through a binding, to any depth, where this used to deadlock. The toolchain installs the loop hook the runtime uses for this; with an older runtime it does nothing.
  
  `env.SERVICE.fetch()` now always returns a promise, as in Workers, and reads its arguments as `fetch()` does:
  
  - a `URL` object works as input;
  - `fetch(request, init)` keeps the request's body when `init` sets no body of its own;
  - a `ReadableStream` body is sent whole, where it used to arrive as the text `[object ReadableStream]`.
  
  Responses from bindings and from `fetch()` keep every `Set-Cookie` header, where they used to keep only the last one.
  
  A broker exchange is now resent only when the broker cannot have acted on it: the request never fully left, or the connection had gone stale. A `fetch` or service call that the broker may already have run is no longer repeated.

## 0.10.2

### Patch Changes

- bc3fd25: `Response.body` and `Request.body` are `ReadableStream`s only from compatibility date `2026-10-21`. 0.19.0 changed this for every app, which broke handlers that read `request.body` as a string, such as `JSON.parse(request.body)` in the CLI's own D1 example. An app with an earlier `compatibility_date` keeps the raw body, as before. To opt in, move `compatibility_date` to `2026-10-21` or later and rebuild.

## 0.10.1

### Patch Changes

- 6676ead: `env.BUCKET.put(key, request.body)`, `env.KV.put(key, request.body)` and `fetch(url, { body: request.body })` store and send the request body again. Since 0.19.0, `body` is a `ReadableStream`, and these took its string form. Incoming request bodies are also read as the bytes they are, so `arrayBuffer()`, `blob()`, `body` and KV `put` no longer UTF-8 encode a non-ASCII upload twice. R2 `put` accepts bytes as well.

## 0.10.0

### Minor Changes

- 4274bef: `Response.body` and `Request.body` are `ReadableStream`s for every body type, as in the Fetch spec and workerd. Before, they held the value given (a string, bytes or a `Blob`). `res.body.getReader()`, `res.body.pipeThrough(...)` and `new Response(other.body)` now work on any response, including the incoming request. The value as given stays internal, so responses are still written with a fixed length unless the body really is a stream. A body whose stream has been locked can no longer be read with `text()` and the other readers, which throw a `TypeError`.

## 0.9.0

### Minor Changes

- 2541458: More of the Web platform, from sproutd's W2 conformance suite against workerd:
  
  - `CompressionStream` and `DecompressionStream` for `gzip`, `deflate` and `deflate-raw`, in JavaScript, because the native runtime links no zlib. Output decompresses with zlib, and zlib's output (stored, fixed and dynamic blocks) decompresses here. A corrupt or truncated input errors with a `TypeError`.
  - A `Response` or `Request` whose body is a `ReadableStream` is read to the end by `text()`, `json()`, `arrayBuffer()` and `blob()`. Before, these returned `"[object ReadableStream]"`. Chunks must be bytes, as in workerd.
  - `JSON.parse` applies its reviver: children first, `undefined` deletes the property, and `this` is the holder.

## 0.8.1

### Patch Changes

- 742e61c: A CLI compiled with `bun build --compile` builds again. 0.8.0 embedded the patch sources with text imports to fingerprint them, but Bun bundles a text import of `patch.ts` as the module `patch.ts` is everywhere else, so compiling failed with `No matching export ... for import "default"`. The fingerprint now hashes the sources when they are on disk, and falls back to the fingerprint they were released with (`RELEASED_FINGERPRINT`, kept current by a test). The value is unchanged, so existing caches stay valid.

## 0.8.0

### Minor Changes

- 9fdf3fa: Upgrade the verified vendored Porffor pin to Alpha 18 (`deda494`). Alpha 18 brings spec BigInt arithmetic and bitwise operators, iterator helpers, Set methods, `Array.fromAsync`, Atomics, resizable ArrayBuffers, explicit resource management, a rewritten Temporal, an on-demand Intl polyfill, and many RegExp, Promise and Object spec fixes. Three downstream workarounds are dropped because upstream now covers them: the typed-array read and write bounds checks (#238, #241), the `toJSON` step in `JSON.stringify` (Alpha 18 also adds the replacer argument), and the Web Streams adapter for dynamic array iterator lookup. The remaining patches are unchanged.
- 6e88627: Standalone sprouts stream `ReadableStream` response bodies. The status and headers go out as soon as the handler returns, and each chunk reaches the client as it is produced (chunked encoding), so Server-Sent Events, progress output and long responses work. A client that disconnects cancels the stream. Hosts without the streaming server (sproutd's workers, for now) still read the stream to the end and send it buffered.

### Patch Changes

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
- 853f8c9: `console.log` colours values only when stdout is a terminal. Piped or redirected output, like sproutd's per-app logs or a standalone sprout's output collected by a service manager, no longer contains ANSI escape codes such as `\x1b[33m42\x1b[0m`.
- 262690d: Allocation-heavy handlers are up to 4.5x faster in standalone sprouts (a regex scan went from 140 to 31 ms per request). Full garbage collections under load no longer return free pages to the OS, which made the next allocations fault them back in; the idle collection returns them instead, now also for small sprouts that never reach a full collection. Memory after 3 s idle is unchanged; during traffic a sprout keeps more of its heap (baronunread/sproutboat#287).
- ddb0f9d: Response, Request and Blob follow the Fetch spec, and binary bodies reach the client intact:
  
  - A `Uint8Array` or `ArrayBuffer` response body is sent as its bytes. It was sent as text: `new Response(new Uint8Array([104, 105]))` reached the client as `104,105`, and an `ArrayBuffer` as `[object ArrayBuffer]`.
  - `Response` has `statusText`, `type`, `bodyUsed` and `Response.error()`. A status outside 200–599 throws `RangeError`, a body with 101/204/205/304 throws `TypeError`, and `arrayBuffer()`/`text()` handle byte bodies (UTF-8 both ways).
  - `Request` normalizes its URL and rejects relative or invalid ones, has `redirect` and `bodyUsed`, rejects a body on GET/HEAD, and sets the default content type for string and `URLSearchParams` bodies.
  - A body can be read once: a second `text()`/`json()`/`arrayBuffer()`/`blob()` throws `TypeError`.
  - `Blob` holds bytes, with `size`, `type`, `slice` (negative indices too), and promise-returning `text`/`arrayBuffer`/`bytes`. `File` exists. `FormData` stores a `Blob` value as a `File` named by its filename, and `new Response(formData)` sends multipart/form-data.
- 50bea68: `Map.groupBy` works (it threw a TypeError), and private class fields (`#x`) no longer show up in `Object.keys`, `Object.entries`, `for...in` or `JSON.stringify`. Porffor stores a private field as an ordinary property named `__#x`; it is now installed non-enumerable, like a method, so `Object.getOwnPropertyNames` still lists the internal name (baronunread/sproutboat#286).
- 6d6ae43: `Headers` is iterable (`new Map(headers)`, `[...headers]`, `Object.fromEntries(headers)`), and `new Headers([["name", "value"]])` reads the pairs instead of producing headers named "0", "1"...
- 2a4d70d: Builds are about 1.3 s faster, and parallel builds no longer fail with `PrecompiledBuiltins.BuiltinFuncs is not a function`. Every compile re-ran the patch chain on the shared compiler cache, and its builtin precompile rewrote `builtins_precompiled.js` in place, so a concurrent build could import a half-written table. A cache entry patched by the same toolchain version is now used as is.
- 4c25aa2: The Porffor cache entry is keyed by a fingerprint of the patch chain as well as the toolchain release. A patch edit that ships under the same version now gets a freshly patched compiler, instead of reusing an entry an older chain marked complete. Builds against such an entry failed to link once the runtime began calling `sb_stream_*`. Old entries stay on disk and are no longer used.
- ec5d49f: A sprout that returns a `fetch()` response unchanged (`return fetch(url)`, or a proxy) sends its body again. The body could reach the server as a UTF-16 string, which the raw-bytes reader rejected, so the client got an empty body with the upstream's headers.
- 5859a82: Reclaim large native heaps after 500 ms without a completed request, and release oversized GC mark-queue scratch storage. Preserve the existing request collector and live application state. Extra collection is limited to heaps over 8 MiB or mark queues over 65,536 entries.
- 56b9ba6: `String.prototype.repeat` copies in doubling chunks instead of once per repetition: repeating a 600 KB string went from about 2.4 ms to under 0.1 ms.
- 4c78d83: Match the Fetch spec and workerd for common responses: string bodies default to `text/plain;charset=UTF-8`, `Response.json` sets `application/json`, and `Response.redirect` serializes its URL (`https://example.com` becomes `https://example.com/`) with a null body.
- 088cad0: Shared-object (split) builds no longer crash on start or lose the Web Streams classes.
  
  - **Toolchain:** split output prefixes module globals with `pg_`. A global named like a libc symbol (the prelude's `clone`, or an app's `hash` or `search`) bound to libc instead, so the runtime wrote into libc's code and every worker crashed. Internal `__` globals keep their names. Standalone builds are unchanged, because their globals are `static`.
  - **Runtime:** the Web Streams polyfill installs each class with its own `globalThis.X =` assignment. Where the prelude is a separate unit, Porffor resolved `new ReadableStream()` in app code at compile time and, seeing only a dynamic install, compiled it to a ReferenceError. `gen-streams.ts` now fails if an export of the polyfill is not installed.
- 28b0c39: `URL` behaves like the WHATWG URL: `new URL(path, base)`, setters for every part (`url.hostname = ...`, `port`, `protocol`, `host`, `search`, `hash`, `href`), default ports dropped, dot segments resolved, percent-encoding, `URL.canParse`, and `searchParams` changes written back into the URL. `JSON.stringify` calls `toJSON`, so a `Date` serializes as its ISO string (it was `{}`) and a `URL` as its href.
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

## 0.7.0

### Minor Changes

- 14546a0: Upgrade the verified vendored Porffor pin to Alpha 17, including correct Math.round ties and signed zero, native number parsing and formatting, full console number precision, and class-field capture fixes. Keep downstream compatibility patches until equivalent upstream changes ship.

### Patch Changes

- 14546a0: Register direct-only local function expressions in their lexical scope so type inference does not borrow an unrelated same-named function's return type. Fixes Better Auth's model-name resolver incorrectly treating an existing user schema as missing.

  Correct Uint8Array base64 option string tags and complete-chunk truncation, unblocking base64url signatures and fixing padding and decoding.

## 0.6.0

### Minor Changes

- Pin and vendor Porffor alpha-16 (43087d4). Enable Proxy and revocable Proxy in handler validation, add native regression coverage for traps and iterators, and drop three typed-array patches now implemented upstream. See PORFFOR_ALPHA16.md for the complete change audit and remaining package compatibility limits.

## 0.5.0

### Minor Changes

- 16f9b79: Pin and vendor Porffor alpha-15 (`72d048d`). Alpha-14 and alpha-15 bring stackless coroutines, iterator support, class hoisting and typed-array fixes. Three Sproutboat patches are dropped because upstream now covers them: the typed-array store and `~` conversions (#238) and the coroutine stack size (#178). The #241 write-bounds guard is re-anchored. uWebSockets stays on the same commit and the compatibility suite is unchanged at 30/32. See `PORFFOR_ALPHA15.md`.

### Patch Changes

- bf4ac00: Named class expressions work inside handlers again (baronunread/sproutboat#256). Inside a function, Porffor gave a class expression's own name, as seen from its methods, a new function object instead of the class, so `var R = class l { static lex() { return new l() } }` failed with "value is not a constructor". Every handler has run inside a function since #238, and bundlers emit this shape for any class whose static members refer to themselves, so marked and similar packages broke. A parse-time rewrite turns such a class into the equivalent `(() => { const l = class { ... }; return l; })()`, which Porffor handles correctly.
  
  The ISO date parser no longer reads one byte past the end of the string. When that byte happened to be `+` or `-`, a timezone offset's sign flipped, so `-00:30` could parse as `+00:30` depending on what sat next in memory.

## 0.4.24

### Patch Changes

- 9225026: `join()` and `toString()` work on typed arrays (baronunread/sproutboat#242). Porffor generates typed-array methods from the Array ones by replacing `any[]` with the array's type, which also retyped `join`'s internal helper array. `new Uint8Array([1,2]).join("-")` returned garbage, and a three-element `Uint16Array.join` crashed. The generator now keeps that helper a plain array.

## 0.4.23

### Patch Changes

- a479611: Typed-array writes outside the array are ignored, as the spec requires, instead of overwriting the next allocation in memory (baronunread/sproutboat#241). `a[length] = x`, `a[-1] = x` (which wrote `a[0]`) and `a[1.5] = x` no longer touch any memory. The check uses the same index validation as reads and applies to user code; Porffor's own builtins write within bounds.

## 0.4.22

### Patch Changes

- 184fa15: Two more spec fixes for uuid (baronunread/sproutboat#238):
  - **Unary `~`** now applies ToInt32 (wrapping modulo 2^32) instead of a saturating conversion. `~x` for `x >= 2^31`, the `~~x` truncation idiom and `~Infinity` were all wrong, which broke uuid's SHA-1.
  - **Typed-array reads** with an index outside the array, or a negative or fractional index, return `undefined` instead of reading neighbouring memory. uuid's v5 UUIDs used to change from run to run because its SHA-1 reads past its buffer. The check applies to user code; Porffor's own precompiled builtins keep their reads.
- d03abed: `TypedArray.prototype.set(source)` without an offset copies to index 0 (part of baronunread/sproutboat#238). Porffor computed the offset as `Math.trunc(undefined)`, which is NaN, so a same-type copy wrote nothing where it should and went to the wrong place in memory instead. This dropped HMAC keys in @noble/hashes and killed the process after the first request. The offset now goes through `ToIntegerOrInfinity` as the spec says. @noble/hashes' SHA-256 and HMAC match Node and keep serving.

## 0.4.21

### Patch Changes

- 1b80c4b: Integer typed-array stores wrap modulo 2^n as the spec requires, instead of saturating (part of baronunread/sproutboat#238). Porffor converted the stored value with a saturating float-to-int conversion, so `uint32[i] = x | 0` stored 0 for any negative `x`, `int32[i] = 4e9` stored 2147483647, and `fill`/`set`/`from` had the same bug. This broke pure-JS hashing such as @noble/hashes' SHA-256, which now matches Node.

## 0.4.20

### Patch Changes

- 0cdd803: `String.prototype.replaceAll` is linear instead of quadratic (baronunread/sproutboat#237). Porffor grew the result with one full-copy `strcat` per match; a patch to `compiler/builtins/string.ts` collects the pieces and joins them once. Replacing in a 2.1 MB string went from about 42 s to 71 ms (Node: 36 ms), with identical output.

## 0.4.19

### Patch Changes

- 872198d: Standalone binaries accept HTTP/1.0 requests instead of answering 505 (baronunread/sproutboat#236), so they work behind nginx's default `proxy_http_version 1.0`. uWebSockets only parsed `HTTP/1.1` request lines. A helper now edits its `HttpParser.h` before each native-fetch compile to accept `HTTP/1.0` and mark the request as ancient, which makes uWebSockets close the connection after the response, as HTTP/1.0 expects.

## 0.4.18

### Patch Changes

- e0d0e17: Compile every unit with `-ffp-contract=off` (baronunread/sproutboat#235). On arm64, clang fused `a * b + c` into a single FMA that rounds once, where JavaScript rounds after the multiply and again after the add, so native sprouts could compute different doubles from V8 for the same code. A seeded LCG diverged at step 23.

## 0.4.17

### Patch Changes

- 2cda218: Fix async handlers failing permanently with `TypeError: Cannot get property of null` after a few requests (baronunread/sproutboat#168). Porffor represents `null` as an object-typed value with pointer 0, so a promise resolving to `null` went through the `then` probe and looked `then` up at memory offset 0. Once `Date.prototype.toISOString` had written there, the probe matched, read `null.then` and rejected, and every later async function returning `null` failed the same way. A patch to `compiler/builtins/promise.ts` keeps `null` out of the probe.

## 0.4.16

### Patch Changes

- 7bab275: Pin and vendor Porffor alpha-13 (`547c781`). Alpha-11 to alpha-13 bring array, typed array and module codegen fixes, a basic `RegExp` search, a `String.prototype.normalize` stub and lowercase JSON hex escapes. Every Sproutboat patch applies unchanged, uWebSockets stays on the same commit, and the compatibility suite is unchanged at 30/32.

## 0.4.15

### Patch Changes

- c9f84ac: Raise Porffor's per-coroutine fiber stack from 256 KiB to 8 MiB. A large async handler compiled at -O0 (`sproutboat dev`) overflowed it within a few nested awaits and died with SIGBUS on its first request (baronunread/sproutboat#178). Only touched pages cost memory.

## 0.4.14

### Patch Changes

- 6c1f605: Pin and vendor Porffor alpha-10 (`08ac7ee`). Update the compiler patches for UTF-16 JSON strings, surrogate-pair UTF-8 encoding, and `TextEncoder.encodeInto` character boundaries. Verify native Unicode and date behavior against the new source.

## 0.4.13

### Patch Changes

- bb1b6a2: Parse ISO date timezone offsets correctly in native Porffor builds, including zero fields and fractional seconds.

## 0.4.12

### Patch Changes

- ed9640a: Point Porffor patch diagnostics, runtime comments, and historical notes to the
  shared upstream notes in the Sproutboat platform repository.
- b6cc9e6: Pin Porffor alpha 9, including alpha 8's compiler and GC fixes and alpha 9's ESM module support. Adapt the native-fetch link and compile-flag patches to Porffor's split C-unit build. Preserve the published 0.4.11 `TypedArray.from` workaround, which alpha 9 still needs. Re-vendor the verified alpha 9 source archive. The uWebSockets commit is unchanged.

## 0.4.11

### Patch Changes

- 6d72af7: Fix `TypedArray.from` with array-like inputs in native binaries and
  regenerate Porffor's builtin table after the source patch, including when
  the compiler is unpacked through a symlinked temporary path.

## 0.4.10

### Patch Changes

- df11cef: Bump the pinned Porffor commit to the `alpha-7` tag. All local patches
  (render.js, uwebsockets.js) verified against the real alpha-7 source via
  `ensurePorffor()` — no anchor drift, full test suite green. `UWS_COMMIT`
  unchanged, no uWebSockets re-vendor needed.

## 0.4.9

### Patch Changes

- f070d70: Revert native R2 transfer size-gating (#202). It saved ~11KB of `__text`
  (~1.3% of a typical binary) and on macOS didn't even change the shipped
  file size, since `__TEXT` is page-aligned. Not worth the `#ifdef`
  guard-placement bug class it introduced. R2 transfer support is native code
  again, always compiled in with 404 stubs where unused, same as before #202.

## 0.4.8

### Patch Changes

- Republish under a new version: npm registry stuck 0.4.7 in a conflicted staged state after an interrupted OIDC trusted-publish attempt. No code changes from 0.4.7.

## 0.4.7

### Patch Changes

- ba5a6a0: Keep the normal native-fetch request handler outside the optional direct R2 transfer compiler guard.

## 0.4.6

### Patch Changes

- a357b91: Compile direct R2 transfer support only into artifacts that declare an R2 binding.

## 0.4.5

### Patch Changes

- 5ee065c: Stream standalone direct R2 byte ranges safely and support ETag conditionals.

## 0.4.4

### Patch Changes

- d8b7877: Add native standalone R2 direct-download tickets with bounded, backpressure-aware
  file reads, including upgrades for existing patched Porffor caches.

## 0.4.3

### Patch Changes

- 0b0a666: Add a native standalone R2 direct-upload bridge that streams transfer-ticket
  request chunks to a temporary blob file, validates the digest, and atomically
  publishes the object without buffering the upload in the Porffor request body.

## 0.4.2

### Patch Changes

- fa09d90: Update the pinned Porffor compiler to alpha 6 and remove the superseded local promise-resolution workaround.

## 0.4.1

### Patch Changes

- 969add9: Fix (baronunread/sproutboat#168): a `fetch` handler that resolves a promise
  with a plain object — the common shape for a JSON response — could wedge a
  standalone/native-fetch build at 100% CPU after a handful of requests, with no
  error and no log line. Root cause: `__Porffor_promise_resolve`'s duck-typing
  probe for `.then` walks the value's prototype chain with no termination
  guard, and under certain allocator conditions the walk hits a fixed point
  instead of `null`/`undefined`, spinning forever.
  
  `patchPromiseTs` now guards the probe the same way `_internal_object.ts`'s own
  prototype-chain walks already do elsewhere in the runtime: track the previous
  prototype and stop once the "next" pointer stops advancing, reading a
  fixed-point chain as "no `.then` found" instead of spinning. Not specific to
  `Date.prototype.toISOString()` — an earlier note wrongly correlated the bug
  with that one call; see `https://github.com/baronunread/sproutboat/tree/main/patches/upstream`.

## 0.4.0

### Minor Changes

- 69bfe69: Vendor the pinned Porffor commit tarball (`packages/toolchain/vendor/`) so `ensurePorffor()` needs no network on the happy path — same pattern as sproutboat-cli's vendored uWebSockets archive. Falls back to the existing checksummed download if the file is missing, or was left stale by a pin bump that forgot to re-vendor.
  
  Part of sproutboat-cli #134 item 3.

## 0.3.2

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

## 0.3.1

### Patch Changes

- afd054c: Fix (baronunread/sproutboat#172): a standalone/native-fetch response body,
  header name, or header value whose code points all fit one byte (any Latin-1-
  range string — most non-astral JS strings) reached the wire as raw Latin-1
  bytes instead of UTF-8, corrupting any non-ASCII text regardless of the
  declared `charset`. `patchRenderJs` now encodes Porffor's `bytestring`
  representation the same way its `string` (UTF-16) branch already did. Plain
  ASCII output is unaffected (identical in both encodings).

## 0.3.0

### Minor Changes

- New package: `@sproutboat/toolchain` — the single home for the Porffor pin
  (`pin.ts`), the source patches (`patch.ts`: `ensurePorfforPatched` plus the
  `$PORT`, request-body-limit, status-line, console-sink and remote-address
  passes), and `ensurePorffor()` (fetch, verify sha256, extract, patch, cache in
  `~/.cache/sproutboat`).
  
  `sproutboat-cli` and the `sproutboat` monorepo both depend on it instead of
  carrying their own copies, so the pin and the patch set can no longer drift —
  which they had (the monorepo was on `alpha-4` and applied 1 of the ~13 patches).
