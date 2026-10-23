---
"@sproutboat/runtime": minor
"@sproutboat/wire": minor
---

Durable Objects like workerd from compatibility date `2026-10-28`:

- **Input gate.** While an object's storage read is in flight, no other event
  (`stub.fetch()`, an alarm) enters it, so `const v = await storage.get("n"); await
  storage.put("n", v + 1)` is safe under concurrent calls. Ten concurrent increments used
  to end at 1. An event that awaits anything else (a fetch, a timer) lets the next one
  in, as in workerd. `blockConcurrencyWhile()` and `transaction()` hold the gate until
  they settle, and `stub.fetch()` always returns a Promise.
- **Storage returns Promises** (`get`, `put`, `delete`, `deleteAll`, `list`, the alarm
  methods), and adds `sync()` and `transaction()` (with `txn.rollback()`; a throw rolls
  back; a transaction reads its own writes).
- **Structured values.** Date, Map, Set, RegExp, ArrayBuffer and typed arrays, BigInt,
  `undefined` inside containers, NaN, the infinities and -0 round-trip.
  `put(k, undefined)` throws a TypeError and a function throws a DataCloneError, before
  anything is written.
- `list()` takes `start`, `startAfter`, `end` and `reverse`, and `limit: 0` throws.
  `setAlarm()` refuses a value that is not a Date or a number. `deleteAll()` also drops
  the alarm.

Earlier dates keep synchronous JSON storage and no gate. Values written from
`2026-10-28` start with `#sb1:`, and every date reads both formats.

Both transports' `do.storage.list` take `start`, `startAfter`, `end` and `reverse`, and
match the prefix exactly (SQL `LIKE` also matched `_` and `%` as wildcards, ignoring
case, so a prefix such as `user_` listed other keys).
