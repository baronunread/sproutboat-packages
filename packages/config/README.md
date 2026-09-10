# `@sproutboat/config`

Single source of truth for `sproutboat.jsonc`: parsing, validation errors,
and binding slots (kv, d1, r2, queues, DO, assets, secrets, vars, triggers,
services, outbound).

Current sources (to be consolidated here, not duplicated):

- `sproutboat-cli/src/config.ts` (validation, `validateConfig`)
- The platform's config copy (edge/control plane side)

Consumers import the parser and the types from this package. The CLI's
`surface.ts` / generated `SURFACE.md` contract list and the platform's
equivalent keep generating from here so the docs cannot drift from the code.
