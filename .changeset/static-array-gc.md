---
"@sproutboat/toolchain": patch
---

A collection no longer frees the entries of an array that Porffor compiles into its static data and that later grew onto the heap. Promise keeps its pending rejections in such an array: its entries block was swept at every collection while the array still pointed at it, so the next rejection or handled rejection wrote into whatever had reused that block (a string another request had built, an array's slot) and a request could resume to find a string it built before an await had become empty. Porffor's static-array shape check rejected any entries pointer outside the static image, so the entries were never marked. It now accepts a heap block start, as the check for ordinary arrays already did.
