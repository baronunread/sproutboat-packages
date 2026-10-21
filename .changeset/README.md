# Changesets

Add one with `bun run changeset` in every PR that changes a published package. The
bot turns them into version bumps and CHANGELOG entries (see `.github/workflows/release.yml`).

## Behaviour changes need a compatibility date

An app keeps the `compatibility_date` it was written against while it picks up new
runtime releases on its next build. A change that an existing app can
observe (a different return type, a value that used to be synchronous becoming a
promise, a header, status or error that changes) must only apply from a new date:

```js
if (globalThis.__sbCompat >= "2026-10-22") return __sbUpstreamStreamed(op, msg, label, signal);
```

Older dates keep the old behaviour. `__sbUpstream()` in
`packages/runtime/src/native-fetch-prelude.js` is the worked example: `fetch()` and
service-binding calls return promises only from `2026-10-22`, because returning them
at every date broke `const r = fetch(url); r.body` in an app pinned to `2026-08-26`.

The changeset must name the date and describe both sides of it, like
`gate-async-calls.md` did:

> The asynchronous `fetch()` behaviour now starts at compatibility date `2026-10-22`.
> Earlier dates keep the synchronous Response.

Test both sides: `wrapNativeFetchHandler()` takes the compatibility date as its last
argument, and `packages/runtime/test/native-service-bindings.ts` compiles the same
handler at `2026-10-22` and at `2026-10-21`. CI's `downstream` job also builds the
CLI's kitchen-sink, which is pinned to `2026-08-26`, against your PR.

Bug fixes that make the runtime match Workers do not need a date, unless an app could
reasonably depend on the old behaviour. When unsure, gate it.
