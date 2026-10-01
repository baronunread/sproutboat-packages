# @sproutboat/toolchain

## 0.4.17

### Patch Changes

- 2cda218: Fix async handlers failing permanently with `TypeError: Cannot get property of null` after a few requests (baronunread/sproutboat#168). Porffor represents `null` as an object-typed value with pointer 0, so a promise resolving to `null` went through the `then` probe and looked `then` up at memory offset 0. Once `Date.prototype.toISOString` had written there, the probe matched, read `null.then` and rejected, and every later async function returning `null` failed the same way. A patch to `compiler/builtins/promise.ts` keeps `null` out of the probe.

## 0.4.16

### Patch Changes

- 7bab275: Pin and vendor Porffor alpha-13 (`547c781`). Alpha-11 to alpha-13 bring array, typed array and module codegen fixes, a basic `RegExp` search, a `String.prototype.normalize` stub and lowercase JSON hex escapes. Every Sproutboat patch applies unchanged, uWebSockets stays on the same commit, and the compatibility suite is unchanged at 30/32.

## 0.4.15

### Patch Changes

- c9f84ac: Raise Porffor's per-coroutine fiber stack from 256 KiB to 8 MiB. A large async handler compiled at -O0 (`sproutboat dev`) overflowed it within a few nested awaits and died with SIGBUS on its first request (baronunread/sproutboat#178). Only touched pages cost memory.

## 0.4.14

### Patch Changes

- 6c1f605: Pin and vendor Porffor alpha-10 (`08ac7ee`). Update the compiler patches for UTF-16 JSON strings, surrogate-pair UTF-8 encoding, and `TextEncoder.encodeInto` character boundaries. Verify native Unicode and date behavior against the new source.

## 0.4.13

### Patch Changes

- bb1b6a2: Parse ISO date timezone offsets correctly in native Porffor builds, including zero fields and fractional seconds.

## 0.4.12

### Patch Changes

- ed9640a: Point Porffor patch diagnostics, runtime comments, and historical notes to the
  shared upstream notes in the Sproutboat platform repository.
- b6cc9e6: Pin Porffor alpha 9, including alpha 8's compiler and GC fixes and alpha 9's ESM module support. Adapt the native-fetch link and compile-flag patches to Porffor's split C-unit build. Preserve the published 0.4.11 `TypedArray.from` workaround, which alpha 9 still needs. Re-vendor the verified alpha 9 source archive. The uWebSockets commit is unchanged.

## 0.4.11

### Patch Changes

- 6d72af7: Fix `TypedArray.from` with array-like inputs in native binaries and
  regenerate Porffor's builtin table after the source patch, including when
  the compiler is unpacked through a symlinked temporary path.

## 0.4.10

### Patch Changes

- df11cef: Bump the pinned Porffor commit to the `alpha-7` tag. All local patches
  (render.js, uwebsockets.js) verified against the real alpha-7 source via
  `ensurePorffor()` — no anchor drift, full test suite green. `UWS_COMMIT`
  unchanged, no uWebSockets re-vendor needed.

## 0.4.9

### Patch Changes

- f070d70: Revert native R2 transfer size-gating (#202). It saved ~11KB of `__text`
  (~1.3% of a typical binary) and on macOS didn't even change the shipped
  file size, since `__TEXT` is page-aligned. Not worth the `#ifdef`
  guard-placement bug class it introduced. R2 transfer support is native code
  again, always compiled in with 404 stubs where unused, same as before #202.

## 0.4.8

### Patch Changes

- Republish under a new version: npm registry stuck 0.4.7 in a conflicted staged state after an interrupted OIDC trusted-publish attempt. No code changes from 0.4.7.

## 0.4.7

### Patch Changes

- ba5a6a0: Keep the normal native-fetch request handler outside the optional direct R2 transfer compiler guard.

## 0.4.6

### Patch Changes

- a357b91: Compile direct R2 transfer support only into artifacts that declare an R2 binding.

## 0.4.5

### Patch Changes

- 5ee065c: Stream standalone direct R2 byte ranges safely and support ETag conditionals.

## 0.4.4

### Patch Changes

- d8b7877: Add native standalone R2 direct-download tickets with bounded, backpressure-aware
  file reads, including upgrades for existing patched Porffor caches.

## 0.4.3

### Patch Changes

- 0b0a666: Add a native standalone R2 direct-upload bridge that streams transfer-ticket
  request chunks to a temporary blob file, validates the digest, and atomically
  publishes the object without buffering the upload in the Porffor request body.

## 0.4.2

### Patch Changes

- fa09d90: Update the pinned Porffor compiler to alpha 6 and remove the superseded local promise-resolution workaround.

## 0.4.1

### Patch Changes

- 969add9: Fix (baronunread/sproutboat#168): a `fetch` handler that resolves a promise
  with a plain object — the common shape for a JSON response — could wedge a
  standalone/native-fetch build at 100% CPU after a handful of requests, with no
  error and no log line. Root cause: `__Porffor_promise_resolve`'s duck-typing
  probe for `.then` walks the value's prototype chain with no termination
  guard, and under certain allocator conditions the walk hits a fixed point
  instead of `null`/`undefined`, spinning forever.
  
  `patchPromiseTs` now guards the probe the same way `_internal_object.ts`'s own
  prototype-chain walks already do elsewhere in the runtime: track the previous
  prototype and stop once the "next" pointer stops advancing, reading a
  fixed-point chain as "no `.then` found" instead of spinning. Not specific to
  `Date.prototype.toISOString()` — an earlier note wrongly correlated the bug
  with that one call; see `https://github.com/baronunread/sproutboat/tree/main/patches/upstream`.

## 0.4.0

### Minor Changes

- 69bfe69: Vendor the pinned Porffor commit tarball (`packages/toolchain/vendor/`) so `ensurePorffor()` needs no network on the happy path — same pattern as sproutboat-cli's vendored uWebSockets archive. Falls back to the existing checksummed download if the file is missing, or was left stale by a pin bump that forgot to re-vendor.
  
  Part of sproutboat-cli #134 item 3.

## 0.3.2

### Patch Changes

- 806c21e: Fix (baronunread/sproutboat#176): #172's bytestring UTF-8 encoding fix broke
  the assets binding, which reads a file's bytes off disk into a `bytestring`
  specifically so they pass through the wire untouched — a `bytestring`
  carrying real text a handler built and one carrying opaque file bytes are the
  same type with no way to tell them apart, so #172's blanket encoding also
  re-encoded already-finished bytes, corrupting any binary asset (and any
  proxied `fetch()`/service-binding response body).
  
  Adds a second, dedicated `porf_native_fetch_read_raw_bytes` (zero-copy,
  bytestring-only, no encoding, ever) alongside the untouched original —
  `porf_native_fetch_read_value` is called from ~30 places across sproutboat's
  own inline C, all genuine text, so its signature and behavior stay exactly as
  #172 left them. `write_response_value` picks between the two based on a new
  reserved `x-sb-raw-body` response header (same pattern as #163's
  `x-sb-remote-addr`), which the assets binding, outbound `fetch()`, and
  service-binding `fetch()` now set — the three places sproutboat's own
  prelude constructs a Response from wire bytes rather than a string a handler
  built. Verified end-to-end: a 256-byte all-values fixture now round-trips
  byte-for-byte through a real standalone build's assets binding, and #172's
  original UTF-8 fix still holds for genuine text.
  
  Not fixed here: `env.<R2>.get()`'s `.body` is exposed directly to handler
  code, which then constructs its own `new Response(obj.body)` — no
  sproutboat-owned call site to attach the marker to, so R2 binary objects
  served this way carry the same corruption. Needs either a real binary body
  type upstream in Porffor or a different API shape; tracked as a known gap on
  #176, not resolved by this fix.

## 0.3.1

### Patch Changes

- afd054c: Fix (baronunread/sproutboat#172): a standalone/native-fetch response body,
  header name, or header value whose code points all fit one byte (any Latin-1-
  range string — most non-astral JS strings) reached the wire as raw Latin-1
  bytes instead of UTF-8, corrupting any non-ASCII text regardless of the
  declared `charset`. `patchRenderJs` now encodes Porffor's `bytestring`
  representation the same way its `string` (UTF-16) branch already did. Plain
  ASCII output is unaffected (identical in both encodings).

## 0.3.0

### Minor Changes

- New package: `@sproutboat/toolchain` — the single home for the Porffor pin
  (`pin.ts`), the source patches (`patch.ts`: `ensurePorfforPatched` plus the
  `$PORT`, request-body-limit, status-line, console-sink and remote-address
  passes), and `ensurePorffor()` (fetch, verify sha256, extract, patch, cache in
  `~/.cache/sproutboat`).
  
  `sproutboat-cli` and the `sproutboat` monorepo both depend on it instead of
  carrying their own copies, so the pin and the patch set can no longer drift —
  which they had (the monorepo was on `alpha-4` and applied 1 of the ~13 patches).
