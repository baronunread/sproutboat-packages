# Porffor patches against upstream

The 25 passes of `ensurePorfforPatchedA21` (`src/a21/patch.ts`), each checked against
[CanadaHonk/porffor](https://github.com/CanadaHonk/porffor) issues and PRs, open and closed. Update this
file whenever a pass is added, dropped or filed upstream.

**Last checked: alpha 23 (`a97a0ae`, 2026-11-10), 2026-11-12, by running it.** On 2026-11-11 the check was
reading upstream's source and issue tracker. On 2026-11-12 the chain was applied to a pristine alpha 23 tree (all
passes anchor once, none moved) and the repros were compiled and run on the unpatched tree (see "Alpha 23 check"
below). The chain now pins alpha 21, alpha 22 and alpha 23 (`src/a21/pin.ts`); no pass was dropped by alpha 23.

Classes:

- **upstream**: Porffor itself is wrong or missing something. Anyone running Porffor could hit it.
- **ours**: a consequence of our shared-template model, our GC and CPU hooks, our link inputs or our host.
  Upstream would not need it.

Filing on upstream needs explicit human approval, and Porffor's [AI policy](https://github.com/CanadaHonk/porffor/blob/main/AI_POLICY.md)
applies. Drafts live in [`sproutboat/patches/upstream`](https://github.com/baronunread/sproutboat/tree/main/patches/upstream).

## Table

| Pass (`patch…A21` / function)                | P   | Group | Class    | Upstream issue or PR                                                                                                                                                                                                                  | Repro, one line                                                                                                                                                  | Last checked      |
| -------------------------------------------- | --- | ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `patchCompilerArgsA21`                       |     | 1     | ours     | none needed                                                                                                                                                                                                                           | `SB_EXTRA_LINK` and `SB_EXTRA_CFLAGS` add the link inputs and flags for SQLite, BearSSL and the broker glue; upstream names libraries in source (`Porffor.link`) | alpha 23, a97a0ae |
| `patchNavigatorWritableA21`                  |     | 1     | ours     | none needed                                                                                                                                                                                                                           | `navigator.userAgent` is frozen to `Porffor/<v>`; the prelude must set `Cloudflare-Workers` for pg's Workers socket path                                         | alpha 23, a97a0ae |
| `patchReplaceAll`                            |     | 1     | upstream | [#459](https://github.com/CanadaHonk/porffor/issues/459), open (filed by us 2026-11-11)                                                                                                                                                                                                                            | `String.prototype.replaceAll` is quadratic: each match concatenates the whole output again                                                                       | alpha 23, a97a0ae |
| `patchRepeatDoubling`                        |     | 1     | upstream | not filed: on `a97a0ae` `repeat` is linear (1.6 MB in 8 ms, 32 MB in 105 ms), only slower by a constant than doubling copies; nothing to report ([#150](https://github.com/CanadaHonk/porffor/pull/150) and [#312](https://github.com/CanadaHonk/porffor/pull/312) are closed `repeat` count-coercion PRs, a different problem)                                            | `"ab".repeat(300000)` makes 300,000 small copies instead of log2(n) doubling copies                                                                              | alpha 23, a97a0ae |
| `patchCaseMapping`                           |     | 1     | upstream | [#461](https://github.com/CanadaHonk/porffor/issues/461), open (filed by us 2026-11-11)                                                                                                                                                                                                                            | `toUpperCase` / `toLowerCase` map only ASCII: `"é".toUpperCase()` stays `"é"`, `"ж".toUpperCase()` stays `"ж"`                                                   | alpha 23, a97a0ae |
| `patchRegexReplace`                          |     | 1     | upstream | [#460](https://github.com/CanadaHonk/porffor/issues/460), open (filed by us 2026-11-11)                                                                                                                                                                                                                            | `str.replace(/re/g, fn)` is quadratic: a full `strcat` copy per match                                                                                            | alpha 23, a97a0ae |
| `patchAppModuleIds`                          | P6  | 2     | ours     | none needed                                                                                                                                                                                                                           | records app module ids and declares their namespaces after the shared ones, so the template's initializer prefix does not depend on the app                      | alpha 23, a97a0ae |
| `patchPreludeOwnedGlobals`                   | P4  | 2     | ours     | none needed                                                                                                                                                                                                                           | a name the shared prelude declares, assigns on `globalThis` or defines there with a literal name (`Object.defineProperty(globalThis, "process", ...)`, a lazy accessor) must not also install the runtime's global, or a free `fetch(` links the whole fetch stack         | alpha 23, a97a0ae |
| `patchGlobalsPin`                            | P14 | 2     | ours     | none needed                                                                                                                                                                                                                           | the runtime globals an app references decide the order of the template's `globals.js` installs, so a free `performance` reordered every node unit behind it (sproutd issue 97); with `SB_GLOBALS_PIN` the set and order are the template's and any other name is a compile error| not checked (ours)|
| `patchClassUnit`                             | P1  | 2     | ours     | none needed                                                                                                                                                                                                                           | class methods and constructors land in `main` instead of their module's unit, so an app's classes change the shared prefix                                       | alpha 23, a97a0ae |
| `patchSharedDispatchUnit`                    | P8  | 2     | ours     | none needed (alpha 22 and later only)                                                                                                                                                                                                 | the shared dispatch functions for unknown receivers (`#anonymous_1`, ...) are created into `main` in creation order, so one app shifts every other app's ABI     | alpha 23, a97a0ae |
| `patchStableNames`                           | P5  | 2     | ours     | none needed                                                                                                                                                                                                                           | `#func_cache_<global index>` and class computed-key globals are named by creation order, so the prelude's unit differs byte-wise between apps                    | alpha 23, a97a0ae |
| `patchUnitLayout`                            | P2  | 2     | ours     | none needed                                                                                                                                                                                                                           | app units go last, data segments are laid out by content (P3, P3b) and the ABI regions are pinned at 1, 2 and 4 MiB so the template ABI holds across apps        | alpha 23, a97a0ae |
| `patchStableEntryPath`                       | P7  | 2     | ours     | none needed                                                                                                                                                                                                                           | `node:process` bakes the absolute entry path into its unit; `--sb-entry-file` pins it so templates compare equal                                                 | alpha 23, a97a0ae |
| `patchGcHooks`                               |     | 2     | ours     | none needed (our earlier GC reports [#425](https://github.com/CanadaHonk/porffor/issues/425) and [#428](https://github.com/CanadaHonk/porffor/issues/428) are closed and unrelated)                                                    | `porf_gc_quiet`, `porf_gc_seal_heap` and immortal sealed template pages, so forked workers do not copy-on-write the template heap                                | alpha 23, a97a0ae |
| `patchCpuStamp`                              |     | 2     | ours     | none needed                                                                                                                                                                                                                           | stamps each promise reaction with a per-request id and sums thread CPU per request                                                                               | alpha 23, a97a0ae |
| `patchIcMegaFreeze`                          |     | 2     | ours     | none needed. Open upstream IC rewrites [#420](https://github.com/CanadaHonk/porffor/pull/420) and [#421](https://github.com/CanadaHonk/porffor/pull/421) (arv) would touch the same code, so recheck the anchors when they merge     | the 80 KiB megamorphic cache is written by every worker's misses; freezing it after warm-up keeps the pages shared                                               | alpha 23, a97a0ae |
| `patchReservedSelect`                        |     | 3     | upstream | [#462](https://github.com/CanadaHonk/porffor/issues/462), open (filed by us 2026-11-11). [#426](https://github.com/CanadaHonk/porffor/issues/426) (ours, closed) fixed all-caps macro names only; lowercase libc functions are still missing from `cReservedNames`                                                 | `const select = 1; console.log(select)` fails the C compile on Linux (glibc `sys/select.h` declares `select()`)                                                  | alpha 23, a97a0ae |
| `patchResponseStatics`                       |     | 3     | upstream | [#463](https://github.com/CanadaHonk/porffor/issues/463), open (filed by us 2026-11-11)                                                                                                                                                                                                                            | `Response.redirect(url, status)` and `Response.error()` are missing; only `Response.json` exists                                                                 | alpha 23, a97a0ae |
| `patchProcessNullTables`                     |     | 3     | ours     | none needed. Upstream's CLI always has an argv and an environment; only an embedding host that runs `clearenv()` (sproutd's template) reaches it                                                                                      | `node:process` init reads `porf_argv[i]` and `environ[i]` without a null check, so a host with no argv or a cleared `environ` crashes before the first module    | alpha 23, a97a0ae |
| `patchJsonWideStringBound`                   | P9  | 3     | upstream | [#464](https://github.com/CanadaHonk/porffor/issues/464), open (filed by us 2026-11-11)                                                                                                                                                                                                                            | `JSON.parse` of 6,000 objects containing `"naïve 中文"` in a 316 KB document dies (signal 138/139): wide strings are sized by the whole document, not the string    | alpha 23, a97a0ae |
| `patchDispatchArgOrder`                      | P10 | 3     | upstream | [#454](https://github.com/CanadaHonk/porffor/issues/454), open, same bug (filed by us 2026-11-08). Related family, different code paths: [#437](https://github.com/CanadaHonk/porffor/issues/437), [#438](https://github.com/CanadaHonk/porffor/issues/438), [#448](https://github.com/CanadaHonk/porffor/issues/448) | `x.toString("utf8", i, i += n)` on an untyped `x` reads `i` after the increment on arm64                                                                         | alpha 23, a97a0ae |
| `patchClassBindingWrite`                     | P11 | 3     | upstream | [#457](https://github.com/CanadaHonk/porffor/issues/457), open, same bug (filed by us 2026-11-08)                                                                                                                                     | `class A {}; A = A` leaves `A` undefined; drizzle-orm's `(SQL \|\| (SQL = {}))` namespace merge dies with "Cannot get property of null"                          | alpha 23, a97a0ae |
| `patchDateOffsets`                           | P12 | 3     | upstream | [#455](https://github.com/CanadaHonk/porffor/issues/455), open, same bug (filed by us 2026-11-08). The earlier colon form was [#387](https://github.com/CanadaHonk/porffor/issues/387), ours, closed                                   | `new Date("2026-11-08 14:48:19.097+00")` and `...+0000` are `NaN` (V8 and Bun accept `+HH`, `+HHmm`, `+HH:mm`)                                                   | alpha 23, a97a0ae |
| `patchLogicalBranchInference`                | P13 | 3     | upstream | [#456](https://github.com/CanadaHonk/porffor/issues/456), open, same bug (filed by us 2026-11-08)                                                                                                                                     | in a function, `let o = 1; o \|\| (o = {}); typeof o` answers `"object"`: the right operand's assignment retypes the local as if it always ran                   | alpha 23, a97a0ae |

`precompileBuiltinsA21` runs last and is a build step, not a patch: it compiles the builtins the passes above edited.

## Alpha 23 check (2026-11-12)

Alpha 23 is eight commits on alpha 22 (+25/-21 lines, five files under `compiler/`; nothing in `compiler/builtins/`
or `runtime/`; upstream `main` is this commit, no later one). Every anchor of every pass is found once, so the chain applies
unchanged; the one new rule is that P8 and P10 are applied on every tree but alpha 21's (`channelOfTree`).

| Upstream commit | Touches | Effect on the chain |
| --- | --- | --- |
| `f85e9473` swiftcall for js functions on clang arm64 | `render.js`: `PORF_CC` on every js function definition and prototype, the dynamic thunks and `porf_call<n>` | none of our passes anchors on a js function signature; the **template script** does (`sproutd/build/a21/prepare-dynamic-template.py`), and so do tests that grep the emitted C |
| `56b08ce5` six dynamic call args in registers | `render.js`: `DYN_REGS` 4 to 6, so `porf_thk` entries take `u64 ra, jsval thisv` and six `jsval` | none for the chain; the template's `SproutThunk` typedef must follow it |
| `6f64fd79` strict assignments to captured bindings | `codegen.js` `isIdentAssignable` | none; `#457` (`A = A` on a class) is a different path and is still wrong, see below |
| `ea2d36c3` constructor returns test `new.target` by type | `codegen.js` | none (P1 anchors on `declareClass`) |
| `ece6782f`, `22159adc`, `f5eb200f`, `a97a0ae8` | `Math` constants, module export lists, `.d.ts` candidates, a pkg-config message | none |

Repros run on the **unpatched** alpha 23 tree (macOS arm64, `porf native`), 2026-11-12. All still fail, so no pass can be dropped:

| Issue | Result on stock alpha 23 |
| --- | --- |
| [#454](https://github.com/CanadaHonk/porffor/issues/454) | `decode(Buffer.from("hello world"), 6, 5)` gives `"|11"`, expected `"world|11"` |
| [#455](https://github.com/CanadaHonk/porffor/issues/455) | `new Date("2026-11-08 14:48:19.097+00")` and `...+0000` are `NaN` |
| [#456](https://github.com/CanadaHonk/porffor/issues/456) | `let o = 1; o || (o = {}); typeof o` is `"object"` |
| [#457](https://github.com/CanadaHonk/porffor/issues/457) | `class A {}; A = A; typeof A` is `"undefined"` |
| [#459](https://github.com/CanadaHonk/porffor/issues/459) | `replaceAll` over 148,890 characters 147 ms, over 628,890 characters 2,009 ms (4x input, 13.7x time) |
| [#460](https://github.com/CanadaHonk/porffor/issues/460) | `replace(/\d+/g, fn)` over 628,890 characters (80,000 matches) 3,653 ms stock, 26 ms patched; with a template string 3,564 ms stock, 45 ms patched. This is the pass the "regex rewrite" question is about: alpha 23 changes nothing in `builtins/regexp.ts`, so `patchRegexReplace` stays |
| [#461](https://github.com/CanadaHonk/porffor/issues/461) | `"é".toUpperCase()` and `"ж".toUpperCase()` are unchanged |
| [#462](https://github.com/CanadaHonk/porffor/issues/462) | not run (Linux glibc only); the anchor `const cReservedNames = new Set([` is still there once |
| [#463](https://github.com/CanadaHonk/porffor/issues/463) | `typeof Response.redirect` and `Response.error` are `"undefined"` |
| [#464](https://github.com/CanadaHonk/porffor/issues/464) | `JSON.parse` of 12,000 objects with `"naïve 中文 x<i>"` exits 139 |

All ten issues are still open, none has a comment or a linked PR. Our passes that are not upstream bugs (the 13 "ours") are
not covered by any upstream change.

## Counts

- 24 passes: 11 upstream, 13 ours.
- Of the 11 upstream: 10 have an upstream issue (#454 to #457 and #459 to #464, all open, none has a fix or PR yet) and 1 has none (`patchRepeatDoubling`, see below).
- No upstream PR covers any of the 24. The 2026-11-11 issues were filed without PRs: Porffor's AI policy
  does not allow LLM-written PR text, so any PR has to be opened with a human-written description.

Reproduced on unpatched upstream `a97a0ae` (macOS arm64, `porf native`) on 2026-11-11 before filing: all of the above except
`repeat`. Timings, 2 sizes each: `replaceAll` 96 ms at 80,000 characters and 1,386 ms at 320,000 (4x input, 14x time); regex
`replace` with a function 271 ms at 100,000 characters and 7,128 ms at 400,000 (26x). The one-line `select` fix and the P9 bound were
each applied to the clean tree and fixed their repro (`JSON.parse` of 48,000 objects, 1.5 MB, no longer crashes).

`repeat` is not quadratic: `"ab".repeat(16e6)` takes 105 ms (32 MB). `patchRepeatDoubling` only cuts a constant factor, so there is
nothing to report; consider dropping the pass.

## Issues we filed that are not tied to a pass

[#385](https://github.com/CanadaHonk/porffor/issues/385), [#386](https://github.com/CanadaHonk/porffor/issues/386),
[#387](https://github.com/CanadaHonk/porffor/issues/387), [#388](https://github.com/CanadaHonk/porffor/issues/388),
[#400](https://github.com/CanadaHonk/porffor/issues/400), [#425](https://github.com/CanadaHonk/porffor/issues/425),
[#426](https://github.com/CanadaHonk/porffor/issues/426), [#427](https://github.com/CanadaHonk/porffor/issues/427)
and [#428](https://github.com/CanadaHonk/porffor/issues/428) are closed. Open PRs of ours:
[#422](https://github.com/CanadaHonk/porffor/pull/422) (heap BigInts in conservative GC scans) and
[#423](https://github.com/CanadaHonk/porffor/pull/423) (globalThis rewrites only changed bindings);
[#395](https://github.com/CanadaHonk/porffor/pull/395) (TextEncoder astral chars) is merged.
