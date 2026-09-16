# Release regression plan

## Goal

Prevent a runtime or toolchain release from publishing when the generated
native-fetch server and the generated transport source disagree about their C
ABI.

## Gate 1: ABI contract test

Run the cross-package ABI contract test whenever `@sproutboat/runtime` or
`@sproutboat/toolchain` changes. The test patches the native-fetch server,
extracts every required `sb_r2_transfer_*` symbol, and checks that the broker
wrapper defines it. This gate is implemented in
`packages/toolchain/src/patch.test.ts`.

## Gate 2: release-package compile smoke test

Before publishing the CLI, install the exact packed versions of runtime,
toolchain, config, artifact, assets, wire, and CLI into a temporary fixture.
Run `sproutboat build` for a broker-backed app that declares KV, R2, assets,
Durable Objects, and cron. The job must link a Linux native-fetch binary, not
only generate source.

## Gate 3: control-plane compatibility smoke test

Run the packed CLI fixture against a disposable control plane. Execute
`deploy --dry-run`, then a real deployment and one request. The fixture should
read and write KV, issue an R2 request, serve an asset, call a Durable Object,
and receive a cron trigger.

## Gate 4: publish only from verified package artifacts

Make the publish workflow depend on Gates 1 through 3. Each smoke job installs
the same tarballs that the publish workflow uploads, so workspace links and
unpublished source cannot hide a package-boundary mismatch.

## Ownership

Changes that modify either the native-fetch patch or a transport ABI must add
or update an ABI-contract assertion. Changesets for runtime, toolchain, or CLI
must pass the packed-fixture compile smoke test before release.
