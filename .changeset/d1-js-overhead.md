---
"@sproutboat/runtime": patch
---

Less JavaScript around each D1 statement. `raw()` and `first()` no longer read the clock or build the `meta` object they throw away; the transaction-keyword check skips its `trim()` and regex unless the statement starts like BEGIN, COMMIT, END, ROLLBACK, SAVEPOINT or RELEASE (or has no leading letter); bind parameters that are null, booleans, numbers or strings skip the ArrayBuffer tests; an embedded build asks C for a database's capture status as a number instead of a formatted string, copies the SQL once (C adds the strict marker), and sends `[]` for no parameters without calling `JSON.stringify`. Results, errors and `meta` are unchanged (new `d1-shim.test.js` cases: every transaction keyword in either case and with leading space, statements that share a first letter with one, `raw()` and `first()` against `all()`, parameter types).
