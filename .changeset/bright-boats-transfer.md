---
"@sproutboat/runtime": minor
"@sproutboat/wire": minor
---

Add short-lived R2 direct-transfer tickets for broker-backed sprouts. A
loopback HTTP listener streams PUT bodies to file-backed R2 storage, and serves
GET and HEAD requests with single-range support without placing object bytes
in a binding frame.

Tickets are random bearer capabilities with a byte limit, expiry, one-use
claim, and optional SHA-256 verification. Native standalone direct transfers
remain unavailable until the native HTTP ingress can stream request bodies.

For broker deployments, ticket issuance now reserves account-level capacity
across every R2 resource. Reservations survive redeploys, expired and orphaned
temporary uploads are reclaimed, and the broker retains a configurable free
disk floor with capacity and rejected-transfer counters for the dashboard.
