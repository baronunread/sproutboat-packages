---
"@sproutboat/toolchain": patch
---

A sprout that returns a `fetch()` response unchanged (`return fetch(url)`, or a proxy) sends its body again. The body could reach the server as a UTF-16 string, which the raw-bytes reader rejected, so the client got an empty body with the upstream's headers.
