---
"@sproutboat/toolchain": patch
"@sproutboat/runtime": patch
---

Web API fixes found by the conformance suite against workerd:

- `Headers` follows the Fetch spec: `get` joins repeated values with `", "`, iteration is sorted by name with values combined (each `Set-Cookie` listed separately), `getSetCookie()` exists, values are trimmed, and invalid names or values throw `TypeError`. Each appended header still reaches the wire as its own line.
- `TextDecoder` is the WHATWG UTF-8 decoder. Characters outside the BMP (emoji) decode correctly, invalid bytes become U+FFFD (or throw with `fatal`), the BOM is stripped unless `ignoreBOM`, and `{ stream: true }` keeps an incomplete sequence for the next chunk.
- `toLowerCase`/`toUpperCase` map non-ASCII letters (Latin, Greek, Cyrillic and the rest of the BMP's simple mappings). They mapped ASCII only.
- `new URLSearchParams(init)` accepts a record, a sequence of pairs or another `URLSearchParams`. Only strings worked; `{ a: "1" }` gave `%5Bobject+Object%5D=`.
- `atob` ignores ASCII whitespace and throws `InvalidCharacterError` on invalid input, and `btoa` throws on characters above U+00FF.
- `queueMicrotask` exists.
- URL hosts are converted to ASCII (Punycode): `new URL("http://münchen.test").host` is `xn--mnchen-3ya.test`.
- `crypto.subtle.digest` supports SHA-1 and MD5, and HMAC works with SHA-1. `exportKey("raw")`, `generateKey` for HMAC and workerd's `crypto.subtle.timingSafeEqual` exist, and imported keys report `algorithm.length`. Errors carry WebCrypto's names (`NotSupportedError`, `InvalidAccessError`), and `getRandomValues` over 65,536 bytes throws `QuotaExceededError`.
- `setTimeout(fn, 0)` and `setInterval(fn, 0)` fire on Linux. uSockets arms timers with `timerfd_settime`, and a zero expiry disarms the timer, so a zero-delay timer never ran (macOS fired it). Timers are armed at 1 ms at least.
