---
"@sproutboat/toolchain": patch
---

Faster allocation-heavy handlers on native-fetch builds: a collection after a request no longer unmaps the heap above its top. It keeps 16 MiB there, as plain Porffor does, and the idle collection still trims it. On othello, regex-scan made about 3,600 page faults per request and spent 17 ms more per request than the same code in the handler. Compiled apps get a new toolchain fingerprint.
