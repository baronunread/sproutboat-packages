---
"@sproutboat/toolchain": patch
---

toolchain: a macOS standalone build links again (regression of sproutboat-packages #261, @sproutboat/runtime 0.45.0 with toolchain 0.25.0). The prelude's streamed-response pump declares `sb_stream_pending` and `sb_stream_wait` as weak references so a host without flow control (a standalone executable) is unchanged; ELF links an undefined weak reference as null, Mach-O does not, so every macOS standalone build failed with "Undefined symbols". The standalone server's stream registry now defines both (nothing is ever unacknowledged, nothing to wait for: the same behaviour as the null the prelude expected). The runtime, sproutd's host (which defines both for real) and the generation are untouched. A macOS standalone build with runtime 0.45.0 needs this toolchain (0.25.1 or later).
