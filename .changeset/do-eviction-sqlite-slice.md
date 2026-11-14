---
"@sproutboat/runtime": minor
---

SQLite page caches start small and grow on evidence, and one function closes a database handle (design 07 stage 1c, plan 018 phase 1).

- Every database opens with a 256 KiB page cache (`PRAGMA cache_size=-256`). Every 64th use, a cache over 90% full with over 10% misses doubles, up to 2 MiB or its share. The share is `T / open databases`, where `T` is `SB_MEMORY_LIMIT / 8` (4 MiB at 32 MiB); when a database opens and the sizes no longer fit under `T`, the stalest go back to their share. `SB_SQLITE_CACHE_MB` keeps its meaning and fixes the size. `sqlite3_soft_heap_limit64(T)` is set when a limit is known. A standalone binary without a limit starts at 256 KiB and grows to 2 MiB.
- The handle table holds 64 databases (was 16). Object databases (`storage.sql`) take at most `clamp(T / 160 KiB, 8, 48)` of them (25 at 32 MiB; 48 with no limit; was 8), and the slot used longest ago is closed first, but never one inside a transaction or savepoint.
- `sb_db_close` is the only place a handle is closed (statement cache, a TRUNCATE checkpoint if the connection wrote, `sqlite3_close`, which must return OK; `SQLITE_BUSY` leaves the slot open and is counted). New ops `do.sql.close`, `do.stats` and `do.release`.
- The storage quota scan runs every second per 1,000 files (at most every 10 s) instead of every second: at 5,000 object files the walk takes 7 ms, at 15,000 about 20 ms. A write can overshoot the quota by up to that interval.

Nothing an app can observe changes except lower SQLite memory and the longer quota interval; the ABI hash changes with the prelude.
