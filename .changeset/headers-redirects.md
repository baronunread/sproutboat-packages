---
"@sproutboat/assets": minor
---

`_headers`/`_redirects` support (baronunread/sproutboat#61). `AssetManifest` gains optional `headers`/`redirects` arrays, parsed at build time from `_headers`/`_redirects` files at the assets root by the new `readAssetRules()` (`walkAssets()` now excludes those two filenames from the servable file list, root only). `matchHeaders()`/`matchRedirect()` apply them at request time: `_headers` uses Netlify/Pages-style greedy `*` matching (distinct from `run_sprout_first`'s single-segment `globMatch`), `_redirects` supports `:name` segments and a trailing `*` substituted as `:splat`. Pure parsing/matching in this package; wiring them into the edge/broker request path is a separate change downstream.
