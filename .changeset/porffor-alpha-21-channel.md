---
"@sproutboat/toolchain": minor
---

toolchain: a Porffor alpha 21 channel (`@sproutboat/toolchain/a21`: pin, patch chain, fingerprint) beside the alpha 19 default. Nothing changes for existing callers; sproutd's alpha 21 generation is the first user. The chain keeps the 7 alpha 19 passes that still have a failing case on stock alpha 21, adds the determinism passes P1 to P6 from the alpha 21 gates (class functions stay in their module's unit, app units last with pinned ABI regions, content-ordered data with string-tie dedupe, prelude-declared names override runtime globals, stable derived names, app-owned globals and inits last), `Response.redirect` and `Response.error`, and `select` as a reserved C name.
