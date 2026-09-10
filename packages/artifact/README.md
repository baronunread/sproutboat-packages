# `@sproutboat/artifact`

Single source of truth for the build artifact: manifest schema
(`schemaVersion`, project, target, runtime, hashes, sizes, dates),
bindings report, and provenance stamp.

Current sources (to be consolidated here, not duplicated):

- `sproutboat-cli/src/manifest.ts`, `src/report.ts`
- The platform's manifest validation (control plane side)

The manifest schema is frozen (additive-only per `CONTRACTS.md`); moving
it here must not change a single field. Consumers validate and write
through this package.
