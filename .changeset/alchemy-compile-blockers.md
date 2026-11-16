---
"@sproutboat/runtime": minor
---

An Effect or Alchemy Worker now compiles. Three blockers, found by the Alchemy v2 spike (sproutboat-platform design 026):

- **`node:` check** (no compatibility date: it was a false positive). The scanner refused any bundle that contained the text `node:` in a string, and Effect carries `globalThis.process?.getBuiltinModule?.("node:async_hooks")`. It now looks for `node:` only where it is a specifier: `from "node:fs"`, `import "node:fs"`, `import("node:fs")` and `require("node:fs")` are still refused at every date.
- **`import("cloudflare:workers")`** (the dynamic form Alchemy uses, with a `.catch` fallback) is rewritten like the static import, and now resolves to an object with `env`, `WorkerEntrypoint`, `DurableObject` and `RpcTarget`. `cloudflare:sockets` already had both forms; no other `cloudflare:*` specifier is external, so the bundler rejects the rest.
- **`import.meta`**. Any use other than `.url`, `.filename`, `.dirname` or `.main` (`import.meta.env`, a spread, `import.meta.resolve()`) made the C build fail on `ada_c.h` (Porffor loads `node:module` for them). The handler's `import.meta` is now one object with the members workerd defines, `url`, `main` and `resolve()`: `import.meta.url` is `file:///bundle/index.js` (it was the build directory's path), `import.meta.main` is `true` (it was `false`), `resolve(x)` is `new URL(x, import.meta.url).href`. `import.meta.env`, `dirname` and `filename` read `undefined`, as in workerd. This is not gated on a compatibility date: every form but the four properties failed to build, and those four held the build machine's path. The app tail changes, not the shared template, so no generation changes.
