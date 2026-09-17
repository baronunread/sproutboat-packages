---
"@sproutboat/toolchain": patch
"@sproutboat/runtime": patch
---

Revert native R2 transfer size-gating (#202). It saved ~11KB of `__text`
(~1.3% of a typical binary) and on macOS didn't even change the shipped
file size, since `__TEXT` is page-aligned. Not worth the `#ifdef`
guard-placement bug class it introduced. R2 transfer support is native code
again, always compiled in with 404 stubs where unused, same as before #202.
