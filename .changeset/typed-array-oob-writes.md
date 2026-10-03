---
"@sproutboat/toolchain": patch
---

Typed-array writes outside the array are ignored, as the spec requires, instead of overwriting the next allocation in memory (baronunread/sproutboat#241). `a[length] = x`, `a[-1] = x` (which wrote `a[0]`) and `a[1.5] = x` no longer touch any memory. The check uses the same index validation as reads and applies to user code; Porffor's own builtins write within bounds.
