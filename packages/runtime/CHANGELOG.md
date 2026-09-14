# @sproutboat/runtime

## 0.7.0

### Minor Changes

- 6998a15: R2 object bytes no longer live inside SQLite, on either transport (baronunread/sproutboat#56). Every `put()` used to bind the whole object into a `body` column, and every `get()` read it back out — doubling the object through SQLite's own page cache/WAL machinery on top of the buffer it already arrived in, which was the real driver of #56's "large uploads make memory skyrocket" complaint (the JSON-escaping half of that was already fixed in #63).
  
  Objects now live in their own file under `r2-blobs/`, named by a hash of bucket+key (so unicode keys and directory traversal are non-issues):
  
  - **Embedded (standalone):** `<data-dir>/r2-blobs/` — `sb_r2_put_c`/`sb_r2_get_c` write/read the file directly via C `fopen`/`fwrite`/`fread`, no SQLite blob column at all. `sb_r2_delete_blob` removes the file on delete.
  - **Broker:** colocated with whichever store file already holds that bucket's metadata — the main `db` for a bare-string binding, the resource's own file under `resourceDir` for an account-level one (#74) — so blobs persist across a redeploy exactly when that metadata does. `:memory:` stores (tests, local dev) fall back to an in-memory map.
  
  No migration: this is a schema change for new writes going forward, not a converter for objects already stored inline from before.
  
  Verified end-to-end against both transports (kitchen-sink's full conformance suite, 24/24 standalone + 27/27 broker) and with new unit tests for file-backed persistence, the `:memory:` fallback, and a real binary round-trip over the v1 wire protocol.
  
  **Known limitation found while verifying this, not fixed here:** a binary `put()` body (bytes ≥ 0x80) is corrupted on the way *in*, before it ever reaches storage — `porf_native_fetch_read_value` (the function every inline-C string read in the runtime goes through) always UTF-8-encodes a Latin-1-range string on read, which is correct for genuine text but wrong for opaque bytes coming off a raw HTTP body. This predates this change (the old SQLite-blob path had the identical corruption) and is not something the storage backend can fix — it needs an input-side counterpart to `#176`'s `x-sb-raw-body` marker, or real `ArrayBuffer`/`Uint8Array` body support (the upstream ask already filed as Draft G in `patches/UPSTREAM.md`).

### Patch Changes

- 188d8e4: Fix (baronunread/sproutboat#184): a `put()` body (R2, both transports) with bytes ≥ 0x80 was corrupted on the way *in*, before storage — `porf_native_fetch_read_value` (the one function every inline-C string read in the runtime funnels through) always UTF-8-encodes a Latin-1-range value, correct for genuine text, wrong for opaque bytes off a raw HTTP upload. A 256-byte binary upload landed as 384 stored bytes.
  
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
