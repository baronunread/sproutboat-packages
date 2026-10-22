---
"@sproutboat/runtime": minor
---

The storage quota is a hard bound when LTX capture is on. A D1 database under capture can't be capped by pinning its page count: a same-size `UPDATE`, or a `DELETE`, still adds a file to the replication spool, and the spool counts toward the app's quota. So while the app is over its quota, every write to a captured database is refused with `D1_ERROR: storage quota exceeded: writes are refused while this app's data, including its replication log, is over its quota: SQLITE_FULL`. That covers `exec()` and `batch()` too.

- Reads, read-only batches and transaction control still run.
- No LTX file is ever dropped to make room: the policy fails closed.
- Writes resume once the app is under its quota again (for example after the operator raises it).

Databases without capture are unchanged: they are pinned at their size, so deletes still work.
