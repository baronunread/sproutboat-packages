---
"@sproutboat/toolchain": patch
---

toolchain a21: three Porffor alpha 22 miscompiles that postgres.js and drizzle-orm hit are fixed in the patch chain. A method call on a receiver of unknown type evaluated its arguments in C's unspecified order, so `buf.toString("utf8", index, index += length)` returned `""` (P10). A class declaration that is assigned to, such as TypeScript's `(SQL || (SQL = {}))` namespace merge, never stored the class in its binding and died with "Cannot get property of null" (P11). `new Date(s)` accepted only `+HH:mm` offsets and returned NaN for Postgres' `2026-11-08 14:48:19.097+00` and for `+0000`; `+HH`, `+HHmm` and `+HH:mm` now parse (P12).
