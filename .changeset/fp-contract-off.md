---
"@sproutboat/toolchain": patch
---

Compile every unit with `-ffp-contract=off` (baronunread/sproutboat#235). On arm64, clang fused `a * b + c` into a single FMA that rounds once, where JavaScript rounds after the multiply and again after the add, so native sprouts could compute different doubles from V8 for the same code. A seeded LCG diverged at step 23.
