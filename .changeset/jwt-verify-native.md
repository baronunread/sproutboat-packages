---
"@sproutboat/runtime": patch
"@sproutboat/toolchain": patch
---

Cheaper JWT verification. `atob` decodes in C for the usual input (no whitespace, valid characters, correct padding) and falls back to the existing JavaScript for everything else, so what throws and what it throws is unchanged. `TextEncoder.encode` sizes and fills the Uint8Array in two C passes instead of two `charCodeAt` loops (a lone surrogate is still U+FFFD). The ArrayBuffer returned by `crypto.subtle.sign` and `digest` is copied in with one `memcpy`, and the constant-time compare behind `verify` runs in C. A typical `authenticate()` (three base64url decodes, two `JSON.parse`, one `TextEncoder.encode`, one HMAC verify) goes from 21.5 to 7 us on an M-series host. New native test `test:native-jwt`: RFC 4231 HMAC vectors, the RFC 7515 and jwt.io tokens, wrong key, tampered header, payload and signature, short, long and missing signatures, bad base64url, typed-array windows and ArrayBuffers as verify input, and seeded random `atob`, `TextEncoder` and HMAC (SHA-256, 384, 512) inputs compared with Bun and node:crypto.
