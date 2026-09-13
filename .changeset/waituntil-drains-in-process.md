---
"@sproutboat/runtime": minor
---

`ctx.waitUntil` (baronunread/sproutboat#57): `fetch(request, ctx)` now takes a
second argument with `waitUntil(promise)`. Registered promises are drained,
in-process and sequentially, after the handler returns and before the turn
completes, capped at 25s for the whole batch — a task still running past that
keeps running, but stops holding up the response. A rejected task is
swallowed rather than failing the response.

`DurableObjectState.waitUntil` was a silent no-op stub; it now actually queues
and drains the same way, scoped to the instance. `alarm()` also used to be
fire-and-forget (its promise and any `state.waitUntil()` it queued were
dropped the moment the 204 went out) — both are now awaited.

Additive: a handler that ignores the second `fetch` argument is unaffected.
