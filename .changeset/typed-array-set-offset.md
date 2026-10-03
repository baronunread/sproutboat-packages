---
"@sproutboat/toolchain": patch
---

`TypedArray.prototype.set(source)` without an offset copies to index 0 (part of baronunread/sproutboat#238). Porffor computed the offset as `Math.trunc(undefined)`, which is NaN, so a same-type copy wrote nothing where it should and went to the wrong place in memory instead. This dropped HMAC keys in @noble/hashes and killed the process after the first request. The offset now goes through `ToIntegerOrInfinity` as the spec says. @noble/hashes' SHA-256 and HMAC match Node and keep serving.
