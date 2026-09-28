---
"@sproutboat/runtime": minor
---

Pass `(request, env, ctx)` to handlers built with compatibility dates from 2026-09-28. Older builds retain `(request, ctx)`. Add `Response.redirect()` for native fetch and decode request text as UTF-8 while preserving raw body bytes. The matching compiler Unicode fix shipped in `@sproutboat/toolchain@0.4.14`.
