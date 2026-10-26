---
"@sproutboat/runtime": minor
"@sproutboat/toolchain": minor
---

WebSockets on every host, and outbound WebSockets, from compatibility date `2026-11-01`:

- **Client sockets on standalone and platform sprouts.** The native server (toolchain) carries the client end of a 101 response: it upgrades the connection, passes text and binary messages both ways, applies the 1 MiB read window, caps messages at 32 MiB (1009), and answers a close with the code and reason. A message the app sent before the 101 goes out right after it, and the app's `Sec-WebSocket-Protocol` is the one the client gets. Before 2026-11-01 these sprouts still answer a 101 with 501 (sproutd, which sets `sb_ws_hook` itself, carries them from 2026-10-30). The toolchain needs `@sproutboat/runtime` 0.33 or later.
- **Outbound WebSockets.** `new WebSocket(url, protocols)` (CONNECTING, then `open`, as in a browser) and `fetch(url, { headers: { Upgrade: "websocket" } })`, whose Response carries the connected socket as `response.webSocket` (call `accept()`); a server that answers the upgrade with another status is the Response. `ws`, `wss`, `http` and `https` URLs. Returning that Response from a handler relays the client's socket to the upstream. One I/O thread per socket (up to 64) connects through the egress policy, does TLS with BearSSL, and wakes the loop through the async pipe (sproutd) or the server's waker (standalone). On the embedded transport (standalone, sproutd); the broker transport (platform, `sproutboat dev`) answers `fetch` upgrades with a rejection for now.
- `validateHttpSyncSource(source, compatibilityDate)` accepts `WebSocket(` from 2026-11-01 and keeps refusing it before.
