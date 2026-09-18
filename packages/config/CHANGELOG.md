# @sproutboat/config

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
