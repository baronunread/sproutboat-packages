---
"@sproutboat/runtime": minor
"@sproutboat/toolchain": minor
---

WebSockets, from compatibility date `2026-10-30`, as in workerd:

- **`WebSocketPair` and `WebSocket`.** `accept()`, `send()` (text, `ArrayBuffer` or a typed array), `close(code, reason)`, `readyState`, `binaryType` (binary messages are `Blob`s unless it is `"arraybuffer"`, workerd's standard binary type), `addEventListener` and `on<type>`. Messages sent before the other end accepts wait for it; each message is delivered in its own turn, so a reply reaches the other end before the next message, as in workerd. A close is answered automatically; invalid close codes throw `InvalidAccessError`, reasons over 123 bytes `SyntaxError`. Checked against workerd 1.20260730 (`test/native-websockets.ts`).
- **`new Response(null, { status: 101, webSocket })`** and `response.webSocket` (`null` when there is none). Any other status with a `webSocket` throws `RangeError`, as in workerd.
- **Durable Objects: the hibernation API.** `ctx.acceptWebSocket(ws, tags)`, `getWebSockets(tag)`, `getTags(ws)`, `setWebSocketAutoResponse` / `getWebSocketAutoResponse` with `WebSocketRequestResponsePair`, `serializeAttachment` / `deserializeAttachment`, and the `webSocketMessage` / `webSocketClose` handlers, run through the object's input gate.
- **Client sockets.** The client end of a 101 response becomes a real socket on a host that carries it (sproutd, which sets the runtime's `sb_ws_hook`). A standalone or platform sprout answers such a response with `501` for now; a pair whose ends both stay in the worker (a Worker and its Durable Object) works everywhere.

Before `2026-10-30` nothing is defined and `response.webSocket` stays `undefined`.
