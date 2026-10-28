---
"@sproutboat/runtime": minor
---

Two settings for the SQLite databases a standalone binary opens, both off or unchanged unless set. `SB_SQLITE_EXCLUSIVE=1` runs every database in `PRAGMA locking_mode=EXCLUSIVE`: the lock is taken once and held, so a transaction no longer takes and releases file locks around itself, and the WAL index lives in heap memory instead of a shared `-shm` file. No other process can open the database while the binary runs (so the several-copies-behind-`SO_REUSEPORT` recipe, and `sproutboat kv/d1 --local --data-dir` against a running binary, need it off). `SB_SQLITE_CACHE_MB=<n>` (1 to 4096) sets each database's page cache in MiB; unset it stays at today's 2 MB (`cache_size=-2000`).
