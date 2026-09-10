# Sproutboat shared packages

One repo, multiple packages. These contracts are version-locked by nature:
the CLI writes them and the platform reads them, so they must change
atomically. That is why they live together instead of one repo per package.

| Package | Owns | Lives today in |
| --- | --- | --- |
| `@sproutboat/config` | `sproutboat.jsonc` parsing, validation, binding slots | `sproutboat-cli/src/config.ts` (+ the platform's copy) |
| `@sproutboat/artifact` | Artifact manifest schema, bindings report | `sproutboat-cli/src/manifest.ts`, `src/report.ts` (+ the platform's copy) |

Later candidates: `@sproutboat/wire` (broker frame ops), `@sproutboat/crypto`
(prelude shims shared by both transports).

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

Scaffold. Package surfaces are reserved; the extraction from the CLI and
the platform is tracked in their repos (see Adoption below). Nothing
imports these packages yet.

## Adoption

- Platform: baronunread/sproutboat#NNN
- CLI: baronunread/sproutboat-cli#NNN
