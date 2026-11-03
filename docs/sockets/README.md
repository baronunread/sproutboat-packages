# connect() conformance and driver checks

Run on the Mac (arm64), Docker (OrbStack) for the servers, workerd 1.20261101.1 as the reference.

- `conformance/worker.js`: 16 tests, 99 observations of `connect()`. The same file runs in workerd (`workerd.capnp`, trusting `server.crt`) and in a standalone build at compatibility date 2026-11-17. `servers.ts` starts the echo, sink, TLS, STARTTLS and greeter servers; `cmp.ts` diffs a result against `workerd-result.json`. Run the build with `SB_EGRESS_ALLOW=127.0.0.1 SB_CA_BUNDLE=server.crt`.
- `apps/pg`, `apps/postgres`, `apps/redis`: unmodified `pg` 8.23.1 (with `pg-cloudflare`), `postgres` 3.4.9 and a small RESP client, against Postgres 16 (scram-sha-256, md5, TLS on one port each) and Redis 7. `?auth=scram|md5|ssl`, `&n=N` times N queries. `conformance/cmp-drivers.ts` compares the JSON answers of workerd and the build.
- `apps/bench`: connect latency (`/lat`), round trips (`/rtt`) and held sockets (`/hold`, for RSS per socket).
