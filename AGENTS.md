# Repository instructions

- Bun, not Node: run scripts with `bun`, test with `bun test`, install with `bun install`. Never use `npx`; use `bunx`.
- Lint with `oxlint .`, types with `tsc --noEmit`.
- Do not use em dashes in user-facing copy, comments, documentation, or source strings. Use commas, parentheses, colons, or hyphens instead.
- Versioning: changesets, one per PR that touches a package. Independent versions per package; breaking contract changes land with both consumers updated in the same release train.
