---
"@sproutboat/runtime": patch
"@sproutboat/toolchain": patch
---

Faster requests: about 57% of a request's CPU was Porffor's `globalThis` getter.

- **Toolchain, the root cause.** Porffor's `#get_globalThis` re-synced every top-level function and `var` of the module into the global object on every read, one hashed write per binding (about 20 µs with the prelude's size, so every `globalThis.x` in user code paid it too). Function bindings are fixed references, so they are now written once when the object is built; only `var` bindings, whose values can change, still follow their binding on each read. 20,000 reads with 600 top-level functions: 9,300 ms before, 53 ms after.
- **Runtime and toolchain, the request path.** The runtime's `globalThis.__sbCompat` / `globalThis.env` reads go through accessors over module-level `let`s that the app tail sets once, and `Request`/`Response` cache the class lookups and take the date and WebSocketPair state from statics the runtime sets. Until the tail has run (the shared template, unit tests) everything reads `globalThis` as before.
- **Client IP.** `request.cf` no longer reads and splits `SB_TRUSTED_PROXIES` four times a request: it is read once per process, and with no trusted proxy (the usual case) the peer is the client and the forwarded-header lookups are skipped.
- **`x-sb-cpu-ms`.** The stamp is appended to the handler's own Response instead of building a second Response with a copy of every header. The same responses are stamped, with the same headers and body.
