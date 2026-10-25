---
"@sproutboat/runtime": minor
"@sproutboat/wire": minor
"@sproutboat/config": minor
---

Queues like Cloudflare's, from compatibility date 2026-10-31, with queue names and consumer
settings in `sproutboat.jsonc` at every date.

- **Config (`@sproutboat/config`):** a `queues` entry may be `{ "binding": "QUEUE", "queue": "q",
  "max_batch_size": 10, "max_batch_timeout": 1, "max_retries": 3, "retry_delay": 0,
  "dead_letter_queue": "dlq" }`, the settings named as in wrangler's `queues.consumers`; `id`
  is optional there. `queueSettings()` normalizes the entries for the build, and `pinBindingId`
  adds an id to such an object.
- **Names and settings, at every date (opt-in):** `batch.queue` is the queue's name (the binding
  name when unset). `max_batch_size` (1 to 100, default 10) and `max_batch_timeout` (0 to 60 s,
  default 0: delivered at once, where Cloudflare waits up to 5 s) shape batches; `max_retries`,
  `retry_delay` and `dead_letter_queue` decide what a retry does. A dead letter queue the worker
  doesn't bind keeps its messages until one does.
- **From 2026-10-31:**
  - `send()` and `sendBatch()` return Promises of `{ metadata: { metrics } }`, the queue's backlog
    after the send as Cloudflare documents it (miniflare answers zeros); `metrics()` is added.
  - Bodies keep their content type: `json` (the default), `text`, `bytes` (arrives as an
    ArrayBuffer) and `v8` (structured clone). A string that looks like JSON or a number arrives as
    the same string.
  - workerd's argument errors: an undefined or BigInt `json` body, a `text` body that isn't a
    string, an unknown content type, a body over 128 KiB, an empty batch, more than 100 messages
    or 256 KiB in a batch, a batch that isn't iterable.
  - A message is `{ id, timestamp, body, attempts }`, `timestamp` a Date of when it was sent, with
    `ack()` and `retry({ delaySeconds })` on its prototype; a batch has `queue`, `messages` and
    `metadata`, with `ackAll()` and `retryAll({ delaySeconds })`. The first of `ack()` and `retry()`
    wins, and a message's own call wins over `ackAll()`/`retryAll()`, as Cloudflare documents
    (miniflare lets a later `retryAll()` win).
  - By default a message is retried at once, 3 times, then dropped or sent to the dead letter
    queue. Earlier dates keep 5 s between attempts and 5 attempts.
- **Stores (embedded transport and `@sproutboat/wire`'s broker):** messages keep their send time
  (an additive `sent_at` column), `queue.send` answers the backlog when asked, `queue.metrics` is
  new, and a batch's outcome may carry retry delays and messages for the dead letter queue. An
  older broker ignores those and retries as before; bodies sent from 2026-10-31 are tagged text, so
  they travel through it unchanged.
