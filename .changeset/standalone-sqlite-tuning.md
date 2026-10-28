---
"@sproutboat/runtime": minor
"@sproutboat/toolchain": minor
---

A standalone binary now opens its SQLite databases in `PRAGMA locking_mode=EXCLUSIVE` by default, with the page cache at 2 MB (`cache_size=-2000`, unchanged). The lock is taken once and held, so a transaction no longer takes and releases file locks around itself, and the WAL index lives in heap memory instead of a shared `-shm` file. The cost: no other process can open the database while the binary runs, so the `sqlite3` shell, `sproutboat kv/d1 --local --data-dir` against a running binary, and the several-copies-behind-`SO_REUSEPORT` recipe do not work on a live binary. Set `SB_SQLITE_EXCLUSIVE=0` to opt out and keep shared locking. A database under LTX replication is never opened exclusive.

The default belongs to the standalone binary only: the toolchain's native server shim sets `SB_SQLITE_EXCLUSIVE=1` at startup unless the variable is already set. The embedded transport itself reads only `SB_SQLITE_EXCLUSIVE` (`1` is exclusive, anything else is shared), so sproutd and the broker keep shared locking unless an operator sets it.

`SB_SQLITE_CACHE_MB=<n>` (1 to 4096) sets each database's page cache in MiB; unset it stays at 2 MB.
