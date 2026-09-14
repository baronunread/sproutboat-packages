---
"@sproutboat/runtime": patch
---

Fix #177: `new Response(obj.body)` on an `R2Object` UTF-8-re-encoded raw
bytes, corrupting any binary content (each byte 0x80-0xFF doubled on the
wire). Added `R2Object.toResponse(init?)`, which serves the bytes
unmodified via the same `x-sb-raw-body` marker `__sbRawBodyResponse` already
uses for assets/fetch/service-binding responses. Defaults `content-type`
from `httpMetadata` and `etag` from `httpEtag` when not set in `init`.
