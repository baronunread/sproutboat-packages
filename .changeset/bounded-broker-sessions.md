---
"@sproutboat/wire": minor
"@sproutboat/runtime": patch
"@sproutboat/toolchain": patch
---

Add an opt-in bounded multi-session broker worker with private supervisor control.
Fence queue acknowledgements to durable delivery claims and retain recoverable alarm deliveries across process crashes in broker and embedded transports.

Resume native R2 downloads until completion or renewed backpressure instead of leaving large responses stalled.

Retain partially written TCP replies until drain and serialize pipelined replies so large broker-backed R2 reads cannot truncate or interleave frames.

Honor wildcard, weak and list-based If-None-Match conditions on broker direct downloads.

Move D1 queries, batches, exec and backups off the shared broker event loop into two lazy SQL threads per broker process. Preserve database affinity, transaction rollback and session isolation, and bound queued work with per-session admission and queue deadlines. Running SQLite statements remain non-preemptible; keep shared mode opt-in.

Enforce shared D1 execution budgets through a capability-protected native SQLite progress hook. Interrupted batches roll back and lanes remain usable. A broker watchdog revokes all sessions if native work cannot be interrupted; uncertain SQL outcomes are never automatically retried. Build the small SQLite extension during host/image preparation.
