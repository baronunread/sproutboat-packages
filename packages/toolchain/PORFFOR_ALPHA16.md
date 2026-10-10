# Porffor alpha-16 upgrade audit

Source: [alpha-16](https://github.com/CanadaHonk/porffor/releases/tag/alpha-16), published October 10, 2026, commit `43087d42f0b90d14f04f3cddac034822560aefad`. The vendored codeload archive has SHA-256 `84398fd214183801d252a78e69a44fac1baeba7cafc7dbbcfd5c6ec3b0372032`. The [complete alpha-15 comparison](https://github.com/CanadaHonk/porffor/compare/alpha-15...alpha-16) contains 32 commits. uWebSockets stays at `360c276d609d59af56ae6932adb95154ace9f15f`.

## Supported changes

The runtime accepts `new Proxy` and `Proxy.revocable`. Native output matches Bun for get/set/has/deleteProperty, ownKeys/getOwnPropertyDescriptor through Object.keys, apply, construct, revocation, and a frozen-property invariant. This is regression coverage for these operations, not certification of all Proxy invariants or exotic targets.

Array and Map iterators and lazy matchAll now expose next/done, and Set spread works. Sproutboat's URLSearchParams and FormData shims now provide live, self-iterable keys/values/entries and default iteration. Appending after creating an iterator is observed on its next step, duplicate fields remain intact, and FormData filenames do not become iterator values.

Three local patches are removed because the shared typed-array implementation handles array-like from(), an omitted set() offset and join()/toString(). Builtin precompilation remains necessary for the date, promise, replaceAll and Unicode patches. Existing typed-array bounds and class self-name patches still apply. New native regressions cover clamped ties-to-even, class static this, null-prototype __proto__, binary evaluation order and Unicode console output.

## Package probes and opportunities

Native standalone HTTP probes on macOS arm64, pinned dependencies:

| Package | Operation | Result |
| --- | --- | --- |
| qs 6.16.0 | Nested parse and stringify, including array parameters | Passed |
| @trpc/server 11.19.0 | initTRPC, router and createCaller().hello() | Passed; HTTP adapters, clients, middleware and subscriptions untested |
| itty-router 5.0.24 Router | Parameter route, POST and fallback handler | Compiler error: labelled break crossing iterator cleanup (`target.brk`) |
| itty-router 5.0.24 IttyRouter | Parameter route, POST and fallback handler | Passed GET parameters, Unicode POST and 404 fallback after adding live Web API iterators |

Proxy-based object facades, method dispatch and server callers are now practical candidates. tRPC's basic caller path is verified, so a fetch-adapter and middleware matrix is a useful next step. Reactive stores and schema libraries must be tested on their own inputs before being listed as supported. Better Auth still needs a separate crypto and framework compatibility evaluation; Proxy alone does not establish auth support. Streams and WebSockets remain separate host API gaps.

String iteration still splits astral characters into UTF-16 halves: Array.from("🚤x") produces two surrogate entries and x rather than one emoji and x. Unicode console output itself works. Standard itty-router Router also remains blocked by a separate compiler control-flow bug. No upstream issue was filed.

## Complete change review

| Commit | Upstream change | Sproutboat impact |
| --- | --- | --- |
| [c730268](https://github.com/CanadaHonk/porffor/commit/c730268d087766a87502de0045eb08b1f966d7d2) | codegen: evaluate binary lhs before rhs statements | Fixes operand side-effect order; native regression. |
| [d24dc0a](https://github.com/CanadaHonk/porffor/commit/d24dc0ad569bfd73a2dd6e3627c0cc21619bffc2) | codegen: balance template literal concats | Balances concatenation trees; compiler improvement, no new API. |
| [4598bec](https://github.com/CanadaHonk/porffor/commit/4598becfc46865d9ea18ad338a650c98f354af51) | precompile: store builtin table as arrays | Changes builtin table representation; patched builtins still precompile. |
| [f9eb038](https://github.com/CanadaHonk/porffor/commit/f9eb038c3aa4856d861530beb2423236536beb77) | builtins: bucket auto func keys by prefix | Compiler lookup optimization; no new API. |
| [fd8f58a](https://github.com/CanadaHonk/porffor/commit/fd8f58a8374f6adf308056b40cae8d59fc31dcb0) | builtins: check builtin existence without decoding | Compiler lookup optimization; no new API. |
| [b7b8ba2](https://github.com/CanadaHonk/porffor/commit/b7b8ba2fdd4fd12340aba048c578ac2b5c3d3aef) | builtins: add constructor to all builtin prototypes | Builtin prototype constructor identity becomes available; do not infer subclass compatibility. |
| [95522a4](https://github.com/CanadaHonk/porffor/commit/95522a421ddedb5b6801d4c1f7c6706fab3cebe0) | selfhost: label bench old/new with --compare | Upstream benchmark reporting only. |
| [860485e](https://github.com/CanadaHonk/porffor/commit/860485e9821894864fb88389f7aba5750c9f09a6) | builtins/console: print strings as utf-8 | Native Unicode console strings; native regression. |
| [2213f53](https://github.com/CanadaHonk/porffor/commit/2213f531bda917ee3ec865c1dd92b9709dfd0d27) | codegen: include String.prototype methods for bytestrings | String method dispatch on bytestrings; existing handler tests cover common methods. |
| [3502f8a](https://github.com/CanadaHonk/porffor/commit/3502f8a213b7de2479ba8673a92fc4eb8013fe51) | codegen: generate reassigned hoisted function bodies later | Hoisted function reassignment codegen fix; no new host API. |
| [77ee767](https://github.com/CanadaHonk/porffor/commit/77ee767b6c8c1ea59ff82e59d7b660c942b75047) | semantic: class static blocks and fields use the class as this | Static fields and blocks see the class as this; native regression. |
| [2e28260](https://github.com/CanadaHonk/porffor/commit/2e28260bc77048324437e53406c6a7041dba12e0) | fetch: treat null response body as empty | Null Response body becomes empty; native HTTP regression. |
| [641cd59](https://github.com/CanadaHonk/porffor/commit/641cd5911142d65d7f00d70f39360139349f707c) | builtins: call builtin Symbol directly for well-known symbols | Well-known symbol identity; enables iterator protocols. |
| [e684407](https://github.com/CanadaHonk/porffor/commit/e68440705a35a2d5e1bee9c67586523f281e80f6) | builtins: add statics to builtin constructors used as values | Builtin constructors used as values retain static methods. |
| [1e3428e](https://github.com/CanadaHonk/porffor/commit/1e3428e167505f969167f70d1ed0bd3c049256af) | codegen: only type computed string reads with number keys as strings | More accurate computed-string read types; no new API. |
| [a52e55b](https://github.com/CanadaHonk/porffor/commit/a52e55b59db43170db7831905afb3450c8404d71) | builtins/console: print maps and sets from the hashtable | Console Map/Set formatting follows hashtable representation. |
| [9579dbb](https://github.com/CanadaHonk/porffor/commit/9579dbb6379617ac8d35dc5177e035b4c6aa7127) | builtins/array: spread sets and maps directly | Map/Set spread; native Set regression. |
| [fceed9a](https://github.com/CanadaHonk/porffor/commit/fceed9a7f84afc5619da34938f89475f05f7b63d) | builtins: return iterators from array, map, set and string iterator methods | Real collection iterators; native next/done and Map keys regressions. Astral string iteration remains incorrect. |
| [532d8f8](https://github.com/CanadaHonk/porffor/commit/532d8f85f3961037d2673aaf06fbf008ec57ff07) | builtins/generator: add Symbol.iterator and Symbol.asyncIterator | Generator iterator protocol; infrastructure for iterable libraries. Async generator coverage remains unestablished. |
| [872edc0](https://github.com/CanadaHonk/porffor/commit/872edc027a220f18baa82edff4166e5e38e9ded3) | builtins/regexp: make matchAll a lazy iterator | Lazy matchAll next/done; native regression. |
| [64f5299](https://github.com/CanadaHonk/porffor/commit/64f529913c3ea39a162da9516b0371665107347e) | builtins: add Proxy | Proxy implementation; lift source ban and test object/call/construct/revocation behavior. |
| [2056abb](https://github.com/CanadaHonk/porffor/commit/2056abb1b8c8fad65f50f0ad4b0ccf00f2799150) | repl: force new line | Upstream REPL formatting only. |
| [905b193](https://github.com/CanadaHonk/porffor/commit/905b193b2d5626fe796dda1290b39f176f4ba191) | builtins/hashtable: allocate the container after its arrays | Allocation ordering fix; exercise Map/Set in native regression. |
| [1f6959b](https://github.com/CanadaHonk/porffor/commit/1f6959b82c2479a4c003be03d6ac829ccf3f9c7d) | codegen: round half to even in Uint8ClampedArray stores | Uint8ClampedArray ties-to-even stores; native regression. |
| [8e76e7b](https://github.com/CanadaHonk/porffor/commit/8e76e7b8f0ea64a30974cc116bbe9c9671e7c9f4) | builtins: define builtin $get funcs as accessors | Builtin getters become accessors; typed-array prototype rewrite replaces old generation anchors. |
| [05199be](https://github.com/CanadaHonk/porffor/commit/05199be91c124f5936c2e40d5164227ddb9b0fb9) | builtins: get builtin constructors via their getters | Builtin constructors are obtained through getters; source patches reviewed. |
| [79bb578](https://github.com/CanadaHonk/porffor/commit/79bb5789b4fe9d1892ca322be6327984f2d40ca5) | builtins/typedarray: share %TypedArray% and %TypedArray%.prototype | Shared typed-array methods/prototypes; drop from, set-offset and join patches, retain behavioral regressions. |
| [0a22e14](https://github.com/CanadaHonk/porffor/commit/0a22e1494ddf793fb3bb0c4b0b3740531931f3ef) | codegen: sort builtin proto call cases by type | Codegen case ordering optimization; no new API. |
| [d5e95d0](https://github.com/CanadaHonk/porffor/commit/d5e95d0a7f91c9cc64b7766980109b8d862b4470) | codegen: only set prototype for plain __proto__ props in object literals | Only plain __proto__ literal keys change prototypes; dictionary semantics improve. |
| [1b51d58](https://github.com/CanadaHonk/porffor/commit/1b51d58b859741688b87551470d2260606ab9698) | builtins/object: treat __proto__ as a normal key on null prototype objects | Null-prototype __proto__ is an ordinary key; native regression. |
| [7a6ca5d](https://github.com/CanadaHonk/porffor/commit/7a6ca5d32f56ff7d9b1fbaaf59fafede5a496771) | parser: drop __proto__ scope slot workaround | Removes parser workaround after __proto__ fixes; class self-name patch still needed. |
| [43087d4](https://github.com/CanadaHonk/porffor/commit/43087d42f0b90d14f04f3cddac034822560aefad) | ci: update expected test262 harness passes | Upstream conformance expectation update; does not establish Sproutboat support. |

## Validation

The isolated release package suite passed 174 tests, and the CLI release suite passed 103. Both release kitchen-sink harnesses passed: 35 broker checks and 38 standalone checks. All 21 small examples passed on alpha-16. Native crypto, Unicode broker round trips and live Web API iterator checks passed. All 32 compatibility fixtures compile and 30 match Bun; the two existing non-ISO date parsing mismatches remain. The full native feature regression is in src/alpha16-native.test.ts; live Web API iterator coverage is in ../runtime/test/native-iterators.ts. The scorecard ties compatibility results to this exact source pin and patch inventory.
