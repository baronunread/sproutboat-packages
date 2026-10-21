---
"@sproutboat/runtime": minor
"@sproutboat/wire": minor
---

`fetch()` and service bindings honour an abort signal, set as `init.signal` or a `Request`'s `signal`:

- A signal that is already aborted rejects the call at once.
- Aborting it later, by hand or through `AbortSignal.timeout()`, rejects the pending call with the signal's reason.

In a deployed sprout the abort also stops the work. The sprout closes the call's broker connection, the broker aborts its upstream request when a sprout's connection closes, and the platform's edge stops the callee's request in turn. Before, an abandoned call ran to the end anyway.

In sproutd the request still runs to the end, and its late reply is dropped.

In `@sproutboat/wire`, `Broker.handleFrame` takes an optional `AbortSignal`, which the broker server aborts when the connection closes.
