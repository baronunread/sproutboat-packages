---
"@sproutboat/toolchain": patch
"@sproutboat/runtime": patch
---

Match the Fetch spec and workerd for common responses: string bodies default to `text/plain;charset=UTF-8`, `Response.json` sets `application/json`, and `Response.redirect` serializes its URL (`https://example.com` becomes `https://example.com/`) with a null body.
