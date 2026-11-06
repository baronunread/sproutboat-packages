---
"@sproutboat/toolchain": minor
---

toolchain: standalone binaries now build with Porffor alpha 22 by default. Binaries are about 5% smaller (hello 6.58 to 6.27 MB, linux-x64, static musl), and apps using jose, yaml, supabase-js and Neon (HTTP and `Pool` over WebSocket) work in a standalone binary on alpha 22, checked route by route against the same apps on alpha 19 and on Bun. Measured against alpha 19 on the same box: idle memory 3 to 7% lower, requests per second 5 to 15% lower, p50 latency 3 to 8% higher, p95 up to about 30% (5 to 8 µs) higher on a request-heavy app.

The compiler changes, so every app is rebuilt on its next build. **Fallback:** `SPROUTBOAT_PORFFOR_CHANNEL=alpha-19` builds with the previous alpha 19 compiler for one more release; it will then be removed. `standaloneChannel()` in `@sproutboat/toolchain/a21` resolves the channel (default `alpha-22`); the root export's pin stays alpha 19 for its other callers.

How it is built: the generated module is composed in sproutd's worker shape (`composeStandaloneA21`: preamble, the alpha 19 web classes, the dispatch shim; no Node runtime module is linked, and Node's `process`, `setImmediate` and `global` stay absent as on alpha 19), served by the alpha 19 uWebSockets shim over an alpha 22 native-fetch bridge (`native-fetch-a22.c`, request headers built and response read in place), and built by `buildStandaloneA21` (host or zig musl, LTO); `compileStandaloneHostA21` does a host build for tests and tools. The bridge sends the right `Content-Length` for a `Uint8Array` response body. The a21 chain gains P9: `JSON.parse` of a large document with non-Latin-1 strings no longer exhausts the heap.
