---
"@sproutboat/toolchain": patch
---

A minor collection no longer scans the entries block an array left behind when it grew. The block is garbage, but while it is old only a full collection frees it, and a minor one scanned it whenever a write to a neighbouring object dirtied its card. Its slots still pointed at objects that an earlier minor collection had freed, so the scan marked whatever had reused those blocks as the type the slot claimed: a reused array became a Promise, and the collector followed its "reaction chain" into unmapped memory (SIGBUS, exit 138) or corrupted what it found. Promise's list of pending rejections is such an array, and it grows whenever a single request rejects more promises than the list has room for; the Durable Object transaction guard (a rejection per refused call) tripped it about 220 requests into the conformance suite on the broker transport. The abandoned block is now classed as a leaf.
