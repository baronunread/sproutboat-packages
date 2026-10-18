---
"@sproutboat/toolchain": patch
---

Reclaim large native heaps after 500 ms without a completed request, and release oversized GC mark-queue scratch storage. Preserve the existing request collector and live application state. Extra collection is limited to heaps over 8 MiB or mark queues over 65,536 entries.
