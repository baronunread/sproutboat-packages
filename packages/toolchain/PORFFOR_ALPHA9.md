# Porffor alpha 9 upgrade audit

Pin: `de4eb588264885b3a1596f75010e371a2052033f`, tagged `alpha-9` on
2026-09-24. The vendored codeload archive has SHA-256
`1a62187a93356b36cb6ac703ce9770c8917e4fa65545fd7c33ee8a180ae5a4c9`.

## Alpha 8 changes

The [alpha 8 release](https://github.com/CanadaHonk/porffor/releases/tag/alpha-8)
contains 27 commits. Every commit falls into one of these groups:

| Area | Commits | Effect on Sproutboat |
| --- | --- | --- |
| Language and compiler correctness | `6063154a`, `8436b386`, `d3376a2d`, `8833624c`, `b92571c4`, `dfab4235`, `65a6bb3f`, `cb26d320`, `6a47f02c`, `acf6dda0`, `c54557ba`, `50855902`, `5e5db5a4`, `6ec00849`, `61d42690` | Better default parameters, spread calls, object values, closure parameters, uninitialized and `let` bindings, optional computed keys, `finally` and exception exits; the remaining edits remove redundant IR and code generation. These improve handler correctness without replacing a local patch. |
| GC and memory | `83cd4902`, `b5eb0b98`, `9e283dd2`, `f687ac7c`, `08bf855d`, `135d2761`, `ae4002b1`, `a110867b` | Smaller memory commitment and less GC work. `a110867b` supplies a C macro used by the renderer. No Sproutboat GC patch exists to remove. |
| String built-ins | `f483ba7e` | Better `substring` and `substr`; no corresponding local shim. |
| Compiler progress | `b77750b0` | Shows compile progress on a TTY; no runtime contract change. |
| Self-hosted tools and benchmarks | `370f1f75`, `7b12abd2` | Adds `stat.isFile` and a TypeScript compiler benchmark; neither is used by Sproutboat. |

## Alpha 9 and cleanup decision

The [alpha 9 release](https://github.com/CanadaHonk/porffor/releases/tag/alpha-9)
contains `de4eb588`, adding ESM imports and exports. A direct native-fetch
fixture importing a sibling module compiled and returned its imported value.
Porffor now compiles modules as separate cached C units. The local `SB_EXTRA_LINK`
and `SB_EXTRA_CFLAGS` patches had to move to the new link list and shared
compile arguments. `UWS_COMMIT` remains `360c276d609d59af56ae6932adb95154ace9f15f`.

No local patch is superseded by the alpha 8 or 9 changes. The patches provide
Sproutboat-specific native-fetch behavior: `$PORT`, log routing, bytestring
encoding, raw asset bodies, status and header handling, request size, R2
transfers, and external link and include flags. The CLI still bundles before
Porffor to validate the full dependency graph, apply its Node shims, and pass
one controlled handler export to the runtime wrapper. Native ESM makes a future
module-based wrapper possible, but removing Bun.build or export normalization
now would also change capability validation and binding behavior. Porffor's
old external esbuild requirement is gone in alpha 9, so the CLI can drop its
esbuild dependency and bundled platform executable.

A module-wrapper prototype compiled a separate handler module. Its normal
`env.GREETING` reference returned HTTP 500; using `globalThis.env.GREETING`
returned HTTP 200. The current export normalization keeps the existing
unqualified `env` contract. The direct ESM import is now part of the CI native
crypto vector, so a future pin cannot silently lose module support.

Alpha 9 caches compiled C units by the absolute entry path. In one local
`hello` handler-edit comparison, a stable path compiled in 549 ms versus
1,505 ms with changing paths. The CLI's `dev` loop now uses a stable entry
path per process while keeping candidate artifacts isolated. These are local
single-run timings, not a published performance claim.

The published `@sproutboat/toolchain@0.4.11` includes a `TypedArray.from`
array-like input patch absent from this checkout's 0.4.10 base. Clean alpha 9
still returns an empty array for `Uint8Array.from({ length: 4 }, mapFn)`. The
0.4.11 patch was carried forward, its precompiled builtin table is regenerated,
and a native crypto vector now exercises that array-like input.

Regression evidence for this pin: toolchain tests (11), CLI tests (92), both
kitchen-sink harnesses (27 broker checks, 29 standalone checks), and all 12 CLI
examples passed. The direct ESM fixture returned HTTP 200 with the imported
value. The package typecheck and lint passed.

## Release order

The registry's latest toolchain is 0.4.11 and still pins alpha 7. This checkout
has been reconciled with that release's `TypedArray.from` patch; its pending
changeset targets 0.4.12. Publish the alpha 9 toolchain first. Then update
`sproutboat-cli`, the main `sproutboat` app, and `sproutboat-site/web` to require
0.4.12 and refresh their lockfiles. The CLI can then ship without an esbuild
executable. Until 0.4.12 is published, existing npm consumers still run alpha 7.
