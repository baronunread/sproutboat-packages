---
"@sproutboat/runtime": minor
---

Storage stage S4 (design 029), runtime half of "the barrier names the touched keys", dark like S3: it changes nothing unless the gate is on.

- **A dirty line per counted commit.** For an app with the gate on, the runtime appends the key of every commit it counts for the gate (`sb_commit_seq`) to the app's `dirty` list, unthrottled and *before* the counter moves. The store's barrier can then read just the keys that list names since its last read, instead of every key of the app (which costs more the more Durable Objects the app has). Without the gate the list is what it was: a hint, a key named at its first commit and again after a second.
- The store side (sproutd `deploy/store-rs`, `touched_keys`) keeps the keys that failed to ship and puts a read list back if the ingest fails, so a key a barrier skipped is never forgotten; a list it cannot read makes it read every key.

Generation impact: the inline C (one extra append per counted commit; a `stat` of the list to notice a rotation): ships with the S3 generation (tier `prelude`), no other change.
