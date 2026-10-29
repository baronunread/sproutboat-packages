---
"@sproutboat/runtime": minor
"@sproutboat/toolchain": minor
---

Spike, not for release: `cloudflare:sockets` `connect()` on the standalone transport, from compatibility date 2026-11-02 (plaintext, `secureTransport: "on"`, `startTls()`, half-close, write backpressure), plus what `postgres` (porsager), `pg` and `@portable/smtp` needed to run unmodified: `crypto.subtle` PBKDF2 (`deriveBits`), `Error.captureStackTrace`, a Workers `navigator.userAgent`, and, in the toolchain, four Porffor fixes (macro-named bindings, typed arrays shadowing builtin methods such as `Buffer.toString`, call argument evaluation order, writable `navigator`). From the compatibility date, `Buffer` and `process` in a bundled dependency are no longer refused. See `docs/spikes/tcp-sockets-hyperdrive/FINDINGS.md`.
