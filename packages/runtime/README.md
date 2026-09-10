# `@sproutboat/runtime`

The sprout runtime as a unit: the binding and trigger wrapper, handler
source validation, both transports (broker and embedded), and the
native-fetch prelude. These move as one because `wrap.ts` locates the
prelude and transports by file URL beside itself.

```sh
bun add @sproutboat/runtime
```

```ts
import { preludePath, transportPath, wrapNativeFetchHandler } from "@sproutboat/runtime";
import { validateHttpSyncSource } from "@sproutboat/runtime";
```

## API

- `wrapNativeFetchHandler(...)` turns a user's `export default { fetch }`
  into a native-fetch module with bindings, triggers, and env installed.
  `Bindings`, `EMPTY_BINDINGS`, `readVarsFromEnv`, `readBindingsFromEnv`,
  and `neutraliseExports` travel with it.
- `preludePath` / `transportPath(transport)` locate the prelude and the
  `broker` / `embedded` transports on disk. The prelude is read as text
  and prepended before compilation, never imported.
- `TRANSPORT_MARKER`, `BASELINE_COMPATIBILITY_DATE`, `Transport` type.
- `validateHttpSyncSource(source)` checks a bundled handler module
  (`SourceValidation`), used by project checks on both sides.

The prelude shims the Web API surface handlers expect (URL, Response,
crypto random values, binding shims, trigger dispatch) and is identical
for both transports, which is what lets one conformance suite hold them
honest.
