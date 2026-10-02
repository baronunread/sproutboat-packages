---
"@sproutboat/toolchain": patch
---

`String.prototype.replaceAll` is linear instead of quadratic (baronunread/sproutboat#237). Porffor grew the result with one full-copy `strcat` per match; a patch to `compiler/builtins/string.ts` collects the pieces and joins them once. Replacing in a 2.1 MB string went from about 42 s to 71 ms (Node: 36 ms), with identical output.
