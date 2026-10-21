# Repository instructions

- Bun, not Node: run scripts with `bun`, test with `bun test`, install with `bun install`. Never use `npx`; use `bunx`.
- Lint with `oxlint .`, types with `tsc --noEmit`.
- Do not use em dashes in user-facing copy, comments, documentation, or source strings. Use commas, parentheses, colons, or hyphens instead.
- Versioning: changesets, one per PR that touches a package. Independent versions per package; breaking contract changes land with both consumers updated in the same release train.
- Behaviour changes that an existing app can observe must be gated on a compatibility date (`globalThis.__sbCompat >= "YYYY-MM-DD"`), and the changeset must name the date. See `.changeset/README.md`; `__sbUpstream()` in `packages/runtime/src/native-fetch-prelude.js` is the worked example.
- Native tests: `bun run test:native` runs every `test:native-*` script, 4 at a time (`NATIVE_TEST_CONCURRENCY`), and prints the full output of any that fail. `bun run test:native crypto url` runs just those. New native tests must bind ports with port 0 (the `freePort()` helper), never a fixed number, because they run side by side.
- CI's `downstream` job builds `baronunread/sproutboat-cli`'s kitchen-sink (compatibility date `2026-08-26`) against your PR. To reproduce it locally: in a CLI checkout, `bun install`, replace each `node_modules/@sproutboat/<name>` with a symlink to this repo's `packages/<name>`, then `bun run kitchen-sink` and `bun run kitchen-sink:standalone`.
- `bun install` sets up lefthook: pre-commit formats staged files with oxfmt and lints the whole tree.

## Lint rules that commonly fire

`oxlint.config.ts` loads the local `anti-slop` plugin (`tools/oxlint/anti-slop/rules/`). Every rule is an error. The ones writers hit most, and what to write instead:

- `anti-slop/no-runtime-typeof`: bans the `typeof` operator in values, everywhere, including inside type guards. (`typeof x` in a type position, such as `type T = typeof x`, is fine.)
  - In the runtime prelude (`native-fetch-prelude.js` and the transports), use its helpers: `__sbIsStr(v)`, `__sbIsFn(v)`, `__sbIsObj(v)`.
  - In TypeScript, decode external input at the boundary instead of probing it: `parseJsonValue()` plus `isString()`, `isBoolean()`, `isSafeInteger()` and `jsonObject()` from `packages/wire/src/json.ts`; `instanceof`, `Array.isArray()` and `Number.isFinite()` for the rest.
  - Spec-mandated type branching in a Web API polyfill may disable it for that block with a reason, as the Event/AbortSignal block in the prelude does: `/* oxlint-disable anti-slop/no-runtime-typeof -- <why> */`.
- `anti-slop/require-safety-comment-for-type-assertion`: every `as T` or `<T>x` except `as const` needs a comment containing `SAFETY:` before the assertion or before the statement that contains it, stating the invariant TypeScript can't see:
  ```ts
  // SAFETY: the cache manifest is private data written below; every field is checked before use.
  const manifest = JSON.parse(text) as { commit?: string };
  ```
  On an `export const`, a comment above `export` does not count (the search stops at the `const` declaration): put it after the `=`, on the line above the value. Prefer no assertion at all: assigning `JSON.parse(...)` to a typed variable needs none, and a decoder beats a cast.
- `anti-slop/no-shape-in-symbol-names`: no identifier may contain "shape" in any case, including properties, parameters and imports (`reshaped`, `ShapeOf`, `obj.shape` all fire). Name the thing by its role: `manifest`, `entry`, `payload`, `layout`.
- `anti-slop/no-unsafe-dictionary-type`: a dictionary (`Record<K, V>`, an index signature, a mapped type) whose value type is `unknown`, `any`, `object`, `{}`, or a union containing one of them. Give it a concrete value type, e.g. `Record<string, string>`, or `JsonObject` from `packages/wire/src/json.ts` for parsed JSON.
- `no-unused-expressions` and `no-unused-vars` (oxlint core) on `Porffor.c` blocks: oxlint sees a `Porffor.c` block as an unused tagged-template expression, and a parameter or variable that only the C code reads as unused. Disable them for the next line with the reason, as the prelude does:
  ```js
  // oxlint-disable-next-line no-unused-vars -- `nStr` is read inside the RawC block below, not by JS.
  function __sbRandomBytes(nStr) {
    let out = "";
    // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
    Porffor.c`
      ...
    `;
    return out;
  }
  ```
  A `Porffor.c` block is a JavaScript template literal: never put a backtick or `${` inside the C code (comments included). A backtick ends the block and `${` starts a JS interpolation, so the C the compiler receives is not what you wrote.

The other enabled rules (`no-object-parameters`, `no-unknown-parameters`, `no-unknown-returns`, `no-chained-type-assertions`, `no-widen-then-assert`, ...) are listed in `oxlint.config.ts`; each rule file starts with what it forbids.
