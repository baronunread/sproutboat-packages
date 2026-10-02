---
"@sproutboat/toolchain": patch
---

Standalone binaries accept HTTP/1.0 requests instead of answering 505 (baronunread/sproutboat#236), so they work behind nginx's default `proxy_http_version 1.0`. uWebSockets only parsed `HTTP/1.1` request lines. A helper now edits its `HttpParser.h` before each native-fetch compile to accept `HTTP/1.0` and mark the request as ancient, which makes uWebSockets close the connection after the response, as HTTP/1.0 expects.
