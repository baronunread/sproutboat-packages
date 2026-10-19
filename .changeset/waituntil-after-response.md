---
"@sproutboat/runtime": patch
---

A fetch handler's response no longer waits for its `ctx.waitUntil` work: the response goes out as soon as the handler returns and the background work keeps running, still capped at 25 s, as in workerd. A handler that scheduled 1.5 s of background work used to answer 1.5 s late. The cap's timer is also cleared once the work finishes, so a sprout no longer keeps a timer pending for 25 s after every `waitUntil`. `scheduled` and `queue` handlers still finish their `waitUntil` work before they reply.
