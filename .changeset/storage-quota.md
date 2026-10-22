---
"@sproutboat/runtime": minor
---

A storage quota for standalone sprouts and sproutd. An app's data directory (KV, D1, R2, Durable Object storage, queues) holds at most `SB_STORAGE_MAX_BYTES` bytes; sproutd sets it per app, and it defaults to 10 GiB. Each D1 database is also capped at 10 GB, as in D1. Past the quota:

- writes fail with an error that says so, such as `KV put() failed: storage quota exceeded (this app stores N bytes; the limit is M)`, or `D1_ERROR: database or disk is full: SQLITE_FULL` for D1;
- reads and deletes keep working, so an app can make room (for D1, `DELETE` and then `VACUUM`).

This is a check after a scan, not a hard filesystem cap with zero overshoot. The size is measured at most once a second, by walking the directory, and a write is checked against the last measurement. The write that crosses the limit is accepted (an R2 object, say), and so is anything else written within that second. Writes after it are refused.
