---
"@sproutboat/toolchain": patch
---

toolchain a21: four Porffor alpha 22 miscompiles that postgres.js and drizzle-orm hit are fixed in the patch chain. A method call on a receiver of unknown type evaluated its arguments in C's unspecified order, so `buf.toString("utf8", index, index += length)` returned `""` (P10). A class declaration that is assigned to, such as TypeScript's `(SQL || (SQL = {}))` namespace merge, never stored the class in its binding and died with "Cannot get property of null" (P11). The right operand of `||`, `&&` and `??` retyped a local at compile time as if it always ran, so the same pattern inside a function (every bundled app body is one) still failed after P11 and `let o = 1; o || (o = {}); typeof o` answered "object" (P13). `new Date(s)` accepted only `+HH:mm` offsets and returned NaN for Postgres' `2026-11-08 14:48:19.097+00` and for `+0000`; `+HH`, `+HHmm` and `+HH:mm` now parse (P12).
