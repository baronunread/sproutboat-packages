---
"@sproutboat/runtime": patch
---

Fix (baronunread/sproutboat#184): a `put()` body (R2, both transports) with bytes ≥ 0x80 was corrupted on the way *in*, before storage — `porf_native_fetch_read_value` (the one function every inline-C string read in the runtime funnels through) always UTF-8-encodes a Latin-1-range value, correct for genuine text, wrong for opaque bytes off a raw HTTP upload. A 256-byte binary upload landed as 384 stored bytes.

`__sbR2PutRaw` (embedded) and `__sbCallBin` (broker, the only caller that ever passes it a real body) now try `porf_native_fetch_read_raw_bytes` first, falling back to the normal encoding path only for a genuine multi-byte JS string (which isn't a "bytestring" and so isn't eligible for the raw read anyway). This predates the #56 storage change — the old SQLite-blob `put()` called the identical `read_value`, so it was equally corrupted; the existing R2 conformance check never caught it because it only ever exercises a plain ASCII string.

Also fixes an adjacent, independently pre-existing bug found while verifying this: `R2Object.text()`/`.json()` returned the raw stored bytes without UTF-8-decoding them, producing mojibake for any object holding real text beyond ASCII — the same gap `__sbRawBodyResponse` already closed for assets/fetch/service-binding responses. Same fix here (lazy, memoized `__sbFromUtf8` decode).

Verified end-to-end against both transports with a real binary upload (`curl --data-binary`, not a synthetic string): stored bytes and `.body`/`.text()` now round-trip byte-for-byte/correctly for binary content, Latin-1 text, and multi-byte Unicode (CJK). Full kitchen-sink conformance stays green on both transports (24/24 standalone, 27/27 broker).

**Known remaining gap, not fixed here:** a genuine astral-plane character (an emoji, anything outside the Basic Multilingual Plane, encoded as a UTF-16 surrogate pair) still encodes to the wrong number of UTF-8 bytes on write — confirmed identical before and after this fix, so it's a separate, deeper bug in Porffor's own UTF-16→UTF-8 encoder (the `porf_native_fetch_read_value` "string" branch), not something in sproutboat's own code. Filing separately if it recurs; out of scope for this fix.
