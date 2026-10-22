---
"@sproutboat/runtime": patch
---

Bodies of megabytes no longer take hundreds of megabytes of memory (sproutd #22). Converting bytes to text and text to bytes made one string per character, so reading a 5 MiB R2 object with `text()` peaked at about 400 MiB, and R2 multipart uploads with real (5 MiB) parts ran sproutd's workers out of memory. The conversions now run in one C pass and give exactly the same results. On a standalone build, at 5 MiB:

| | before | after |
|---|---|---|
| `put()` of a string | 82 MiB | 16 MiB |
| `put()` then `get()` and `text()` | 400 MiB | 26 MiB |
| multipart upload, then `get()` and `text()` | 396 MiB | 21 MiB |
| `request.text()` of the request body | 402 MiB | 24 MiB |

Also:

- At every date, `uploadPart()` stores an `ArrayBuffer` or a typed array as its bytes. It stored the text `[object ArrayBuffer]`.
- From `2026-10-26`, `uploadPart()` takes what `put()` takes (a `ReadableStream` or a `Blob` too), and stores text as its UTF-8 bytes, as in workerd. It stored text whose characters all fit in one byte as Latin-1.
- From `2026-10-26`, an R2 object body's `body` stream is made when first read, and a whole-object `get()` keeps one copy of the bytes, not two.
