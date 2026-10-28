---
"@sproutboat/runtime": patch
---

The client address is folded to plain IPv4 once per distinct address instead of on every request: a request read `x-sb-remote-addr` and, for an IPv4-mapped IPv6 peer, lowercased, split and hex-parsed it each time. The last address and its result are kept; a different address takes the same path as before.
