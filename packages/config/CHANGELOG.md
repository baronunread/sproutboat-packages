# @sproutboat/config

## 0.6.0

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

## 0.5.0

### Minor Changes

- 4dd16b7: `fetch()` reaches any public address and never a private or reserved one (baronunread/sproutboat#174). The `outbound` allowlist is gone.
  
  - Both backends, the broker and the standalone client, check the address they resolved, not the hostname, so DNS rebinding can't get past the check. The broker connects to the vetted address and verifies TLS against the name.
  - Blocked: loopback, RFC 1918, link-local and cloud metadata, CGNAT, benchmarking, documentation, multicast and reserved ranges, IPv6 ULA and link-local, and the IPv4 address inside IPv4-mapped, NAT64 and 6to4 addresses.
  - An operator can let addresses through with `SB_EGRESS_ALLOW` (`*` or exact addresses) in the broker's or the binary's environment. Handler code can't.
  - `@sproutboat/runtime`: `URL.hostname` and `URL.port` handle IPv6 literals (`[::1]:9` used to give hostname `[`). Every sprout gets `fetch()`, with no binding needed. `validateHttpSyncSource` no longer takes an `outboundAllowed` argument, and `Bindings` loses `outbound`.
  - `@sproutboat/wire`: `Bindings` loses `outbound`.
  - `@sproutboat/config`: `outbound` is accepted but ignored, with a warning in the new `warnings` field of a successful parse (`OUTBOUND_IGNORED`). It will be refused in a later minor release.

## 0.4.0

### Minor Changes

- 7287d9b: Version metadata binding (baronunread/sproutboat#126). `sproutboat.jsonc` gains a `version_metadata` key naming a binding (like wrangler's `[version_metadata]`), and `wrapNativeFetchHandler` bakes `env.<binding> = { id, tag, timestamp }` directly into the module at build time — no broker round trip. `id`/`tag`/`timestamp` are supplied by the caller (the CLI derives them from the artifact digest, the project name, and the build time); this package only wires the config field through and does the baking.

## 0.3.0

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

## 0.2.0

### Minor Changes

- 6e131e6: Adopt config parsing and artifact manifest from sproutboat-cli (moved verbatim, frozen behavior). First publishable versions; consumed via `file:` links until the npm publish flow lands.
