---
"@sproutboat/runtime": patch
---

Non-ASCII text read back from bindings no longer comes back garbled (baronunread/sproutboat#189). D1 rows, KV values, cached bodies, R2 metadata and SQLite error messages returned "café" as "cafÃ©" in both standalone builds and broker-backed deployments: the reply JSON is UTF-8, but it reached the handler one char per byte. Replies are now escaped to ASCII before parsing. Outbound `fetch()` bodies and BLOB columns keep their raw bytes.
