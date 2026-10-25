---
"@sproutboat/toolchain": minor
---

Faster string building in compiled apps. A loop of `s += e;` statements on a function's local string variable now appends into the string's spare room instead of copying the whole string every time, so building a string is linear instead of quadratic: a compile-time pass gives the variable a hidden ownership flag, and any other read or write of it ends the in-place run (and gives spare memory back first, so a string that outlives its loop costs what an exact copy would). `replace(regex, fn)` with a global regexp finds its matches as positions instead of exec result objects and joins the pieces once (it also copied the whole result per match), as does `replace(regex, "$&...")`. `charCodeAt` with an in-range number index and `JSON.parse` read characters directly. On sproutd's regex-scan benchmark, plain Porffor goes from 5.5 to about 1.2 ms per call on an M1. Generated programs change, so compiled apps get a new toolchain fingerprint.
