---
"@sproutboat/toolchain": patch
---

Fix (baronunread/sproutboat#172): a standalone/native-fetch response body,
header name, or header value whose code points all fit one byte (any Latin-1-
range string — most non-astral JS strings) reached the wire as raw Latin-1
bytes instead of UTF-8, corrupting any non-ASCII text regardless of the
declared `charset`. `patchRenderJs` now encodes Porffor's `bytestring`
representation the same way its `string` (UTF-16) branch already did. Plain
ASCII output is unaffected (identical in both encodings).
