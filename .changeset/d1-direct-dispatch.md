---
"@sproutboat/runtime": patch
---

Faster D1 in standalone builds: a D1 call no longer goes through `JSON.stringify` and `JSON.parse` on both sides of the in-process dispatch. The request object is handed straight to the dispatcher and the reply object comes straight back (the C layer still returns its own JSON, parsed once). Same results, same error messages, no change under the broker transport.

On one pinned x86 core at a fixed rate, CPU per request against a 500,000-row feed API: feed (20 rows) 1,418 to 1,133 us, post read 394 to 332 us, like 854 to 728 us, create 922 to 857 us, the realistic mix 670 to 580 us.
