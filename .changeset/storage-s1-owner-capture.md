---
"@sproutboat/runtime": minor
---

Storage stage S1 (design 029), dark: nothing changes for any app until a host sets new environment variables, so no compatibility date is needed. A native host (sproutd) turns the features on per app; a standalone binary stays as it was.

- `SB_OWNER_LOCK=1`: the first captured-file open or Durable Object construction of a process takes an exclusive `flock` on `DATA/.owner.lock` and keeps it until the process dies. A second worker of the same app waits up to `SB_OWNER_WAIT_MS` (default 5000) and then fails that call without changing any state, so the next call retries. `deny` fails at once (a canary). This replaces the per-file `<db>.ltx.lock` for apps that set it.
- `SB_LTX_SCOPE=d1,store,do-sql` captures every file of the listed kinds as LTX (the old `SB_LTX_DATABASE`, one D1 binding, still works when the scope is unset). A captured Durable Object SQL handle can now leave the handle table and come back: it settles its spool on close (checkpoint, clean position record) and reopens without reading every page.
- `SB_LTX_ROOT=DIR` puts each file's spool under `DIR/<key>/` (`d1/NAME`, `store`, `do-sql/CLASS/FILE`) instead of beside the database, with group-readable files and directories for a shipper process, and keeps a dirty list at `DIR/dirty`.
- The position record is now `LTXPOS3`: it adds `epochSeq` (only grows, also after a lost spool) and, in a clean record, the database file's inode and mtime. A file that was `LTXPOS2` starts a new epoch (one full image) the first time a worker of this version opens it. Epoch directories are random names made with `mkdir`, not `mkdtemp`.
- When `store` is in the scope, Analytics Engine datapoints, rate-limit windows and the Cache API use `volatile.sqlite`, which is never captured. Rows already in `store.sqlite` are left there unused.
- A failed capture start no longer leaves its failed flag on the slot for the next file that takes it.

Generation impact: this changes the inline C every app with bindings compiles, so it rides a runtime generation and goes through the normal requalification.
