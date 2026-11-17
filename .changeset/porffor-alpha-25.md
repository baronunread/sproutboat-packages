---
"@sproutboat/toolchain": minor
---

Porffor alpha 25 (`c9af40c`, npm `0.0.0-alpha.25`) replaces alpha 24 as the one supported Porffor, for standalone builds and the a21 line alike. The toolchain still supports one alpha at a time.

- The patch series is rebased onto alpha 25: 25 patches plus the generated `builtins_precompiled.js`, none dropped. Three needed a hand merge (the shared-dispatch closure in `generateCall` for P8 and P10, and the small-heap nursery cap, now eight times live, under our memory-limit clamp for the collector hooks). `vendor/porffor-patched.tar.gz` and its manifest are the alpha 25 tree.
- The repros for #454 to #457 and #459 to #464 still fail on stock alpha 25 and pass on the patched tree.
- `SPROUTBOAT_PORFFOR_CHANNEL` accepts `alpha-25`; `alpha-24` joins 19 and 21 to 23 as "no longer supported". `PORFFOR_A24_*` constants are `PORFFOR_A25_*`.
- CI: the `native` jobs are named `native (alpha-25)` and `native (macOS arm64, alpha-25)` (the repository ruleset's required checks follow).
