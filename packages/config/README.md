# `@sproutboat/config`

Parsing, validation, and binding slots for `sproutboat.jsonc`. Single source
of truth shared by the CLI and the platform; previously duplicated in both.

```sh
bun add @sproutboat/config
```

```ts
import { parseConfig } from "@sproutboat/config";

const result = parseConfig(await Bun.file("sproutboat.jsonc").text());
if (!result.ok) {
  for (const error of result.errors) console.error(error);
}
```

## API

- `parseConfig(text)` validates a `sproutboat.jsonc` document and returns the
  parsed config or a list of errors. Unknown keys are rejected: adding one is
  a compatibility event.
- `resourceRefs(field)` normalizes a storage-binding array (`"BINDING"` or
  `{ binding, id }`) to `{ binding, id? }` rows.
- `pinBindingId(...)` assigns account-level ids to id-less bindings.
- Types: `SproutboatConfig`, `AssetsConfig`, `ResourceBinding`,
  `ResourceRef`, `ConfigValidation`.

## Versioning

Independent versions via changesets. Adding a config key is minor; removing
or repurposing one is major and ships with both consumers updated.
