---
"@sproutboat/wire": minor
---

An egress service for `fetch()` (baronunread/sproutboat#252). `@sproutboat/wire/egress` runs as its own process (`SB_EGRESS_TOKEN=... bun egress.ts --port 8070`), listens on loopback, requires a token on every call, and performs the vetted fetch itself. A broker given `SB_EGRESS_URL` and `SB_EGRESS_TOKEN` sends `fetch()` through it instead of connecting directly, so on a host where the broker's own unit has no network, sprouts can still reach the internet. The address checks and `SB_EGRESS_ALLOW` behave the same in both modes; refusals read the same; compressed bodies and redirects come back as a direct fetch would see them.

`fetch()` also moves on to the next resolved address when one can't be connected to, such as an IPv6 answer on a host with no IPv6 route. It only does so on failures where nothing was sent.
