---
"@sproutboat/toolchain": minor
---

Porffor alpha 23 (`a97a0ae`, npm `0.0.0-alpha.23`) joins the alpha 21 line as a third pin, and standalone builds default to it (`SPROUTBOAT_PORFFOR_CHANNEL=alpha-22` or `alpha-19` select the earlier compilers). The whole patch chain applies unchanged: alpha 23 touches no builtin or runtime file, so no pass is dropped and `patchRegexReplace` stays (stock alpha 23 still takes 3.6 s to `replace(/\d+/g, fn)` over 80,000 matches, patched 26 ms). `channelOfTree` tells the three trees apart, and P8 and P10 apply on every tree but alpha 21's.
