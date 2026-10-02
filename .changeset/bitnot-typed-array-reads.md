---
"@sproutboat/toolchain": patch
---

Two more spec fixes for uuid (baronunread/sproutboat#238):
- **Unary `~`** now applies ToInt32 (wrapping modulo 2^32) instead of a saturating conversion. `~x` for `x >= 2^31`, the `~~x` truncation idiom and `~Infinity` were all wrong, which broke uuid's SHA-1.
- **Typed-array reads** with an index outside the array, or a negative or fractional index, return `undefined` instead of reading neighbouring memory. uuid's v5 UUIDs used to change from run to run because its SHA-1 reads past its buffer. The check applies to user code; Porffor's own precompiled builtins keep their reads.
