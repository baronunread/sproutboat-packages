# `@sproutboat/wire`

Single source of truth for the broker frame protocol: op dispatch, storage
tables, queue and alarm delivery, plus the JSON validation utilities the
protocol is built on.

Current sources, moved verbatim: `sproutboat-cli/src/broker.ts`,
`broker.test.ts`, `json.ts`. Contract tests move with the code; the CLI's
`CONTRACTS.md` broker-wire and storage sections keep generating from here.

Note: `broker.ts` imports `@sproutboat/assets`, deliberately declared
nowhere here. Bun resolves transitive `file:` links from the consumer root,
not the declaring package, so every consumer links all `@sproutboat/*`
packages it needs at its own root. Add a real version range here at first
npm publish.
