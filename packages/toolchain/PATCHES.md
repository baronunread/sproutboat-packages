# Porffor patches against upstream

The patch series is the source of truth: `packages/toolchain/porffor-patches/`, a `git format-patch` series of
26 patches against ONE upstream commit, [CanadaHonk/porffor](https://github.com/CanadaHonk/porffor)
`1b8225e` (tag `alpha-24`, 2026-11-14). The toolchain supports one Porffor alpha at a time. This file is the index.

What ships is the patched tree: `vendor/porffor-patched.tar.gz` (the commit with the series applied) and
`vendor/porffor-patched.json` (upstream commit, series hash, tar and tarball sha256). `ensurePorfforA21` verifies the
tarball and unpacks it; nothing is patched on the user's machine, so it needs no git. `scripts/porffor-patches.ts` makes
and checks all of it:

```sh
bun scripts/porffor-patches.ts apply   [--dir D] [--base alpha-NN] [--upstream URL|PATH]  # upstream commit + series -> a git checkout (git am --3way)
bun scripts/porffor-patches.ts export  [--dir D]                                          # the checkout's commits -> porffor-patches/
bun scripts/porffor-patches.ts vendor  [--dir D] [--tag alpha-NN]                         # -> vendor/porffor-patched.tar.gz + .json
bun scripts/porffor-patches.ts verify  [--upstream URL|PATH]                              # apply + export + vendor in a temp dir, compare byte for byte
bun scripts/porffor-patches.ts check                                                      # no git, no network: series hash and tarball sha256 vs the manifest
```

`verify` is a CI job (`porffor patch series`). `check` and the shape of every patch below run in `patch.test.ts`.

Classes (a `Class:` trailer in every patch):

- **upstream**: Porffor itself is wrong or missing something. Anyone running Porffor could hit it. The patch names the issue (`Upstream:` trailer).
- **ours**: a consequence of our shared-template model, our GC and CPU hooks, our link inputs or our host. Upstream would not need it.
- **generated**: `compiler/builtins_precompiled.js`, which upstream tracks and which follows every builtin edit.

Filing on upstream needs explicit human approval, and Porffor's [AI policy](https://github.com/CanadaHonk/porffor/blob/main/AI_POLICY.md)
applies. Drafts live in [`sproutboat/patches/upstream`](https://github.com/baronunread/sproutboat/tree/main/patches/upstream).

## The series

Applied in this order. Every patch has what and why in its commit message.

| Patch | Change | Class | Upstream issue or PR | What it fixes, one line |
| ----- | ------ | ----- | -------------------- | ----------------------- |
| [`0001-compiler-SB_EXTRA_LINK-and-SB_EXTRA_CFLAGS-add-link-.patch`](porffor-patches/0001-compiler-SB_EXTRA_LINK-and-SB_EXTRA_CFLAGS-add-link-.patch) | SB_EXTRA_LINK / SB_EXTRA_CFLAGS | ours | none needed | link inputs and C flags from the environment for SQLite, BearSSL and the broker glue; upstream names libraries in source (`Porffor.link`) |
| [`0002-builtins-navigator-is-writable.patch`](porffor-patches/0002-builtins-navigator-is-writable.patch) | writable `navigator` | ours | none needed | `navigator.userAgent` is frozen to `Porffor/<v>`; the prelude must set `Cloudflare-Workers` for pg's Workers socket path |
| [`0003-string-replaceAll-joins-its-pieces-once-instead-of-c.patch`](porffor-patches/0003-string-replaceAll-joins-its-pieces-once-instead-of-c.patch) | `replaceAll` pieces | upstream | [#459](https://github.com/CanadaHonk/porffor/issues/459), open (filed by us 2026-11-11) | `String.prototype.replaceAll` is quadratic: each match concatenates the whole output again |
| [`0004-string-repeat-copies-by-doubling.patch`](porffor-patches/0004-string-repeat-copies-by-doubling.patch) | `repeat` doubling | upstream | not filed: `repeat` is linear on alpha 23/24 (1.6 MB in 8 ms, 32 MB in 105 ms), the patch only cuts a constant factor; candidate to drop ([#150](https://github.com/CanadaHonk/porffor/pull/150) and [#312](https://github.com/CanadaHonk/porffor/pull/312) are closed count-coercion PRs, a different problem) | `"ab".repeat(300000)` makes 300,000 small copies instead of log2(n) doubling copies |
| [`0005-string-toUpperCase-and-toLowerCase-map-the-Unicode-c.patch`](porffor-patches/0005-string-toUpperCase-and-toLowerCase-map-the-Unicode-c.patch) | Unicode case mapping | upstream | [#461](https://github.com/CanadaHonk/porffor/issues/461), open (filed by us 2026-11-11) | `toUpperCase` / `toLowerCase` map only ASCII: `"é".toUpperCase()` stays `"é"` |
| [`0006-regexp-replace-with-a-global-regexp-and-a-function-b.patch`](porffor-patches/0006-regexp-replace-with-a-global-regexp-and-a-function-b.patch) | regexp `replace` with a function | upstream | [#460](https://github.com/CanadaHonk/porffor/issues/460), open (filed by us 2026-11-11) | `str.replace(/re/g, fn)` is quadratic: a full `strcat` copy per match |
| [`0007-modules-record-app-module-ids-and-declare-their-name.patch`](porffor-patches/0007-modules-record-app-module-ids-and-declare-their-name.patch) | app module ids (P6, modules.js) | ours | none needed | records app module ids and declares their namespaces after the shared ones, so the template's initializer prefix does not depend on the app |
| [`0008-modules-names-the-shared-prelude-declares-or-assigns.patch`](porffor-patches/0008-modules-names-the-shared-prelude-declares-or-assigns.patch) | prelude-owned globals (P4) | ours | none needed | a name the shared prelude declares, assigns on `globalThis` or defines there with a literal name must not also install the runtime's global, or a free `fetch(` links the whole fetch stack |
| [`0009-modules-SB_GLOBALS_PIN-pins-the-runtime-globals-to-t.patch`](porffor-patches/0009-modules-SB_GLOBALS_PIN-pins-the-runtime-globals-to-t.patch) | `SB_GLOBALS_PIN` (P14) | ours | none needed | the globals an app references decide the order of the template's `globals.js` installs (sproutd issue 97); with the pin the set and order are the template's |
| [`0010-codegen-class-methods-and-constructors-stay-in-their.patch`](porffor-patches/0010-codegen-class-methods-and-constructors-stay-in-their.patch) | class functions in their unit (P1) | ours | none needed | class methods and constructors land in `main` instead of their module's unit, so an app's classes change the shared prefix |
| [`0011-codegen-shared-dispatch-functions-belong-to-the-aski.patch`](porffor-patches/0011-codegen-shared-dispatch-functions-belong-to-the-aski.patch) | shared dispatch per unit (P8) | ours | none needed | the shared dispatch functions for unknown receivers (`#anonymous_1`, ...) are created into `main` in creation order, so one app shifts every other app's ABI |
| [`0012-codegen-stable-derived-names-and-app-modules-builtin.patch`](porffor-patches/0012-codegen-stable-derived-names-and-app-modules-builtin.patch) | stable derived names (P5, P6 codegen) | ours | none needed | `#func_cache_<global index>` and class computed-key globals are named by creation order, so the prelude's unit differs byte-wise between apps. Alpha 24: the computed-key anchor is indentation-free |
| [`0013-render-app-units-last-content-ordered-data-segments-.patch`](porffor-patches/0013-render-app-units-last-content-ordered-data-segments-.patch) | unit layout (P2, P3, P3b, P6 render) | ours | none needed | app units go last, data segments are laid out by content and the ABI regions are pinned at 1, 2 and 4 MiB so the template ABI holds across apps |
| [`0014-modules-sb-entry-file-pins-the-entry-path-baked-into.patch`](porffor-patches/0014-modules-sb-entry-file-pins-the-entry-path-baked-into.patch) | stable entry path (P7) | ours | none needed | `node:process` bakes the absolute entry path into its unit; `--sb-entry-file` pins it so templates compare equal |
| [`0015-render-collector-hooks-for-the-fork-template-quiet-s.patch`](porffor-patches/0015-render-collector-hooks-for-the-fork-template-quiet-s.patch) | collector hooks | ours | none needed (our earlier GC reports [#425](https://github.com/CanadaHonk/porffor/issues/425) and [#428](https://github.com/CanadaHonk/porffor/issues/428) are closed and unrelated) | `porf_gc_quiet`, `porf_gc_seal_heap`, immortal sealed template pages and `porf_gc_set_limit`, so forked workers do not copy-on-write the template heap and the app's memory limit reaches the collector |
| [`0016-render-promise-per-request-CPU-stamp-on-promise-reac.patch`](porffor-patches/0016-render-promise-per-request-CPU-stamp-on-promise-reac.patch) | per-request CPU stamp | ours | none needed | stamps each promise reaction with a per-request id and sums thread CPU per request |
| [`0017-builtins-the-megamorphic-inline-cache-can-be-frozen-.patch`](porffor-patches/0017-builtins-the-megamorphic-inline-cache-can-be-frozen-.patch) | megamorphic cache freeze | ours | none needed. Open upstream IC rewrites [#420](https://github.com/CanadaHonk/porffor/pull/420) and [#421](https://github.com/CanadaHonk/porffor/pull/421) would touch the same code: recheck when they merge | the 80 KiB megamorphic cache is written by every worker's misses; freezing it after warm-up keeps the pages shared |
| [`0018-render-select-is-a-reserved-C-name.patch`](porffor-patches/0018-render-select-is-a-reserved-C-name.patch) | `select` is a reserved C name | upstream | [#462](https://github.com/CanadaHonk/porffor/issues/462), open (filed by us 2026-11-11). [#426](https://github.com/CanadaHonk/porffor/issues/426) (ours, closed) fixed all-caps macro names only | `const select = 1` fails the C compile on Linux (glibc `sys/select.h`) |
| [`0019-fetch-Response.redirect-and-Response.error.patch`](porffor-patches/0019-fetch-Response.redirect-and-Response.error.patch) | `Response.redirect` / `Response.error` | upstream | [#463](https://github.com/CanadaHonk/porffor/issues/463), open (filed by us 2026-11-11) | only `Response.json` exists |
| [`0020-process-tolerate-a-null-argv-and-environ.patch`](porffor-patches/0020-process-tolerate-a-null-argv-and-environ.patch) | null argv and environ | ours | none needed: only an embedding host that runs `clearenv()` (sproutd's template) reaches it | `node:process` init reads `porf_argv[i]` and `environ[i]` without a null check |
| [`0021-json-a-wide-JSON-string-is-sized-by-its-own-length-P.patch`](porffor-patches/0021-json-a-wide-JSON-string-is-sized-by-its-own-length-P.patch) | JSON wide strings (P9) | upstream | [#464](https://github.com/CanadaHonk/porffor/issues/464), open (filed by us 2026-11-11) | `JSON.parse` of 6,000 objects containing `"naïve 中文"` in a 316 KB document dies (signal 138/139): wide strings are sized by the whole document |
| [`0022-codegen-shared-dispatch-arguments-are-evaluated-in-o.patch`](porffor-patches/0022-codegen-shared-dispatch-arguments-are-evaluated-in-o.patch) | dispatch argument order (P10) | upstream | [#454](https://github.com/CanadaHonk/porffor/issues/454), open, same bug (filed by us 2026-11-08). Related, different paths: [#437](https://github.com/CanadaHonk/porffor/issues/437), [#438](https://github.com/CanadaHonk/porffor/issues/438), [#448](https://github.com/CanadaHonk/porffor/issues/448) | `x.toString("utf8", i, i += n)` on an untyped `x` reads `i` after the increment on arm64 |
| [`0023-codegen-a-written-class-declaration-initialises-its-.patch`](porffor-patches/0023-codegen-a-written-class-declaration-initialises-its-.patch) | written class declaration (P11) | upstream | [#457](https://github.com/CanadaHonk/porffor/issues/457), open, same bug (filed by us 2026-11-08) | `class A {}; A = A` leaves `A` undefined; drizzle-orm's `(SQL \|\| (SQL = {}))` merge dies. Alpha 24 only: a decorated or boxed class is skipped (plain code now, no per-tree anchor choice) |
| [`0024-codegen-the-right-operand-of-and-is-generated-as-a-b.patch`](porffor-patches/0024-codegen-the-right-operand-of-and-is-generated-as-a-b.patch) | logical right operand is a branch (P13) | upstream | [#456](https://github.com/CanadaHonk/porffor/issues/456), open, same bug (filed by us 2026-11-08) | in a function, `let o = 1; o \|\| (o = {}); typeof o` answers `"object"` |
| [`0025-date-Date.parse-takes-HH-and-HHmm-offsets-as-well-as.patch`](porffor-patches/0025-date-Date.parse-takes-HH-and-HHmm-offsets-as-well-as.patch) | `Date.parse` offsets (P12) | upstream | [#455](https://github.com/CanadaHonk/porffor/issues/455), open, same bug (filed by us 2026-11-08). The colon form was [#387](https://github.com/CanadaHonk/porffor/issues/387), ours, closed | `new Date("2026-11-08 14:48:19.097+00")` and `...+0000` are `NaN` |
| [`0026-builtins-regenerate-compiler-builtins_precompiled.js.patch`](porffor-patches/0026-builtins-regenerate-compiler-builtins_precompiled.js.patch) | regenerated `builtins_precompiled.js` | generated | n/a | the precompiled builtin table, which upstream tracks; `apply` skips this patch and regenerates it, `verify` fails when it is stale |

Counts: 25 patches + 1 generated: 12 upstream (11 passes; 10 with an issue, #454 to #457 and #459 to #464, all open with no fix or PR), 13 ours.
No upstream PR covers any of them; Porffor's AI policy does not allow LLM-written PR text, so any PR needs a human-written description.

## Upgrading to a new alpha

1. `bun scripts/porffor-patches.ts apply --base alpha-NN [--upstream <local clone>]`. It fetches the new tag, applies the
   series on the OLD commit first (so every intermediate blob exists), then `git am --3way` onto the new tag, then regenerates
   `builtins_precompiled.js`. The generated patch is never applied, so it never conflicts.
2. On a conflict: edit the files in the checkout (`.porffor-series/` by default), `git add`, `git am --continue`; the
   branch `sb-patches-old` holds the series on the old commit for reference. A patch that upstream fixed is dropped with
   `git am --skip`. Then `bun scripts/porffor-patches.ts precompile`.
3. Passes that made a per-tree choice (P11 picked its anchor by tree before) are plain code now: change the patch for the new alpha.
4. `export` (rewrites `porffor-patches/`), then `vendor --tag alpha-NN` (tarball and manifest), with the bun CI pins.
   Set `CURRENT_ALPHA` in `src/a21/pin.ts` and the `standalone` channel names; update this table.
5. `verify` must pass. Re-run the repros of every upstream issue on the stock tree and note which still fail (see the checks below).
6. Requalify at the tier the change needs (sproutd's `requalify.sh`; a new alpha is the porffor tier, see "Requal tiers").

Dropping or adding a pass is the same flow: `git rebase -i` in the checkout, `export`, `vendor`.

## Alpha 24 check (2026-11-14)

Alpha 24 is fifteen commits on alpha 23 (npm `0.0.0-alpha.24`, gitHead `1b8225e`, which is upstream `main`): +~620/-~245 lines in
`compiler/` (new `typescript.js` and `builtins/decorator.ts`, `codegen.js` +220/-135, `modules.js`, `parser/`, `semantic.js`,
`render.js`) and the CI workflow. It touches none of `builtins/string.ts`, `regexp.ts`, `json.ts`, `date.ts`, `promise.ts` or `runtime/`.

| Upstream commit | Touches | Effect on the chain |
| --- | --- | --- |
| `99bf9066` compiler: ts lowering and decorators | new `typescript.js` (namespaces, enums, parameter properties), `builtins/decorator.ts`, class codegen in `codegen.js` (`classDecorators`, `decl._boxed`, `decl._tdzCheck`) | **P5**: the class computed-key line moved two columns left, so its anchor is now indentation-free. **P11**: the `classRoot` line now reads `decl._writes && !classDecorators`; the pass picks the anchor by tree and, on alpha 24, skips a decorated or boxed class (their binding is written elsewhere). `channelOfTree` tells alpha 24 by the presence of `compiler/typescript.js` |
| `c17f9def` runtime tdz for top-level lexicals | `codegen.js` | none |
| `cacc5536`, `15df2d2d` evaluation order | `codegen.js` | none for P10: `#454` still reproduces (below) |
| `e92728e3` porf_invoke cases per signature, `07df32d3` -ffp-contract=off | `render.js` | none of our passes anchors there; the template script (`sproutd/build/a21/prepare-dynamic-template.py`) and tests that grep the emitted C should be rechecked before alpha 24 becomes a generation |
| the other eight (`1b8225ea`, `4e979c1f`, `3083bfe1`, `84e04400`, `8d789adc`, `a44777ff`, `972721ca`, CI) | `codegen.js`, `parser/`, `render.js`, workflow | none |

Repros run on the **unpatched** alpha 24 tree (macOS arm64), 2026-11-14. All still fail, so no pass can be dropped:

| Issue | Result on stock alpha 24 |
| --- | --- |
| [#454](https://github.com/CanadaHonk/porffor/issues/454) | `decode(Buffer.from("hello world"), 6, 5)` gives `"\|11"`, expected `"world\|11"` |
| [#455](https://github.com/CanadaHonk/porffor/issues/455) | `new Date("2026-11-08 14:48:19.097+00")` and `...+0000` are `NaN` |
| [#456](https://github.com/CanadaHonk/porffor/issues/456) | `function f(){ let o = 1; o \|\| (o = {}); return typeof o }` is `"object"` |
| [#457](https://github.com/CanadaHonk/porffor/issues/457) | `class A {}; A = A; typeof A` is `"undefined"` |
| [#461](https://github.com/CanadaHonk/porffor/issues/461) | `"é".toUpperCase()` and `"ж".toUpperCase()` are unchanged |
| [#463](https://github.com/CanadaHonk/porffor/issues/463) | `typeof Response.redirect` and `Response.error` are `"undefined"` |
| [#459](https://github.com/CanadaHonk/porffor/issues/459), [#460](https://github.com/CanadaHonk/porffor/issues/460), [#464](https://github.com/CanadaHonk/porffor/issues/464) | not rerun: `builtins/string.ts`, `regexp.ts` and `json.ts` are byte-identical to alpha 23, whose repros failed |
| [#462](https://github.com/CanadaHonk/porffor/issues/462) | not run (Linux glibc only); the `cReservedNames` anchor is still there once |

All ten issues are still open with no comments and no linked PR. With the chain applied, `a21/miscompile.test.ts` (P10, P11, P12, P13
end to end, compiled to native binaries) passes on both alpha 23 and alpha 24. A TypeScript file with a `namespace`, an `enum`, a
decorated method and a parameter property compiles and runs correctly on stock and on patched alpha 24; the repo had no workaround
for any of them to remove.

## Alpha 24 qualification (2026-11-14)

`SPROUTBOAT_PORFFOR_CHANNEL=alpha-24 bun scripts/test-native.ts` on romeo (Linux x64, Debian 13, concurrency 2, 5 GiB cap): 47 passed, 3 failed in 499 s.
The three failures (`native-ltx`, `native-d1`, `native-db-table`) were `sqlite3.h` and `-lsqlite3` missing on the box (CI installs `libsqlite3-dev`); rerun
with the dev package unpacked into a scratch directory and `CPATH`/`LIBRARY_PATH` pointing at it, all three pass. Seven of the 47 only printed a skip:
five need `SB_CLI` (`sockets-starttls`, `do-evict`, `websockets-outbound`, `async-local-storage`, `sqlite-lock`) and ran on the Mac (arm64) against a
sproutboat-cli `cb5624a` worktree linked to this checkout: 5 of 5 pass; `native-cc` and `native-lto` skipped because their gate was `=== "alpha-23"`
(this PR widens it to alpha 24) and pass on the Mac on alpha 24. So every `test:native-*` script has passed on alpha 24. No new Porffor bug was found.
The sproutd side (a template-script break from `e92728e3`'s new `porf_invoke` tables) is sproutd #123.

## Issues we filed that are not tied to a pass

[#385](https://github.com/CanadaHonk/porffor/issues/385), [#386](https://github.com/CanadaHonk/porffor/issues/386),
[#387](https://github.com/CanadaHonk/porffor/issues/387), [#388](https://github.com/CanadaHonk/porffor/issues/388),
[#400](https://github.com/CanadaHonk/porffor/issues/400), [#425](https://github.com/CanadaHonk/porffor/issues/425),
[#426](https://github.com/CanadaHonk/porffor/issues/426), [#427](https://github.com/CanadaHonk/porffor/issues/427)
and [#428](https://github.com/CanadaHonk/porffor/issues/428) are closed. Open PRs of ours:
[#422](https://github.com/CanadaHonk/porffor/pull/422) (heap BigInts in conservative GC scans) and
[#423](https://github.com/CanadaHonk/porffor/pull/423) (globalThis rewrites only changed bindings);
[#395](https://github.com/CanadaHonk/porffor/pull/395) (TextEncoder astral chars) is merged.
