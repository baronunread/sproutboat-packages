---
"@sproutboat/runtime": patch
---

Fix (baronunread/sproutboat#132): the banned-API capability check matched a bare
identifier (`\bprocess\b`), so a locally-declared `function process()` — zod v4
declares exactly that — failed the check as readily as a real read of the Node
global. Now requires a member access (`process.env`, no whitespace around the
`.`, to avoid matching a sentence like "...unique to this process. The...") or
`new Buffer(...)`; `node:` now only matches as the start of a quoted string
(specifier-shaped), not as a substring anywhere. A handler that imports zod (or
anything built on it, e.g. better-auth) and only uses APIs the compiler
otherwise supports now passes the capability check and builds.

Not fixed here: zod still throws an uncaught `TypeError` at runtime on
`.safeParse()` even for the simplest schema (`z.string()`) — a separate,
deeper Porffor compatibility gap this change does not touch. This fix removes
an incorrect early rejection; it does not make zod usable end to end.
