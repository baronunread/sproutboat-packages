---
"@sproutboat/runtime": patch
"@sproutboat/toolchain": patch
---

Faster requests: the per-request paths no longer read `globalThis`. Porffor's `globalThis` is a getter that writes every top-level function and `var` of the module into a fresh object on each read (about 20 µs with the prelude's size), and a plain request made about eleven such reads (`globalThis.__sbCompat` and `globalThis.env` in the runtime, `globalThis.FormData`, `URLSearchParams`, `ReadableStream`, `WebSocketPair` and `__sbCompat` in `Request` and `Response`). The runtime now reads the compatibility date and `env` through two accessors backed by module-level `let`s that the app tail sets once, and `Request`/`Response` cache the class lookups and take the date and WebSocketPair state from statics the runtime sets (`__sbSetCompat`, `__sbInstallWebSockets`). Until the tail has run (the shared template, unit tests) everything reads `globalThis` as before, so behaviour is unchanged. A 404 on one pinned x86 core went from about 320 µs of CPU to about 120 µs (standalone, saturated).
