---
"@sproutboat/toolchain": minor
"@sproutboat/runtime": minor
---

More of the Web platform, from sproutd's W2 conformance suite against workerd:

- `CompressionStream` and `DecompressionStream` for `gzip`, `deflate` and `deflate-raw`, in JavaScript, because the native runtime links no zlib. Output decompresses with zlib, and zlib's output (stored, fixed and dynamic blocks) decompresses here. A corrupt or truncated input errors with a `TypeError`.
- A `Response` or `Request` whose body is a `ReadableStream` is read to the end by `text()`, `json()`, `arrayBuffer()` and `blob()`. Before, these returned `"[object ReadableStream]"`. Chunks must be bytes, as in workerd.
- `JSON.parse` applies its reviver: children first, `undefined` deletes the property, and `this` is the holder.
