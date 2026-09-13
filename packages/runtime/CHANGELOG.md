# @sproutboat/runtime

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
