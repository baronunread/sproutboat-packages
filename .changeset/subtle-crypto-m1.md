---
"@sproutboat/runtime": minor
---

`crypto.subtle` gains workerd's surface from compatibility date `2026-11-06` (a placeholder; the date is the maintainers' to choose). This first milestone adds RSASSA-PKCS1-v1_5, RSA-PSS and ECDSA (P-256, P-384, P-521) sign and verify, Ed25519 and workerd's `NODE-ED25519`, PBKDF2 and HKDF for every hash, `generateKey`, `importKey` and `exportKey` in `raw`, `spki`, `pkcs8` and `jwk`, `deriveBits`, `deriveKey` for HMAC keys, and errors that are `DOMException`s with workerd's names. Earlier dates keep the digest, HMAC and PBKDF2-SHA-256 subset and its errors unchanged. The primitives are BearSSL's (already linked) and Monocypher's (vendored for Ed25519); see `packages/runtime/src/subtle/README.md`. Only the embedded transport (standalone binaries and sproutd) has the native half; the broker transport answers `NotSupportedError`. Based on the `DOMException` change.
