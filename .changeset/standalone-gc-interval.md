---
"@sproutboat/toolchain": patch
---

A standalone binary collects garbage every 8 requests, and once it has been quiet for about 50 ms, instead of after every response. A collection costs about the same whatever the request made, so a cheap request paid all of it: on the API-challenge mix at 900 req/s the CPU per request goes from about 550 to about 470 us, and the feed endpoint from 940 to 750 us, for about 2 MiB more resident memory. `SB_GC_EVERY=<n>` sets the interval (`1` restores a collection after each request). A request that needs more heap than is free still collects when it allocates. Only the standalone server's shim changes: sproutd's collector, and its density, are untouched. New native test `test:native-http` covers keep-alive, pipelining, split requests, large bodies, partial writes and many connections at both intervals.
