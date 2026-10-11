---
"@sproutboat/runtime": minor
---

Add Web Streams globals from web-streams-polyfill 4.3.0, including readable, writable and transform streams, with native regression coverage. Streams run in memory; HTTP request and response bodies remain buffered by the native transport. Together with the compiler fixes, Better Auth 1.7.1 passes email/password and signed-cookie session flows with an explicit memory database adapter. Database-free encrypted sessions still require unsupported AES crypto.

Expose the existing native timeout and interval functions on globalThis, supporting host-task yields in noble hashes 2.4 without changing timer semantics.
