---
"@sproutboat/toolchain": patch
---

Pin Porffor alpha 9, including alpha 8's compiler and GC fixes and alpha 9's ESM module support. Adapt the native-fetch link and compile-flag patches to Porffor's split C-unit build. Preserve the published 0.4.11 `TypedArray.from` workaround, which alpha 9 still needs. Re-vendor the verified alpha 9 source archive. The uWebSockets commit is unchanged.
