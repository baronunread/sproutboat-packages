---
"@sproutboat/runtime": patch
---

The handler bundle runs in its own function scope inside the generated module (part of baronunread/sproutboat#238). It used to be spliced into the prelude's top level, and Porffor resolves top-level names module-wide, so a bundle with its own top-level `const URL = ...` (uuid exports one) replaced the `URL` class the prelude extends and the binary died at startup with `Cannot get property of null`. Static imports from a direct-ESM handler stay at module top level.
