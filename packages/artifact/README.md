# `@sproutboat/artifact`

Build artifact manifest schema and validation. Single source of truth shared
by the CLI (which writes it) and the platform (which validates it).

```sh
bun add @sproutboat/artifact
```

```ts
import { validateManifest } from "@sproutboat/artifact";

const result = validateManifest(JSON.parse(await Bun.file("manifest.json").text()));
if (!result.ok) {
  for (const error of result.errors) console.error(error);
}
```

## API

- `validateManifest(value)` checks a parsed manifest and returns the typed
  manifest or a list of errors.
- Constants: `ARTIFACT_SCHEMA_VERSION` (frozen at 2), `RUNTIME`
  (`native-fetch`), `CAPABILITY_PROFILE` (`http-sync-v0`), `DEPLOY_TARGET`
  (`linux-x86_64`), plus `hostTarget()` for local builds.
- Types: `ArtifactManifest`, `HostTarget`, `ManifestValidation`.

## Versioning

The schema is frozen: additive only, never removed or repurposed, because a
stored artifact must validate against every later release and `rollback` can
reactivate one built arbitrarily long ago. Schema changes are major and ship
with both consumers updated.
