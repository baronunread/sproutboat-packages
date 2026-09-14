---
"@sproutboat/runtime": minor
"@sproutboat/wire": minor
---

Add Cloudflare-shaped resumable R2 multipart uploads. Parts are persisted
independently, and standalone completion assembles the final object through a
fixed 64 KiB native buffer to keep memory bounded by part size rather than total
object size.
