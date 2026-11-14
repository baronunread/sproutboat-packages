# @sproutboat/assets

## 0.3.1

### Patch Changes

- d4bbcd5: `_redirects` matching follows Cloudflare's rules. The whole request path must match, so a trailing slash is significant: `/compare /compare/ 308` redirects `/compare` once, and `/compare/` is then served (or matched by a rule of its own) instead of redirecting to itself forever. Before, a rule's `from` was compared segment by segment with the empty ones dropped, so `/compare` also matched `/compare/` and `/user/:id` matched `/user/42/`.
  
  What matches, as in Cloudflare's rules engine:
  
  - `:name` matches one or more characters up to the next `/`, may sit inside a segment (`/files/:name.html`), and may appear once per rule;
  - `*` matches anything including `/` and the empty string, is `:splat` in the target, and may sit in the middle of the path (`/a/*/c`); a rule has at most one;
  - a rule with a repeated name or two splats never matches (Cloudflare drops it);
  - a static rule (no `:name`, no `*`) beats a dynamic one whatever the order; among rules of one kind the first in the file wins. `findRedirect(rules, pathname)` is the new entry point; `matchRedirect(rule, pathname)` still answers for one rule.
  
  This changes what an existing `_redirects` file does for paths that differ only by a trailing slash, with no compatibility date: the edge serves assets before any app code runs and cannot see the date, and the old matching was what looped. Run `bun run test:native-asset-redirects` to check the compiled matcher against the same cases as the portable one.

## 0.3.0

### Minor Changes

- 6145afe: `_headers`/`_redirects` support (baronunread/sproutboat#61). `AssetManifest` gains optional `headers`/`redirects` arrays, parsed at build time from `_headers`/`_redirects` files at the assets root by the new `readAssetRules()` (`walkAssets()` now excludes those two filenames from the servable file list, root only). `matchHeaders()`/`matchRedirect()` apply them at request time: `_headers` uses Netlify/Pages-style greedy `*` matching (distinct from `run_sprout_first`'s single-segment `globMatch`), `_redirects` supports `:name` segments and a trailing `*` substituted as `:splat`. Pure parsing/matching in this package; wiring them into the edge/broker request path is a separate change downstream.

## 0.2.0

### Minor Changes

- c45098e: Adopt broker, JSON utilities, assets, wrapper, source validation, both transports and the prelude from sproutboat-cli (moved verbatim). First publishable versions; consumed via `file:` links until the npm publish flow lands.
