---
"@sproutboat/toolchain": patch
---

A minor collection no longer scans the entries block an object left behind when it grew. This is the object twin of the array fix: the block is garbage, but while it is old only a full collection frees it, and a minor one scanned it whenever a write to a neighbouring block dirtied its card. Its slots still pointed at objects that an earlier minor collection had freed, so the scan marked whatever had reused those blocks as the type the slot claimed (a reused array became a Promise, then SIGBUS or corruption). The abandoned block is now classed as a leaf. The other grow-and-copy sites were audited and need nothing: Map and Set keep their entries in arrays, the weak-object store zeroes its length before it is abandoned, and strings, typed-array buffers and bucket tables hold no references.
