---
"@sproutboat/runtime": minor
"@sproutboat/toolchain": minor
---

Service-binding calls and outbound `fetch()` no longer block a deployed sprout. In a deployed sprout, each call runs off the event loop on one I/O thread, so the sprout keeps answering other requests while a call is in flight. Concurrent calls overlap: eight 500 ms calls finish in about 510 ms, where they used to queue for about 4 s. A deployment can also call itself through a binding, to any depth, where this used to deadlock. The toolchain installs the loop hook the runtime uses for this; with an older runtime it does nothing.

`env.SERVICE.fetch()` now always returns a promise, as in Workers, and reads its arguments as `fetch()` does:

- a `URL` object works as input;
- `fetch(request, init)` keeps the request's body when `init` sets no body of its own;
- a `ReadableStream` body is sent whole, where it used to arrive as the text `[object ReadableStream]`.

Responses from bindings and from `fetch()` keep every `Set-Cookie` header, where they used to keep only the last one.

A broker exchange is now resent only when the broker cannot have acted on it: the request never fully left, or the connection had gone stale. A `fetch` or service call that the broker may already have run is no longer repeated.
