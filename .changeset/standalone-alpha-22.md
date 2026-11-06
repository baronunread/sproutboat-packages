---
"@sproutboat/toolchain": minor
---

toolchain a21: standalone binaries on Porffor alpha 22, behind the channel (`@sproutboat/toolchain/a21`; the CLI selects it with `SPROUTBOAT_PORFFOR_CHANNEL=alpha-22`). The generated module is composed in sproutd's worker shape (`composeStandaloneA21`: preamble, the alpha 19 web classes, the dispatch shim; no Node runtime module linked, and Node's `process`, `setImmediate` and `global` stay absent as on alpha 19), served by the alpha 19 uWebSockets shim over an alpha 22 native-fetch bridge (`native-fetch-a22.c`, request headers built and response read in place), and built by `buildStandaloneA21` (host or zig musl, LTO); `compileStandaloneHostA21` does a host build for tests and tools. The a21 chain gains P9: `JSON.parse` of a large document with non-Latin-1 strings no longer exhausts the heap. Nothing changes for the alpha 19 default.
