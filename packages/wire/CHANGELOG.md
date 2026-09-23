# @sproutboat/wire

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
  
  **Known limitation found while verifying this, not fixed here:** a binary `put()` body (bytes ≥ 0x80) is corrupted on the way *in*, before it ever reaches storage — `porf_native_fetch_read_value` (the function every inline-C string read in the runtime goes through) always UTF-8-encodes a Latin-1-range string on read, which is correct for genuine text but wrong for opaque bytes coming off a raw HTTP body. This predates this change (the old SQLite-blob path had the identical corruption) and is not something the storage backend can fix — it needs an input-side counterpart to `#176`'s `x-sb-raw-body` marker, or real `ArrayBuffer`/`Uint8Array` body support (the upstream ask already filed as Draft G in `patches/UPSTREAM.md`).

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
