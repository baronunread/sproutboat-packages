---
"@sproutboat/runtime": patch
---

`fetch(request)` sends the Request's method, headers and body (it sent a plain GET), and `init` overrides them field by field as in workerd. `fetch(new URL(...))` works. An uncaught exception's 500 response has no content type again, as in workerd.
