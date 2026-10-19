---
"@sproutboat/toolchain": patch
---

`String.prototype.repeat` copies in doubling chunks instead of once per repetition: repeating a 600 KB string went from about 2.4 ms to under 0.1 ms.
