---
"@sproutboat/runtime": patch
---

Fix (baronunread/sproutboat#181): 0.6.4's `__sbToBytes` rewrite fixed the large
input it targeted and badly regressed the small one. An app hashing ~150-byte
values through `crypto.subtle.digest` on every request lost **64% of its
throughput** (4,700 to 1,680 req/s), tripled its p50 (4.6ms to 13.4ms) and grew
41% in RSS (66.5 to 93.8 MB). 0.6.4 replaced a `s +=` loop with an
array-push-then-join unconditionally, and below about 512 bytes the array is
pure overhead: one boxed element per input byte, allocated and joined, where
the string append had nothing to allocate at all.

`__sbToBytes` now accumulates into a window and only creates an array once a
window fills. An input under 512 bytes touches no array and runs exactly like
the pre-0.6.4 code; a larger one caps the quadratic copy at one window and
joins the windows once, keeping the #180 fix (a 43KB body encodes in ~3ms
instead of ~52ms). Both branches flush only on a complete character, so a
surrogate pair can never be split across a window boundary. 512 is where the
two costs cross on a `porf native` build, and the curve is flat either side, so
it is a plateau rather than a tuned constant.

Measured end to end on the reporter's real workload, not just a microbench
(which under-predicted the regression by two orders of magnitude and would have
shipped the wrong fix): 4,690 req/s, p50 4.62ms, RSS 66.4 MB, matching the
pre-regression baseline on every axis.

Three other 0.6.4 changes are reverted to byte-identical 0.6.3, since they were
made for consistency rather than against a measured problem, and #181 is
evidence that array allocation at small sizes is the wrong trade in this
runtime: `__sbHex` and the outbound-fetch header builder in
`transport-embedded.js`, and `__SproutboatURLSearchParams.prototype.toString()`.
`__sbHexOrBytes` keeps its nibble fix, which drops a `slice(0, -1)` rewrite that
copied the accumulator twice per byte, but goes back to `+=`: it decodes an HMAC
signature, which is tens of bytes.

`to-bytes.test.js` gains the small-input coverage this needed: sizes either side
of the window boundary (0, 1, 150, 511, 512, 513, 1024, 1025) on both branches,
and a surrogate pair walked across the boundary.
