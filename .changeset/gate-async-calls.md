---
"@sproutboat/runtime": patch
---

The asynchronous `fetch()` and service-binding behaviour from 0.20.0 now starts at compatibility date `2026-10-22`. Before, it applied at every date, which broke apps that use the result without `await`, such as the CLI's kitchen-sink: `const r = fetch(url); r.body`.

From `2026-10-22`, in a deployed sprout:

- `fetch()` and `env.SERVICE.fetch()` return promises and run off the event loop;
- responses stream;
- redirects are followed;
- a callee's error is thrown in the caller;
- a callee sees its caller's URL.

With an earlier `compatibility_date`, a deployed sprout's `fetch()` and binding calls answer at once with a `Response`, as they did before 0.20.0. To get the new behaviour, move `compatibility_date` to `2026-10-22` and rebuild.

These stay ungated:

- sproutd answered with promises at every date, and still does;
- RPC calls are always asynchronous;
- abort signals, `Set-Cookie` and `Content-Type` work at every date.
