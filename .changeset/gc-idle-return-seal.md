---
"@sproutboat/toolchain": minor
---

Smaller idle sprouts: the idle collection now returns every free heap run to the OS, not only runs of 256 KiB or more, so a small sprout gives back its request garbage once it goes quiet. Adds `porf_gc_seal_heap()`, which sproutd's fork template calls before fork so workers allocate in fresh pages instead of copying template pages (sproutd #32). Generated programs change, so compiled apps get a new toolchain fingerprint.
