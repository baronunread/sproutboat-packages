---
"@sproutboat/runtime": minor
---

Durable Objects leave memory when idle and are constructed again by their next event, behind compatibility date 2026-11-21 (design 07 stage 1c, plan 018 phase 2). Before the date nothing changes.

- **Eviction.** Every object has a record; an event of any kind (RPC, `stub.fetch`, alarm, hibernatable socket event, socket restore) enters through one function, counts the object busy until the event and its `waitUntil` drain have settled, and runs in an async-context frame that names the object. An object is evicted, in one synchronous turn, when nothing is in flight, nothing waits at its input gate, no `blockConcurrencyWhile` or transaction is open, nothing pins it, and its hibernatable sockets can go back to the host. Its storage, alarm, and SQLite file stay (the file is checkpointed and closed: one clean file). The next event runs the constructor again before the event.
- **Settings** (environment; sproutd sets them from `limits`): `SB_DO_IDLE_MS` (default 10,000; 0 turns idle eviction off), `SB_DO_MAX` (default 16 per MiB of `SB_MEMORY_LIMIT`, 64 to 4,096; 4,096 with no limit), `SB_DO_WAIT_MS` (5,000), `SB_DO_QUEUE_MAX` (1,024).
- **The cap and the overloaded error.** At `SB_DO_MAX` objects the first event of a new object evicts the stalest idle one; with none idle it waits up to `SB_DO_WAIT_MS`, then fails alone with an error whose `overloaded` is `true`. More than 1,024 events queued behind one object's gate fail the same way.
- **Pins.** A pending `setTimeout` or `setInterval`, an unawaited `fetch`, an open plain WebSocket, outbound WebSocket or `connect()` socket, and a streamed response keep the object in memory. The timer globals become wrappers once the first object is built; the prelude's own timers use the runtime's.
- **Revoked instances.** A leftover closure of an evicted instance throws "This Durable Object instance was evicted from memory." instead of writing as a second instance. `abort()` and a `blockConcurrencyWhile` that rejects or runs 30 s reset the object the same way (events waiting at its gate fail).
- **Alarms.** The embedded pass runs its claimed batch concurrently and renews the claim; `alarm()` gets the delivery row's attempt count, so `retryCount` survives eviction; an alarm that cannot get a slot is released without counting an attempt.
- **Host.** Parked sweep timer (op `D`), giving hibernatable sockets back (ops `U`, `g`); a host without them pins objects that hold such sockets, and sweeps when the next event arrives. A standalone binary keeps every object with an open socket in memory.
- A counters line (`objects_awake`, `evicted_idle`, `wake_us`, ...) goes to the host as a note, or to stderr with `SB_DO_STATS=1`.

Not in this release: the memory-pressure eviction trigger (it waits for plan 016's pool).
