---
"@sproutboat/runtime": patch
"@sproutboat/toolchain": patch
---

Faster requests: about 57% of a request's CPU was Porffor's `globalThis` getter.

- **Toolchain, the root cause.** Porffor's `#get_globalThis` re-synced every top-level function and `var` of the module into the global object on every read, one hashed write per binding (about 20 µs with the prelude's ~120 bindings, so every `globalThis.x` in user code paid it too). Every binding is now written when the object is built, and a later read rewrites only the bindings whose value changed (a packed copy of the last value written is kept per binding: an unchanged binding costs one compare). 20,000 reads with 600 top-level functions: 9,300 ms before, a few ms after.
- **Runtime and toolchain, the request path.** The runtime's `globalThis.__sbCompat` / `globalThis.env` reads go through accessors over module-level `let`s that the app tail sets once, and `Request`/`Response` cache the class lookups and take the date and WebSocketPair state from statics the runtime sets. Until the tail has run (the shared template, unit tests) everything reads `globalThis` as before.
- **Client IP.** `request.cf` no longer reads and splits `SB_TRUSTED_PROXIES` four times a request: it is read once per process, and with no trusted proxy (the usual case) the peer is the client and the forwarded-header lookups are skipped.
- **`x-sb-cpu-ms`.** The stamp is appended to the handler's own Response instead of building a second Response with a copy of every header. The same responses are stamped, with the same headers and body.

A 404 on one pinned x86 core, CPU per request when saturated, standalone: 319 µs before, 127 µs with the getter patch alone, 113 µs with the request-path change, 81 µs with the client-IP and stamp changes.
