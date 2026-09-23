# @sproutboat/assets

## 0.3.0

### Minor Changes

- 6145afe: `_headers`/`_redirects` support (baronunread/sproutboat#61). `AssetManifest` gains optional `headers`/`redirects` arrays, parsed at build time from `_headers`/`_redirects` files at the assets root by the new `readAssetRules()` (`walkAssets()` now excludes those two filenames from the servable file list, root only). `matchHeaders()`/`matchRedirect()` apply them at request time: `_headers` uses Netlify/Pages-style greedy `*` matching (distinct from `run_sprout_first`'s single-segment `globMatch`), `_redirects` supports `:name` segments and a trailing `*` substituted as `:splat`. Pure parsing/matching in this package; wiring them into the edge/broker request path is a separate change downstream.

## 0.2.0

### Minor Changes

- c45098e: Adopt broker, JSON utilities, assets, wrapper, source validation, both transports and the prelude from sproutboat-cli (moved verbatim). First publishable versions; consumed via `file:` links until the npm publish flow lands.
