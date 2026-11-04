---
"@sproutboat/runtime": patch
"@sproutboat/wire": patch
---

Outbound TCP sockets now set `TCP_NODELAY`. Without it, Nagle's algorithm and the peer's delayed ACK stalled every fresh HTTPS `fetch()` by about 44 ms on Linux (each small TLS handshake flight waited for an ACK). This covers `fetch()`, outbound WebSockets and `connect()` from `cloudflare:sockets` on the embedded transport (standalone binaries, including sockets handed over by `SB_EGRESS_FD`), and the egress tunnel's connections to origins in `wire`. No compatibility date: only latency changes, no result, header or error does.
