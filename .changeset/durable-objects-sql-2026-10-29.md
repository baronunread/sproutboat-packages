---
"@sproutboat/runtime": minor
"@sproutboat/wire": minor
---

Durable Objects `ctx.storage.sql` from compatibility date `2026-10-29`, on every
transport. Each object gets its own SQLite database.

- `exec(query, ...bindings)` runs one statement and returns a cursor with `toArray()`,
  `one()`, `raw()`, `next()`, iteration, `columnNames`, `rowsRead` and `rowsWritten`.
- BLOBs come back as ArrayBuffers.
- Foreign keys are enforced.
- `BEGIN`, `SAVEPOINT` and the other transaction statements throw workerd's error. Use
  `storage.transactionSync(fn)`, which rolls back if `fn` throws.
- `sql.databaseSize` gives the database's size in bytes.
- Errors read as in workerd, for example `near "SELEKT": syntax error at offset 0:
  SQLITE_ERROR`.

Every Durable Object class gets `sql`, since `sproutboat.jsonc` has no
`new_sqlite_classes`. The key-value API keeps its own store.

Where the databases live:
- **Standalone executables and sproutd:** in `<data>/do-sql/CLASS/ID.sqlite`. At most 8
  stay open, and the one used longest ago closes for the next one.
- **Broker (wire):** new op `do.sql`. With `doDb`, the databases sit in
  `<doDb without .sqlite>.do-sql/` next to it, so they survive a redeploy and stay
  separate per project. Without a SQL pool, the broker keeps at most 64 open
  (`createD1Store`'s new `maxOpen`).
