---
"@sproutboat/toolchain": patch
---

Fix (baronunread/sproutboat#168): a `fetch` handler that resolves a promise
with a plain object — the common shape for a JSON response — could wedge a
standalone/native-fetch build at 100% CPU after a handful of requests, with no
error and no log line. Root cause: `__Porffor_promise_resolve`'s duck-typing
probe for `.then` walks the value's prototype chain with no termination
guard, and under certain allocator conditions the walk hits a fixed point
instead of `null`/`undefined`, spinning forever.

`patchPromiseTs` now guards the probe the same way `_internal_object.ts`'s own
prototype-chain walks already do elsewhere in the runtime: track the previous
prototype and stop once the "next" pointer stops advancing, reading a
fixed-point chain as "no `.then` found" instead of spinning. Not specific to
`Date.prototype.toISOString()` — an earlier note wrongly correlated the bug
with that one call; see `sproutboat-cli/patches/UPSTREAM.md`.
