---
"@sproutboat/runtime": minor
"@sproutboat/toolchain": minor
"@sproutboat/wire": minor
---

`connect()` from `cloudflare:sockets`, from compatibility date 2026-11-17: plain TCP, `secureTransport: "on"` and `"starttls"` with `startTls()`, `readable`/`writable` byte streams with write backpressure, `opened`, `closed`, `close()`, half-close, workerd's error shapes, and port 25 refused. It runs on both transports: the embedded one (standalone and sproutd) opens the connection in a thread per socket and does TLS with BearSSL (extra roots through `SB_CA_BUNDLE`); the broker one tunnels through the broker, which vets every address with the `fetch()` policy (`SB_EGRESS_ALLOW`, private ranges refused), terminates TLS, and hands the tunnel to the egress service where the broker has no network. Limits: 16 sockets per app. From the same date `navigator.userAgent` is `"Cloudflare-Workers"` and a bundled `Buffer`/`process` is accepted, so unmodified `pg`, `postgres` and Redis clients run. The toolchain gains three Porffor fixes that those drivers hit: bindings named like libc macros, call arguments evaluated in order, and a writable `navigator`.
