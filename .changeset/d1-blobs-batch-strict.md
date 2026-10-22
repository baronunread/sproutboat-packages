---
"@sproutboat/runtime": patch
"@sproutboat/wire": patch
---

D1 correctness fixes, in the standalone (embedded) transport and the broker:

- **Bytes are no longer lost.** Binding a `Uint8Array`, another typed array, a `DataView` or an `ArrayBuffer` stored NULL in a standalone sprout, along with every parameter after it. It now stores a BLOB, at every compatibility date. On earlier dates a BLOB still reads back as before: as one character per byte.
- **`batch()` is one transaction** in a standalone sprout, as it already was through the broker and is in D1: if a statement fails, the ones before it are rolled back. This applies at every compatibility date.
- **From compatibility date `2026-10-23`**, D1 follows workerd's rules:
  - a parameter must be `null`, a number, a string, a boolean or bytes, or the call throws `D1_TYPE_ERROR` (before, `undefined` and objects became NULL);
  - the number of parameters must match the statement (`D1_ERROR: Wrong number of parameter bindings for SQL query.`);
  - foreign keys are enforced (`PRAGMA foreign_keys = ON`);
  - errors read `D1_ERROR: <message>: SQLITE_<CODE>`;
  - a BLOB reads back as an array of byte values.

  Apps with an earlier `compatibility_date` keep the old behaviour. To opt in, move the date to `2026-10-23` or later and rebuild.
- `meta.changes` is 0 for a statement that only reads. It used to repeat the previous write's count.
