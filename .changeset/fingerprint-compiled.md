---
"@sproutboat/toolchain": patch
---

A CLI compiled with `bun build --compile` builds again. 0.8.0 embedded the patch sources with text imports to fingerprint them, but Bun bundles a text import of `patch.ts` as the module `patch.ts` is everywhere else, so compiling failed with `No matching export ... for import "default"`. The fingerprint now hashes the sources when they are on disk, and falls back to the fingerprint they were released with (`RELEASED_FINGERPRINT`, kept current by a test). The value is unchanged, so existing caches stay valid.
