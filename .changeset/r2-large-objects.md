---
"@sproutboat/runtime": minor
"@sproutboat/toolchain": patch
---

R2 large objects on the embedded transport (sproutd #99 and #100). `get()` reads an object as asked: a `range` reads only its window from the object's file, and `body` is a stream of 256 KiB reads, so an object of any size can be returned with `new Response(object.body)`; `text()`, `json()`, `arrayBuffer()` and `blob()` still read the whole window. A streamed response now has flow control on a host that offers it (sproutd): the pump reads no more of its source while a window of its bytes is unacknowledged, and a response with a declared `content-length` is sent with it. A worker whose host forwards `/__sb/r2/transfer/BUCKET/TOKEN` (sproutd) serves the ticket itself, with the standalone server's statuses and headers: uploads and downloads move a window at a time between the connection and the object's file. A standalone executable answers a HEAD request with the length the app declared.
