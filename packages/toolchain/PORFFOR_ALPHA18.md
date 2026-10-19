# Porffor Alpha 18 evaluation

Verified on 2026-10-19. Released 2026-10-19:
https://github.com/CanadaHonk/porffor/releases/tag/alpha-18

Pinned commit: `deda4945a526d3974ff79e499e8c1dcef0873f3a`.
Vendored archive SHA256:
`4626ffba0d5bd417ba2c5b96506d40a152dbbeeaa8a698c904054bdef6bc6e64`.
uWebSockets stays on `360c276d`, so the vendored uWebSockets archive is unchanged.

## Changes since Alpha 17

About 60 commits. The ones that matter to handlers:

- BigInt: exact arithmetic, `toString`, equality, bitwise and shift operators,
  `Number()` of BigInts. Programs without BigInts drop the BigInt dispatch.
- Iterator helpers and the builtin iterator prototypes; Set methods
  (`union`, `intersection`, ...); spec `Array.from` and `Array.fromAsync`.
- `JSON.stringify` calls `toJSON` and takes a replacer.
- Typed-array numeric keys are integer-indexed: out-of-range reads are
  `undefined` and out-of-range writes are ignored.
- Promise capabilities, species and generic combinators; `await` always
  suspends; async generator request queue.
- Spec errors, explicit resource management (`using`), FinalizationRegistry,
  Atomics, resizable ArrayBuffer and growable SharedArrayBuffer, Float16 DataView.
- RegExp: real `lastIndex`, symbol protocol, `Script_Extensions`, `\q`,
  modifiers, case folding.
- Temporal rewritten to follow the spec; an on-demand ECMA-402 (Intl) polyfill,
  compiled only for the services a program uses; named time zones.
- Builtin subclassing, spec relational and loose equality, spec `ToPrimitive`.
- Dynamic `import()` in the compiler. Handlers are still bundled first, so an
  `import()` that survives bundling has nothing to load and stays rejected.
- `TextEncoder` encodes astral characters and lone surrogates.

## Downstream patches

Each workaround was rebuilt out of the patch chain and the full native suite
(12 runtime regressions plus the toolchain native tests) run without it.

Dropped, now upstream:

- Typed-array read and write bounds (#238, #241). Its anchor is gone.
- `toJSON` in `JSON.stringify`. Alpha 18 ships a helper with our helper's name,
  so our patch already skipped itself.
- The Web Streams generator's array iterator lookup adapter. The ponyfill
  still fails inside an IIFE, so the module-scope adaptation stays.

Retained, still needed on Alpha 18:

- Local function types: unpatched Alpha 18 throws a TypeError when a local
  function shares a name with an unrelated async function. The model-resolver
  regression no longer reaches this, so `alpha18-native.test.ts` covers it.
- Class self name (#256), ISO date offsets, `replaceAll` (#237, still ~38 s on
  a 900 KB string unpatched), Uint8Array base64 options, Unicode encoder,
  Headers array init, URL class, Response defaults: their regressions fail
  without them.
- Promise resolve with `null` (#168): no regression reproduces it, but
  Alpha 18's `then` probe still lacks the null guard.
- The native-fetch server patches (#172 bytestring encoding, raw body, HTTP/1.0,
  headers, quiet collection) are Sproutboat features, not Porffor bugs.

Still open upstream, with no patch: `Map.groupBy`, private fields listed by
`Object.keys` (baronunread/sproutboat#286), per-collection GC page discard
(#287) and `Error.stack` (the runtime prelude supplies it).
