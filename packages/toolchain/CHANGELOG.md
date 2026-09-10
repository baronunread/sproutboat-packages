# @sproutboat/toolchain

## 0.3.0

### Minor Changes

- New package: `@sproutboat/toolchain` — the single home for the Porffor pin
  (`pin.ts`), the source patches (`patch.ts`: `ensurePorfforPatched` plus the
  `$PORT`, request-body-limit, status-line, console-sink and remote-address
  passes), and `ensurePorffor()` (fetch, verify sha256, extract, patch, cache in
  `~/.cache/sproutboat`).
  
  `sproutboat-cli` and the `sproutboat` monorepo both depend on it instead of
  carrying their own copies, so the pin and the patch set can no longer drift —
  which they had (the monorepo was on `alpha-4` and applied 1 of the ~13 patches).
