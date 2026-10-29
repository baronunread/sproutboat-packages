---
"@sproutboat/runtime": minor
"@sproutboat/toolchain": patch
---

Database clients that need only fetch or WebSocket (`@libsql/client`, `@neondatabase/serverless`, `@supabase/supabase-js`, `@upstash/redis`, `@planetscale/database`) run unmodified. In the runtime: `fetch()` returns a promise on the standalone binary from the compatibility date that already promises it (2026-10-22), so `fetch(url).then(...)` works and a refused request rejects; a fetched 204, 205 or 304 response no longer throws "Response with null body status cannot have body"; from the proposed compatibility date 2026-11-15 the Node/Bun/Deno global check in the bundle skips a use behind a `typeof` feature test, a global the bundle declares itself, and mentions inside strings and comments, and `Error.captureStackTrace` exists. In the toolchain: a typed array with an underlying object (a `Buffer` polyfill) shadows the builtin methods it redefines, so `buf.toString("utf8")` is the Buffer one.
