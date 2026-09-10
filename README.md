# Sproutboat shared packages

One repo, multiple packages. These contracts are version-locked by nature:
the CLI writes them and the platform reads them, so they must change
atomically. That is why they live together instead of one repo per package.

| Package | Owns | Lives today in |
| --- | --- | --- |
| `@sproutboat/config` | `sproutboat.jsonc` parsing, validation, binding slots | adopted (was `sproutboat-cli/src/config.ts`) |
| `@sproutboat/artifact` | Artifact manifest schema, bindings report | adopted (was `sproutboat-cli/src/manifest.ts`) |
| `@sproutboat/wire` | Broker frame protocol, JSON utilities | adopted (was `sproutboat-cli/src/broker.ts`, `json.ts`) |
| `@sproutboat/assets` | Static asset manifests and key resolution | adopted (was `sproutboat-cli/src/assets.ts`) |
| `@sproutboat/runtime` | Wrapper, source validation, transports, prelude | adopted (was `sproutboat-cli/src/wrap.ts` et al) |

Later candidates: `@sproutboat/crypto` (prelude shims shared by both transports).

## Workflow

```sh
bun install          # link workspaces
bun test packages/   # contract tests, run against both backends where applicable
bun run lint         # oxlint
bun run typecheck    # tsc --noEmit
```

Releases use changesets with independent per-package versions. A breaking
contract change ships with both consumers updated; the conformance suite
(green on both backends) is the gate, not the version number.

## Status

Published on npm at 0.2.0 and consumed by both repos from the registry.
The CLI keeps re-export shims so its `sproutboat/runtime/*` export paths
hold; the platform imports the packages directly.

## Adoption

- Packages home (this repo): baronunread/sproutboat-packages#1
- CLI consumer: baronunread/sproutboat-cli#33
- All five packages adopted; both consumers import them directly. The CLI
  keeps re-export shims so its `sproutboat/runtime/*` export paths hold.
