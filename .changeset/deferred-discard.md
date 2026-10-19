---
"@sproutboat/toolchain": patch
---

Allocation-heavy handlers are up to 4.5x faster in standalone sprouts (a regex scan went from 140 to 31 ms per request). Full garbage collections under load no longer return free pages to the OS, which made the next allocations fault them back in; the idle collection returns them instead, now also for small sprouts that never reach a full collection. Memory after 3 s idle is unchanged; during traffic a sprout keeps more of its heap (baronunread/sproutboat#287).
