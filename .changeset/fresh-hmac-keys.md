---
"@sproutboat/toolchain": patch
---

Fix `TypedArray.from` with array-like inputs in native binaries, and regenerate Porffor's builtins table when its compiler is unpacked through a symlinked temporary path. This preserves the key bytes in repeated HMAC signing with `Uint8Array.from({ length: 16 }, mapFn)`.
