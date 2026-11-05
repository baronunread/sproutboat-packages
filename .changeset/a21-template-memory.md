---
"@sproutboat/toolchain": patch
---

toolchain a21: the fork template's heap is immortal in its workers. `porf_gc_seal_heap` now seals every page the template filled (small and span), pre-sets their mark bits and records the template top; a worker's full collection neither clears nor sets a sealed page's bits nor sweeps it, finds what template objects came to reference through sticky cards (never cleared below the template top, scanned by every collection), and a raw mark no longer writes an already-set bit. The megamorphic inline cache can be frozen (`__Porffor_object_icFreezeMega`, called by sproutd's template after its warm-up) so workers read the template's entries and never write one. Measured on sproutd's alpha 21 generation (M6 density gate): a worker's private memory after its first request and collection drops from 660 to 448 KiB. Nothing changes for the alpha 19 channel.
