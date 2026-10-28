---
"@sproutboat/toolchain": minor
---

A standalone binary can use every CPU core. On start it forks `SB_WORKERS` worker processes (default: one per CPU the process may use, from its affinity mask and cgroup quota; one off Linux, where SO_REUSEPORT does not spread connections). Each worker has its own listen socket (SO_REUSEPORT), JS heap, event loop and SQLite connections. The supervisor restarts a worker that dies, drains on SIGTERM or SIGINT (workers stop accepting and finish the async responses, request bodies and streams in flight; `SB_SHUTDOWN_GRACE_MS`, default 30 s, bounds it), and exits 1 if workers crash-loop (8 deaths in 30 s). `SB_WORKERS=1` does not fork: it is the old single process. Each worker sees `SB_WORKER_INDEX`.

What it means for an app:

- D1, KV, R2, Cache, Analytics Engine and rate limiters keep their data in SQLite, so every worker shares it. Each connection now gets a 5 s busy timeout before the runtime's own pragmas, and the first connection to the shared `store.sqlite` holds a file lock while a worker creates its tables, so workers starting together neither fail with SQLITE_BUSY nor race the schema migrations. A D1 batch that reads before it writes can still return SQLITE_BUSY when another worker commits in between (SQLite cannot upgrade a stale read snapshot); batches that begin with a write wait for the lock.
- Cron and `setInterval` timers the runtime starts for cron, queue consumers and Durable Object alarms run in worker 0 only, so cron fires once. An app that consumes queues or has Durable Objects runs one worker (the probe worker finds out before it listens), and so does `SB_LTX_ENABLE=1`.
- Module-level state, caches, WebSocket connections and timers the app starts itself are per worker, as they are per isolate on Workers. Set `SB_WORKERS=1` for an app that needs one process.
- Not waited for when draining: direct R2 transfers and open WebSockets.

Only the standalone server's shim changes (`workers.ts`). render.js, the prelude and the transport are untouched, so sproutd's apps are byte for byte what they were. New tests: `workers.test.ts`, `test:native-workers`, and `test:native-workers-embedded` (needs standalone builds of the fixtures).
