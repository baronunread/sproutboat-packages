---
"@sproutboat/toolchain": minor
---

Porffor alpha 24 (`1b8225e`, npm `0.0.0-alpha.24`) is now the only supported Porffor, for standalone builds and the a21 line alike. It adds TypeScript lowering (namespaces, enums, parameter properties) and decorators.

- Our Porffor changes are a git patch series in `porffor-patches/` (26 patches, `scripts/porffor-patches.ts apply|export|vendor|verify|check`), and the toolchain ships the already-patched tarball (`vendor/porffor-patched.tar.gz`, checked against `vendor/porffor-patched.json`). Nothing is patched on the user's machine any more.
- Alphas 19, 21, 22 and 23 are removed. `SPROUTBOAT_PORFFOR_CHANNEL` accepts `alpha-24`; the old names fail with "no longer supported".
- The standalone server pieces that came from the alpha-19 tree (the uWebSockets shim, the web classes, the HTTP/1.0 edit and the uWebSockets patches) are vendored as our own files under `a21/standalone-server/`, byte-identical to what alpha 19 produced (`scripts/standalone-sources.ts verify`).
- The alpha-19 restore objects are gone with alpha 19 (the CLI's `--with-restore` is removed).
- No patch was dropped: the repros for #454 to #457, #461 and #463 still fail on stock alpha 24.
