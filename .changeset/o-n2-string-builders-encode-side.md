---
"@sproutboat/runtime": patch
---

Fix (baronunread/sproutboat#180): `__sbToBytes` built its result with repeated
`s +=` in a loop, the same `O(n^2)` bug class the `__sbFromUtf8` fix in 0.6.3
addressed, just on the encode side. Porffor's strings have no rope/cons
optimization, so `+=` in a loop copies the whole accumulated string on every
append. Both of its branches were affected: the UTF-8 encode loop over string
input, and the byte-for-byte copy out of an ArrayBuffer or typed array.

This one matters because `__sbToBytes` sits behind every `crypto.subtle` call a
handler makes: `digest`, `importKey`, `sign`, `verify` and the PBKDF2/scrypt
path all funnel their data, keys, salts and signatures through it. Hashing a
request body was quadratic in the body's size.

`__sbHexOrBytes` had the same shape on a third crypto path (it decodes the
`expected` side of an HMAC verify) and was worse than a plain `+=` loop: on odd
iterations it rewrote the last character with `out = out.slice(0, -1) + ...`,
copying the accumulated string a second time per byte. It now holds the high
nibble in a local until its pair arrives and pushes one character per byte.

Three further accumulators converted to the same array-and-join idiom for
consistency. These are bounded by header count, id length or parameter count
rather than by handler input, so they are hygiene rather than a fix:
`__SproutboatURLSearchParams.prototype.toString()` in the prelude, and `__sbHex`
plus the outbound-fetch header builder in `transport-embedded.js`.

Covered by a new `to-bytes.test.js`, following the `utf8-decode.test.js`
convention of lifting the pure functions out of the text-only prelude: ASCII,
2-byte, 3-byte and surrogate-pair encodes checked byte-identical against
`TextEncoder`, the existing unpaired-surrogate behaviour pinned, typed-array and
ArrayBuffer input with high bytes, hex decode in both cases with its non-hex and
odd-length fallbacks, and long inputs (46KB string, 50,000-byte array, 20,000-byte
hex) for correctness at the size the quadratic version hurt.
