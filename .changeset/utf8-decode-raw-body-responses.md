---
"@sproutboat/runtime": patch
---

Fix (baronunread/sproutboat#181): a handler calling `.text()`/`.json()` on a
Response built from raw wire bytes — the assets binding, outbound `fetch()`,
or a service-binding `fetch()`, the three places that set the `x-sb-raw-body`
marker for #176 — got the bytes back undecoded instead of as real text. Those
Response bodies are Porffor `bytestring`s (one raw byte per code unit), and
`Response.prototype.text()` returns that verbatim rather than UTF-8-decoding
it, so any multi-byte UTF-8 sequence came back as multiple wrong Latin-1
characters. A handler that transforms and re-emits that text (sproutboat-
site's homepage does this to inline its live counter into the fetched
`index.html`) then re-encodes the corruption as ordinary UTF-8 on the way
out — this is what turned `·` into `Â·` live on sproutboat.com.

Fixed at the sproutboat glue layer, not in Porffor: the three `x-sb-raw-body`
producers in `native-fetch-prelude.js` now build their Response through a new
`__sbRawBodyResponse()`, which overrides `.text()`/`.json()` on just that
instance with a proper UTF-8 decode (`__sbFromUtf8`, validates each
continuation byte before consuming it). This is deliberately *not* a patch to
Porffor's generic `Response`/`Request` classes — Porffor represents any
string whose characters are all <= 0xFF as this same `bytestring` shape,
whether it's opaque bytes or a handler's own Latin-1-range text (e.g.
`"café"`), and the type alone can't tell those apart. Decoding generically
would corrupt the second case; scoping the fix to the three call sites that
know for certain their body is bytes avoids that entirely (verified: a
genuine `"héllo"`/`"café"` string passes through `__sbFromUtf8` unchanged).

Verified against a real compiled native-fetch binary (`porf native`, not just
plain Bun): the override pattern works as expected, the decode round-trips
real multi-byte and 4-byte UTF-8 correctly, and genuine Latin-1 text is left
alone. Also verified end to end on sproutboat-site's own deployment.
