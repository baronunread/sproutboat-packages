---
"@sproutboat/toolchain": patch
---

toolchain a21: a standalone binary built on the alpha 22 channel answers HTTP/1.0 requests again (nginx's default `proxy_http_version 1.0`) instead of refusing them with `505 HTTP Version Not Supported`. The alpha 19 compiler edits uWebSockets' `HttpParser.h` for this (#236) during its own compile, which the alpha 22 build never runs, so 0.24.0 got the edit only when an alpha 19 build had already touched the same uWebSockets checkout. `buildStandaloneA21` now applies the same edit itself (`patchUwsHttp10`), and the shim's text names the edit, so shim objects compiled against an unedited header are rebuilt.
