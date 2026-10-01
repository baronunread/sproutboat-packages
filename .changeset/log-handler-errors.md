---
"@sproutboat/runtime": patch
---

Log uncaught handler exceptions to stderr before answering 500, as `Uncaught (in fetch) Error: ...` (and `scheduled` / `alarm` for those triggers). A thrown or rejected handler used to produce a bare 500 with nothing logged, which hid baronunread/sproutboat#168 entirely.
