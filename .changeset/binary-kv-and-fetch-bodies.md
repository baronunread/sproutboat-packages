---
"@sproutboat/runtime": patch
"@sproutboat/wire": patch
---

Binary data survives KV and outbound `fetch()` bodies (baronunread/sproutboat#233, and the request half of #232).
- **KV:** `put()` of an `ArrayBuffer` or any typed array stores its bytes, flagged binary, instead of `String(view)` (`"0,1,2,..."`). `get(key, type | { type })` supports `"text"`, `"json"` and `"arrayBuffer"` as in Workers: a binary value read as text decodes as UTF-8, and a text value read as `arrayBuffer` is its UTF-8 encoding. `"stream"` throws a clear error. Existing stores gain the `binary` column on first use.
- **`fetch()` and service-binding request bodies:** an `ArrayBuffer` or view is sent as its exact bytes in both transports, instead of `"0,1,2,..."`. The standalone HTTP client also stopped truncating bodies at the first NUL byte.
