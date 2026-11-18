---
"@sproutboat/runtime": minor
"@sproutboat/wire": minor
---

Analytics Engine stores points the way it should have from the start: an index, a counter and retention. Before, `env.X.query({ limit })` scanned and sorted every point of the dataset and then counted them again (75 to 87 ms with 80,000 points, about 1 ms more per 1,000), and nothing was ever deleted.

- **Index.** `ae_dataset_ts` on `(dataset, ts)`, made with `CREATE INDEX IF NOT EXISTS` when the store opens, so an existing store gets it on its next open. `query()` now reads the newest `limit` points from the index and sorts nothing.
- **Counter.** `ae_count (dataset, n)`, kept exact by an insert trigger and a delete trigger on `ae` (so a writer that does not know about the counter, such as a worker of the previous runtime during a swap or after a rollback, is still counted). It is made once, filled from the points already stored, in one transaction. `query()` reads one row for `count`; the result shape is unchanged.
- **Retention, from compatibility date `2026-11-19`.** Points older than 92 days are deleted (Cloudflare keeps Analytics Engine data for three months). An app of an earlier compatibility date keeps every point it has written, as before; the index and the counter apply to every app, since nothing they change is visible. (`@sproutboat/wire`, the `sproutboat dev` store, has no compatibility date and always prunes.) A dataset also holds at most 1,000,000 points, the oldest going first. A write prunes its own dataset at most every 10 seconds per process and removes at most 1,000 points per run (the age rule and the cap share it) through the index, so nothing big is deleted on a request's way in, and a backlog is worked off over the writes that follow. A failed prune never fails the write.

Generation impact: `transport-embedded.js` is inlined into the shared prelude every sproutd app compiles against, so the embedded half changes the prelude (tier `prelude`, a runtime generation). The broker half (`@sproutboat/wire`) is an ordinary release.
