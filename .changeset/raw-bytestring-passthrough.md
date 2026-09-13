---
"@sproutboat/toolchain": patch
"@sproutboat/runtime": patch
---

Fix (baronunread/sproutboat#176): #172's bytestring UTF-8 encoding fix broke
the assets binding, which reads a file's bytes off disk into a `bytestring`
specifically so they pass through the wire untouched — a `bytestring`
carrying real text a handler built and one carrying opaque file bytes are the
same type with no way to tell them apart, so #172's blanket encoding also
re-encoded already-finished bytes, corrupting any binary asset (and any
proxied `fetch()`/service-binding response body).

Adds a second, dedicated `porf_native_fetch_read_raw_bytes` (zero-copy,
bytestring-only, no encoding, ever) alongside the untouched original —
`porf_native_fetch_read_value` is called from ~30 places across sproutboat's
own inline C, all genuine text, so its signature and behavior stay exactly as
#172 left them. `write_response_value` picks between the two based on a new
reserved `x-sb-raw-body` response header (same pattern as #163's
`x-sb-remote-addr`), which the assets binding, outbound `fetch()`, and
service-binding `fetch()` now set — the three places sproutboat's own
prelude constructs a Response from wire bytes rather than a string a handler
built. Verified end-to-end: a 256-byte all-values fixture now round-trips
byte-for-byte through a real standalone build's assets binding, and #172's
original UTF-8 fix still holds for genuine text.

Not fixed here: `env.<R2>.get()`'s `.body` is exposed directly to handler
code, which then constructs its own `new Response(obj.body)` — no
sproutboat-owned call site to attach the marker to, so R2 binary objects
served this way carry the same corruption. Needs either a real binary body
type upstream in Porffor or a different API shape; tracked as a known gap on
#176, not resolved by this fix.
