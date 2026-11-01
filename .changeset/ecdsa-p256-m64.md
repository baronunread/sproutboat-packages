---
"@sproutboat/runtime": patch
---

`crypto.subtle` signs and verifies P-256 (ES256 and ECDH) with BearSSL's 64-bit `ec_p256_m64` where the target has a 128-bit multiply, and keeps the portable code everywhere else (and for P-384 and P-521). BearSSL never picks m64 by itself, so the C asks for it with `br_ec_p256_m64_get()`, which returns null on a target without one. Through the runtime on macOS arm64, ES256 signs 2.2x faster (2,563 to 5,621 per second) and verifies 3.1x faster (1,318 to 4,050 per second). Results are unchanged, so there is no new compatibility date.

This needs the BearSSL that the CLI pins from the release that ships with it: m64 is not in BearSSL 0.6, so a CLI that still links 0.6 cannot link this runtime.
