---
"@sproutboat/runtime": patch
---

Fix (baronunread/sproutboat#179): `__sbEntry` called `handlers.fetch()` (and
the `scheduled`/`queue`/`alarm` trigger paths) with no try/catch at all. Any
synchronous throw, or an async handler's rejected promise, propagated all the
way up and took down the entire process — not just the request that hit it,
but every other in-flight and future request on that sprout, until whatever
supervises it restarts the binary.

A throw from `fetch()` now returns a 500 instead. `scheduled()` and `alarm()`
still reply 204 either way (they had no failure signal before this either).
A throw from `queue()` falls through to the existing default-ack pass, the
same outcome as a handler that returns without calling `ack()`/`retry()` on
every message.

`entry-crash.test.js` covers the fetch path: a sync throw, an async
rejection, and that a throwing request doesn't stop the next one from being
served.
