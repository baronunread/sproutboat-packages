---
"@sproutboat/runtime": minor
---

`request.cf` gains `httpProtocol`, `tlsVersion`, and `tlsCipher` (baronunread/sproutboat#128). Like `clientIp` (#163), these are only populated when the direct peer is listed in `SB_TRUSTED_PROXIES` and it forwarded the corresponding `x-sb-http-protocol` / `x-sb-tls-version` / `x-sb-tls-cipher` header — otherwise they stay absent rather than a guessed or faked value. `colo`, ASN, and geo fields remain out of scope (no GeoIP database on the box).
