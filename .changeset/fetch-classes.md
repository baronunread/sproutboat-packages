---
"@sproutboat/toolchain": patch
"@sproutboat/runtime": patch
---

Response, Request and Blob follow the Fetch spec, and binary bodies reach the client intact:

- A `Uint8Array` or `ArrayBuffer` response body is sent as its bytes. It was sent as text: `new Response(new Uint8Array([104, 105]))` reached the client as `104,105`, and an `ArrayBuffer` as `[object ArrayBuffer]`.
- `Response` has `statusText`, `type`, `bodyUsed` and `Response.error()`. A status outside 200–599 throws `RangeError`, a body with 101/204/205/304 throws `TypeError`, and `arrayBuffer()`/`text()` handle byte bodies (UTF-8 both ways).
- `Request` normalizes its URL and rejects relative or invalid ones, has `redirect` and `bodyUsed`, rejects a body on GET/HEAD, and sets the default content type for string and `URLSearchParams` bodies.
- A body can be read once: a second `text()`/`json()`/`arrayBuffer()`/`blob()` throws `TypeError`.
- `Blob` holds bytes, with `size`, `type`, `slice` (negative indices too), and promise-returning `text`/`arrayBuffer`/`bytes`. `File` exists. `FormData` stores a `Blob` value as a `File` named by its filename, and `new Response(formData)` sends multipart/form-data.
