---
"@sproutboat/runtime": patch
---

Create the LTX page-index scratch file inside the database's replication spool
instead of libc's global temporary directory, fixing capture initialization when
a worker's filesystem sandbox permits writes only beneath its own state directory.
The scratch file is private and immediately unlinked, so closing the writer or
killing the process releases it. Its transient disk use is not counted by the
directory-walk quota. Capture retains its existing explicit opt-in and compatibility
date of 2026-10-22; capture-off apps and earlier dates keep their existing behavior.
