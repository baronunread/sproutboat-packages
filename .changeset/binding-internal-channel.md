---
"@sproutboat/runtime": minor
"@sproutboat/wire": minor
---

Service-binding calls behave as in workerd in two more ways, on a platform edge that vouches for them:

- **The callee sees the caller's URL.** `request.url` is the URL the caller passed (`https://peer/path`), where it used to be the callee deployment's own hostname.
- **A callee that throws makes the caller throw.** The caller's `fetch()` rejects with the callee's error, keeping its class for standard errors and its message, where it used to get a plain 500 response.

How the platform vouches for a call:

1. The broker sends each service call with the edge's secret (`SB_EDGE_SECRET`, which the edge gives only to brokers) and the caller's URL.
2. The edge forwards the call to the callee with that sprout's own token (`SB_EDGE_TOKEN`).
3. The callee trusts a call only when the token matches.

A client can forge none of this. The edge removes its headers from every other request, and the error marker never reaches a client.

A vouched call also no longer shows the broker's loopback address as `x-sb-remote-addr`. The edge's internal headers are removed before any handler sees a request.

In `@sproutboat/wire`, the broker reads `SB_EDGE_SECRET` and takes an `edgeSecret` option.
