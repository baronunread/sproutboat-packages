---
"@sproutboat/runtime": minor
"@sproutboat/toolchain": minor
"@sproutboat/wire": minor
---

Request bodies stream, from compatibility date `2026-10-27`, as in workerd:

- **Ingress.** The native server runs the handler as soon as a request's headers arrive. `request.body` hands out the bytes as they come in, and the server pauses the socket while more than 1 MiB waits unread, so a large upload read through the stream keeps memory flat (a 128 MiB upload peaks at 38 MiB RSS). `text()`, `json()`, `arrayBuffer()` and `bytes()` read the whole body and return Promises.
- **Limit.** `SB_REQUEST_BODY_MAX` defaults to 100 MiB for streamed bodies (it stays 1 MiB before the date, where the body is held in memory whole). A larger `Content-Length` gets `413 Payload Too Large` before the handler runs; a chunked body that grows past it closes the connection, and the handler's stream fails.
- **Service bindings and `fetch()`.** On the broker transport, a `ReadableStream` request body goes out as it is read, in `FRAME_V1_MORE` frames after the request's head, instead of being read to the end first. The broker feeds them to the upstream request as a stream (with backpressure) and says so in its `ping` reply (`bodyStream: true`); against an older broker, bodies are sent whole as before. A streamed body can't follow a 307 or 308 redirect.

Internal trigger and RPC calls keep buffered bodies. Before `2026-10-27` nothing changes: the handler gets the whole body at once and `request.text()` answers synchronously, which a deployed handler may rely on, hence the new date.
