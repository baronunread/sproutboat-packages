---
"@sproutboat/runtime": minor
---

`ctx.waitUntil` for `scheduled` and `queue` (baronunread/sproutboat#171):
both now take the same second `ctx` argument as `fetch`, drained the same way.

Also fixes a real bug found while wiring it up: `scheduled` and `queue` were
fire-and-forget regardless of `ctx` — an async handler's own promise was
dropped the instant the reply went out. For `queue` specifically, the default
"unhandled messages are acked" pass ran synchronously right after the
(discarded) call to the handler, so `ack()`/`retry()` calls made after the
handler's first `await` never reached the response. Both are now properly
awaited, on every delivery path: broker-dispatched, and the embedded
standalone binary's own local cron/queue/DO-alarm timers (the latter had the
same gap for `DurableObjectState.waitUntil` from #57 — that local path
bypassed the fix there entirely).

Additive: a handler that ignores the second argument is unaffected.
