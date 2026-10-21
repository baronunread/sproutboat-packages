# Porffor Alpha 19 evaluation

Verified on 2026-10-21. Released 2026-10-21:
https://github.com/CanadaHonk/porffor/releases/tag/alpha-19

Pinned commit: `0c135ce2f36fdd3467d5a58daa92283810705a51`.
Vendored archive SHA256:
`b54da2297ad9e03c5bbac0e0d156f1179ac3a09a2a6fd702475cef605bab97b9`.
`compiler/uwebsockets.js` is unchanged, so uWebSockets stays on `360c276d` and the
vendored uWebSockets archive is unchanged.

## Changes since Alpha 18

91 commits. The ones that matter to handlers:

- `Map.groupBy`; private names are brands, so `#x` stays out of `Object.keys`,
  `for-in`, `Object.entries` and `JSON.stringify` (baronunread/sproutboat#286).
- JSON: `stringify` throws on cycles and unwraps boxed primitives; `parse` applies a
  reviver with source text (`context.source`) and rejects trailing input;
  `JSON.rawJSON`.
- Spec ISO date string parsing, `Date.prototype[Symbol.toPrimitive]`, Date setters.
- Spec base64 and hex on `Uint8Array`; `%TypedArray%.prototype[Symbol.toStringTag]`.
- `Error.prototype.stack` accessor (`Name: message`, settable). The runtime prelude's
  own getter only installs when `stack` is missing, so it now stands down.
- Language: spec `instanceof` and `Symbol.hasInstance`, `+` and template literals use
  ToPrimitive / ToString, sloppy functions box a primitive `this`, unresolvable names
  are global object properties, lexical bindings are in the TDZ before their
  declaration, `with`, `new Function` from literal sources, eval completion values.
- Many String, Function, Object, Number and Promise spec fixes; string index reads
  are bounds checked.

## Downstream patches

Each workaround was removed from the chain and its native test run without it.

Dropped, now upstream:

- ISO date timezone offsets (`patchDateParser`): its anchor is gone; `date-native`
  passes on upstream's parser.
- Base64 option tags and complete chunks (`patchUint8ArrayBase64`): rewritten upstream;
  `test:native-base64` passes.
- `Map.groupBy` and non-enumerable private fields (#286): `groupby-private-native`
  passes.
- `JSON.stringify` cycle check and the typed-array `toString` tag: `json-cycles-native`
  passes. The tag patch still applied, but upstream's own tag gives the same result.
- `JSON.parse` reviver: `test:native-json` passes on upstream's reviver.

Re-anchored:

- Unicode JSON (`unicode.ts`): upstream's `JSON.parse` takes `(_: any, reviver)` and
  rejects trailing input itself, so those two edits go. The bytestring slice is widened
  everywhere `text` is sliced, which now includes the reviver's source-text records;
  without it `context.source` is garbled for non-ASCII input (`unicode-native` covers it).
- #256 class self name: Alpha 19 still has the bug (unpatched, the test case throws a
  TypeError), but its new TDZ check rejected the rewrite's synthesized `return l`,
  which carried the class's start offset. The returned name is now positioned after
  the class, as it would be in source.

Retained, still needed on Alpha 19:

- Local function types: `alpha18-native` throws a TypeError without it.
- #287 GC page discard, B16 `repeat`, #237 `replaceAll`: upstream's code is unchanged.
- #168 promise resolving to `null`: the `then` probe still lacks the null guard.
- The native-fetch server patches are Sproutboat features, not Porffor bugs.
