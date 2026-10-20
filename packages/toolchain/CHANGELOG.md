# @sproutboat/toolchain

## 0.8.1

### Patch Changes

- 742e61c: A CLI compiled with `bun build --compile` builds again. 0.8.0 embedded the patch sources with text imports to fingerprint them, but Bun bundles a text import of `patch.ts` as the module `patch.ts` is everywhere else, so compiling failed with `No matching export ... for import "default"`. The fingerprint now hashes the sources when they are on disk, and falls back to the fingerprint they were released with (`RELEASED_FINGERPRINT`, kept current by a test). The value is unchanged, so existing caches stay valid.

## 0.8.0

### Minor Changes

- 9fdf3fa: Upgrade the verified vendored Porffor pin to Alpha 18 (`deda494`). Alpha 18 brings spec BigInt arithmetic and bitwise operators, iterator helpers, Set methods, `Array.fromAsync`, Atomics, resizable ArrayBuffers, explicit resource management, a rewritten Temporal, an on-demand Intl polyfill, and many RegExp, Promise and Object spec fixes. Three downstream workarounds are dropped because upstream now covers them: the typed-array read and write bounds checks (#238, #241), the `toJSON` step in `JSON.stringify` (Alpha 18 also adds the replacer argument), and the Web Streams adapter for dynamic array iterator lookup. The remaining patches are unchanged.
- 6e88627: Standalone sprouts stream `ReadableStream` response bodies. The status and headers go out as soon as the handler returns, and each chunk reaches the client as it is produced (chunked encoding), so Server-Sent Events, progress output and long responses work. A client that disconnects cancels the stream. Hosts without the streaming server (sproutd's workers, for now) still read the stream to the end and send it buffered.

### Patch Changes

- 6880f60: Add an opt-in bounded multi-session broker worker with private supervisor control.
  Fence queue acknowledgements to durable delivery claims and retain recoverable alarm deliveries across process crashes in broker and embedded transports.
  
  Resume native R2 downloads until completion or renewed backpressure instead of leaving large responses stalled.
  
  Retain partially written TCP replies until drain and serialize pipelined replies so large broker-backed R2 reads cannot truncate or interleave frames.
  
  Honor wildcard, weak and list-based If-None-Match conditions on broker direct downloads.
  
  Move D1 queries, batches, exec and backups off the shared broker event loop into two lazy SQL threads per broker process. Preserve database affinity, transaction rollback and session isolation, and bound queued work with per-session admission and queue deadlines. Running SQLite statements remain non-preemptible; keep shared mode opt-in.
  
  Enforce shared D1 execution budgets through a capability-protected native SQLite progress hook. Interrupted batches roll back and lanes remain usable. A broker watchdog revokes all sessions if native work cannot be interrupted; uncertain SQL outcomes are never automatically retried. Build the small SQLite extension during host/image preparation.
- 846519f: Fixes found by the new differential conformance suite against workerd:
  
  - `JSON.stringify` of a cyclic object throws `TypeError` instead of crashing the process (it recursed until the native stack overflowed), so one request can no longer take a worker down.
  - `structuredClone` follows the structured-clone algorithm: cycles, `Map`, `Set`, `Date`, `RegExp`, typed arrays, `DataView` and errors survive the copy, and functions and symbols throw `DataCloneError`. It was a JSON round-trip that lost every non-JSON type and also crashed on cycles.
  - `Event`, `CustomEvent`, `EventTarget`, `AbortSignal` (`abort`, `timeout`, `any`, `throwIfAborted`) and `AbortController` exist.
  - `Object.prototype.toString` names typed arrays (`[object Uint8Array]`, not `[object Object]`).
- 853f8c9: `console.log` colours values only when stdout is a terminal. Piped or redirected output, like sproutd's per-app logs or a standalone sprout's output collected by a service manager, no longer contains ANSI escape codes such as `\x1b[33m42\x1b[0m`.
- 262690d: Allocation-heavy handlers are up to 4.5x faster in standalone sprouts (a regex scan went from 140 to 31 ms per request). Full garbage collections under load no longer return free pages to the OS, which made the next allocations fault them back in; the idle collection returns them instead, now also for small sprouts that never reach a full collection. Memory after 3 s idle is unchanged; during traffic a sprout keeps more of its heap (baronunread/sproutboat#287).
- ddb0f9d: Response, Request and Blob follow the Fetch spec, and binary bodies reach the client intact:
  
  - A `Uint8Array` or `ArrayBuffer` response body is sent as its bytes. It was sent as text: `new Response(new Uint8Array([104, 105]))` reached the client as `104,105`, and an `ArrayBuffer` as `[object ArrayBuffer]`.
  - `Response` has `statusText`, `type`, `bodyUsed` and `Response.error()`. A status outside 200–599 throws `RangeError`, a body with 101/204/205/304 throws `TypeError`, and `arrayBuffer()`/`text()` handle byte bodies (UTF-8 both ways).
  - `Request` normalizes its URL and rejects relative or invalid ones, has `redirect` and `bodyUsed`, rejects a body on GET/HEAD, and sets the default content type for string and `URLSearchParams` bodies.
  - A body can be read once: a second `text()`/`json()`/`arrayBuffer()`/`blob()` throws `TypeError`.
  - `Blob` holds bytes, with `size`, `type`, `slice` (negative indices too), and promise-returning `text`/`arrayBuffer`/`bytes`. `File` exists. `FormData` stores a `Blob` value as a `File` named by its filename, and `new Response(formData)` sends multipart/form-data.
- 50bea68: `Map.groupBy` works (it threw a TypeError), and private class fields (`#x`) no longer show up in `Object.keys`, `Object.entries`, `for...in` or `JSON.stringify`. Porffor stores a private field as an ordinary property named `__#x`; it is now installed non-enumerable, like a method, so `Object.getOwnPropertyNames` still lists the internal name (baronunread/sproutboat#286).
- 6d6ae43: `Headers` is iterable (`new Map(headers)`, `[...headers]`, `Object.fromEntries(headers)`), and `new Headers([["name", "value"]])` reads the pairs instead of producing headers named "0", "1"...
- 2a4d70d: Builds are about 1.3 s faster, and parallel builds no longer fail with `PrecompiledBuiltins.BuiltinFuncs is not a function`. Every compile re-ran the patch chain on the shared compiler cache, and its builtin precompile rewrote `builtins_precompiled.js` in place, so a concurrent build could import a half-written table. A cache entry patched by the same toolchain version is now used as is.
- 4c25aa2: The Porffor cache entry is keyed by a fingerprint of the patch chain as well as the toolchain release. A patch edit that ships under the same version now gets a freshly patched compiler, instead of reusing an entry an older chain marked complete. Builds against such an entry failed to link once the runtime began calling `sb_stream_*`. Old entries stay on disk and are no longer used.
- ec5d49f: A sprout that returns a `fetch()` response unchanged (`return fetch(url)`, or a proxy) sends its body again. The body could reach the server as a UTF-16 string, which the raw-bytes reader rejected, so the client got an empty body with the upstream's headers.
- 5859a82: Reclaim large native heaps after 500 ms without a completed request, and release oversized GC mark-queue scratch storage. Preserve the existing request collector and live application state. Extra collection is limited to heaps over 8 MiB or mark queues over 65,536 entries.
- 56b9ba6: `String.prototype.repeat` copies in doubling chunks instead of once per repetition: repeating a 600 KB string went from about 2.4 ms to under 0.1 ms.
- 4c78d83: Match the Fetch spec and workerd for common responses: string bodies default to `text/plain;charset=UTF-8`, `Response.json` sets `application/json`, and `Response.redirect` serializes its URL (`https://example.com` becomes `https://example.com/`) with a null body.
- 088cad0: Shared-object (split) builds no longer crash on start or lose the Web Streams classes.
  
  - **Toolchain:** split output prefixes module globals with `pg_`. A global named like a libc symbol (the prelude's `clone`, or an app's `hash` or `search`) bound to libc instead, so the runtime wrote into libc's code and every worker crashed. Internal `__` globals keep their names. Standalone builds are unchanged, because their globals are `static`.
  - **Runtime:** the Web Streams polyfill installs each class with its own `globalThis.X =` assignment. Where the prelude is a separate unit, Porffor resolved `new ReadableStream()` in app code at compile time and, seeing only a dynamic install, compiled it to a ReferenceError. `gen-streams.ts` now fails if an export of the polyfill is not installed.
- 28b0c39: `URL` behaves like the WHATWG URL: `new URL(path, base)`, setters for every part (`url.hostname = ...`, `port`, `protocol`, `host`, `search`, `hash`, `href`), default ports dropped, dot segments resolved, percent-encoding, `URL.canParse`, and `searchParams` changes written back into the URL. `JSON.stringify` calls `toJSON`, so a `Date` serializes as its ISO string (it was `{}`) and a `URL` as its href.
- eec94f1: Web API fixes found by the conformance suite against workerd:
  
  - `Headers` follows the Fetch spec: `get` joins repeated values with `", "`, iteration is sorted by name with values combined (each `Set-Cookie` listed separately), `getSetCookie()` exists, values are trimmed, and invalid names or values throw `TypeError`. Each appended header still reaches the wire as its own line.
  - `TextDecoder` is the WHATWG UTF-8 decoder. Characters outside the BMP (emoji) decode correctly, invalid bytes become U+FFFD (or throw with `fatal`), the BOM is stripped unless `ignoreBOM`, and `{ stream: true }` keeps an incomplete sequence for the next chunk.
  - `toLowerCase`/`toUpperCase` map non-ASCII letters (Latin, Greek, Cyrillic and the rest of the BMP's simple mappings). They mapped ASCII only.
  - `new URLSearchParams(init)` accepts a record, a sequence of pairs or another `URLSearchParams`. Only strings worked; `{ a: "1" }` gave `%5Bobject+Object%5D=`.
  - `atob` ignores ASCII whitespace and throws `InvalidCharacterError` on invalid input, and `btoa` throws on characters above U+00FF.
  - `queueMicrotask` exists.
  - URL hosts are converted to ASCII (Punycode): `new URL("http://münchen.test").host` is `xn--mnchen-3ya.test`.
  - `crypto.subtle.digest` supports SHA-1 and MD5, and HMAC works with SHA-1. `exportKey("raw")`, `generateKey` for HMAC and workerd's `crypto.subtle.timingSafeEqual` exist, and imported keys report `algorithm.length`. Errors carry WebCrypto's names (`NotSupportedError`, `InvalidAccessError`), and `getRandomValues` over 65,536 bytes throws `QuotaExceededError`.
  - `setTimeout(fn, 0)` and `setInterval(fn, 0)` fire on Linux. uSockets arms timers with `timerfd_settime`, and a zero expiry disarms the timer, so a zero-delay timer never ran (macOS fired it). Timers are armed at 1 ms at least.

## 0.7.0

### Minor Changes

- 14546a0: Upgrade the verified vendored Porffor pin to Alpha 17, including correct Math.round ties and signed zero, native number parsing and formatting, full console number precision, and class-field capture fixes. Keep downstream compatibility patches until equivalent upstream changes ship.

### Patch Changes

- 14546a0: Register direct-only local function expressions in their lexical scope so type inference does not borrow an unrelated same-named function's return type. Fixes Better Auth's model-name resolver incorrectly treating an existing user schema as missing.

  Correct Uint8Array base64 option string tags and complete-chunk truncation, unblocking base64url signatures and fixing padding and decoding.

## 0.6.0

### Minor Changes

- Pin and vendor Porffor alpha-16 (43087d4). Enable Proxy and revocable Proxy in handler validation, add native regression coverage for traps and iterators, and drop three typed-array patches now implemented upstream. See PORFFOR_ALPHA16.md for the complete change audit and remaining package compatibility limits.

## 0.5.0

### Minor Changes

- 16f9b79: Pin and vendor Porffor alpha-15 (`72d048d`). Alpha-14 and alpha-15 bring stackless coroutines, iterator support, class hoisting and typed-array fixes. Three Sproutboat patches are dropped because upstream now covers them: the typed-array store and `~` conversions (#238) and the coroutine stack size (#178). The #241 write-bounds guard is re-anchored. uWebSockets stays on the same commit and the compatibility suite is unchanged at 30/32. See `PORFFOR_ALPHA15.md`.

### Patch Changes

- bf4ac00: Named class expressions work inside handlers again (baronunread/sproutboat#256). Inside a function, Porffor gave a class expression's own name, as seen from its methods, a new function object instead of the class, so `var R = class l { static lex() { return new l() } }` failed with "value is not a constructor". Every handler has run inside a function since #238, and bundlers emit this shape for any class whose static members refer to themselves, so marked and similar packages broke. A parse-time rewrite turns such a class into the equivalent `(() => { const l = class { ... }; return l; })()`, which Porffor handles correctly.
  
  The ISO date parser no longer reads one byte past the end of the string. When that byte happened to be `+` or `-`, a timezone offset's sign flipped, so `-00:30` could parse as `+00:30` depending on what sat next in memory.

## 0.4.24

### Patch Changes

- 9225026: `join()` and `toString()` work on typed arrays (baronunread/sproutboat#242). Porffor generates typed-array methods from the Array ones by replacing `any[]` with the array's type, which also retyped `join`'s internal helper array. `new Uint8Array([1,2]).join("-")` returned garbage, and a three-element `Uint16Array.join` crashed. The generator now keeps that helper a plain array.

## 0.4.23

### Patch Changes

- a479611: Typed-array writes outside the array are ignored, as the spec requires, instead of overwriting the next allocation in memory (baronunread/sproutboat#241). `a[length] = x`, `a[-1] = x` (which wrote `a[0]`) and `a[1.5] = x` no longer touch any memory. The check uses the same index validation as reads and applies to user code; Porffor's own builtins write within bounds.

## 0.4.22

### Patch Changes

- 184fa15: Two more spec fixes for uuid (baronunread/sproutboat#238):
  - **Unary `~`** now applies ToInt32 (wrapping modulo 2^32) instead of a saturating conversion. `~x` for `x >= 2^31`, the `~~x` truncation idiom and `~Infinity` were all wrong, which broke uuid's SHA-1.
  - **Typed-array reads** with an index outside the array, or a negative or fractional index, return `undefined` instead of reading neighbouring memory. uuid's v5 UUIDs used to change from run to run because its SHA-1 reads past its buffer. The check applies to user code; Porffor's own precompiled builtins keep their reads.
- d03abed: `TypedArray.prototype.set(source)` without an offset copies to index 0 (part of baronunread/sproutboat#238). Porffor computed the offset as `Math.trunc(undefined)`, which is NaN, so a same-type copy wrote nothing where it should and went to the wrong place in memory instead. This dropped HMAC keys in @noble/hashes and killed the process after the first request. The offset now goes through `ToIntegerOrInfinity` as the spec says. @noble/hashes' SHA-256 and HMAC match Node and keep serving.

## 0.4.21

### Patch Changes

- 1b80c4b: Integer typed-array stores wrap modulo 2^n as the spec requires, instead of saturating (part of baronunread/sproutboat#238). Porffor converted the stored value with a saturating float-to-int conversion, so `uint32[i] = x | 0` stored 0 for any negative `x`, `int32[i] = 4e9` stored 2147483647, and `fill`/`set`/`from` had the same bug. This broke pure-JS hashing such as @noble/hashes' SHA-256, which now matches Node.

## 0.4.20

### Patch Changes

- 0cdd803: `String.prototype.replaceAll` is linear instead of quadratic (baronunread/sproutboat#237). Porffor grew the result with one full-copy `strcat` per match; a patch to `compiler/builtins/string.ts` collects the pieces and joins them once. Replacing in a 2.1 MB string went from about 42 s to 71 ms (Node: 36 ms), with identical output.

## 0.4.19

### Patch Changes

- 872198d: Standalone binaries accept HTTP/1.0 requests instead of answering 505 (baronunread/sproutboat#236), so they work behind nginx's default `proxy_http_version 1.0`. uWebSockets only parsed `HTTP/1.1` request lines. A helper now edits its `HttpParser.h` before each native-fetch compile to accept `HTTP/1.0` and mark the request as ancient, which makes uWebSockets close the connection after the response, as HTTP/1.0 expects.

## 0.4.18

### Patch Changes

- e0d0e17: Compile every unit with `-ffp-contract=off` (baronunread/sproutboat#235). On arm64, clang fused `a * b + c` into a single FMA that rounds once, where JavaScript rounds after the multiply and again after the add, so native sprouts could compute different doubles from V8 for the same code. A seeded LCG diverged at step 23.

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
