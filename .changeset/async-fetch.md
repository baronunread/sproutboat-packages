---
"@sproutboat/runtime": patch
---

A host that runs an event loop can let `fetch()` run without blocking the sprout: after `sb_async_enable()`, outbound requests run on up to 8 threads and resolve their promises when the host calls `sb_async_drain()`. Nothing changes for standalone sprouts, where `fetch()` stays synchronous.
