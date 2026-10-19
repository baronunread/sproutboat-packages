---
"@sproutboat/toolchain": minor
"@sproutboat/runtime": minor
---

Standalone sprouts stream `ReadableStream` response bodies. The status and headers go out as soon as the handler returns, and each chunk reaches the client as it is produced (chunked encoding), so Server-Sent Events, progress output and long responses work. A client that disconnects cancels the stream. Hosts without the streaming server (sproutd's workers, for now) still read the stream to the end and send it buffered.
