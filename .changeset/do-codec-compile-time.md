---
"@sproutboat/runtime": patch
---

Cold standalone builds are fast again. Runtime 0.29.0's Durable Object storage codec named
eight typed-array constructors, which linked each builtin into every app and added about
7 s (45%) to an uncached build (16 s to 23 s for a one-line app on an M-series Mac). The
CLI's native-restore test passed its 600 s CI timeout.

From compatibility date `2026-10-28`, Durable Object storage round-trips `Uint8Array`,
`DataView` and `ArrayBuffer`. Any other typed array now throws a DataCloneError in
`put()` instead of being stored: keep its bytes in a `Uint8Array`. Before this change
they came back with the wrong type. Earlier dates are unchanged.
