---
"@sproutboat/runtime": minor
---

From the proposed compatibility date 2026-11-16, `fetch()` on the standalone binary runs off the event loop. It used to run each request to the end before it returned, so 20 concurrent fetches to a 100 ms endpoint took 2,000 ms and every other request waited behind them. They now go to a pool of up to 32 I/O threads (the same client sproutd runs on 8), the handler suspends, and the server keeps serving; the 20 fetches take about 100 ms. The reply is delivered on the loop through the uWS waker the standalone server already installs for outbound WebSockets, so JavaScript still runs on one thread. Earlier dates keep the synchronous call, because a handler that relied on one request at a time across an `await fetch()` now interleaves with others, as it does in workerd. Behaviour on sproutd and through the broker is unchanged.
