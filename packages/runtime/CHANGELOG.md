# @sproutboat/runtime

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
