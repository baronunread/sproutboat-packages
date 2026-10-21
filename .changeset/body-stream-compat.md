---
"@sproutboat/toolchain": patch
"@sproutboat/runtime": patch
---

`Response.body` and `Request.body` are `ReadableStream`s only from compatibility date `2026-10-21`. 0.19.0 changed this for every app, which broke handlers that read `request.body` as a string, such as `JSON.parse(request.body)` in the CLI's own D1 example. An app with an earlier `compatibility_date` keeps the raw body, as before. To opt in, move `compatibility_date` to `2026-10-21` or later and rebuild.
