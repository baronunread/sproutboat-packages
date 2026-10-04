---
"@sproutboat/runtime": minor
"@sproutboat/wire": minor
---

`fetch()` never connects to a private or reserved address (baronunread/sproutboat#174), in the broker and in the standalone client alike. Each backend checks the address it resolved, not the hostname, so DNS rebinding can't get past the check. The broker connects to the vetted address and verifies TLS against the name. Covers loopback, RFC 1918, link-local and cloud metadata, CGNAT, benchmarking, documentation and multicast ranges, IPv6 ULA and link-local, and the IPv4 address inside IPv4-mapped, NAT64 and 6to4 addresses. An operator can let addresses through with `SB_EGRESS_ALLOW` (`*` or exact addresses) in the broker's or binary's environment. The `outbound` allowlist still applies on top.
