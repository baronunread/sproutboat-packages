---
"@sproutboat/runtime": patch
---

fetch() and connect() now also refuse reserved space that carries no public service: AS112 and the old IPv4 anycast blocks (`192.31.196.0/24`, `192.52.193.0/24`, `192.88.99.0/24`, `192.175.48.0/24`), SIIT (`::ffff:0:0:0/96`), IETF protocol assignments including Teredo (`2001::/23`), `3fff::/20` and SRv6 (`5f00::/16`). Applies to the broker, the egress service and the standalone client alike; `SB_EGRESS_ALLOW` still overrides.
