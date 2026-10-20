---
"@sproutboat/toolchain": patch
"@sproutboat/runtime": patch
---

`env.BUCKET.put(key, request.body)`, `env.KV.put(key, request.body)` and `fetch(url, { body: request.body })` store and send the request body again. Since 0.19.0, `body` is a `ReadableStream`, and these took its string form. Incoming request bodies are also read as the bytes they are, so `arrayBuffer()`, `blob()`, `body` and KV `put` no longer UTF-8 encode a non-ASCII upload twice. R2 `put` accepts bytes as well.
