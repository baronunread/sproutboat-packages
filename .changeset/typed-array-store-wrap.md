---
"@sproutboat/toolchain": patch
---

Integer typed-array stores wrap modulo 2^n as the spec requires, instead of saturating (part of baronunread/sproutboat#238). Porffor converted the stored value with a saturating float-to-int conversion, so `uint32[i] = x | 0` stored 0 for any negative `x`, `int32[i] = 4e9` stored 2147483647, and `fill`/`set`/`from` had the same bug. This broke pure-JS hashing such as @noble/hashes' SHA-256, which now matches Node.
