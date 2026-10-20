---
"@sproutboat/toolchain": minor
"@sproutboat/runtime": minor
---

`Response.body` and `Request.body` are `ReadableStream`s for every body type, as in the Fetch spec and workerd. Before, they held the value given (a string, bytes or a `Blob`). `res.body.getReader()`, `res.body.pipeThrough(...)` and `new Response(other.body)` now work on any response, including the incoming request. The value as given stays internal, so responses are still written with a fixed length unless the body really is a stream. A body whose stream has been locked can no longer be read with `text()` and the other readers, which throw a `TypeError`.
