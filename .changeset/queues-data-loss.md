---
"@sproutboat/runtime": patch
---

Queues fixes at every compatibility date (data loss, so not gated):

- On the embedded transport (standalone sprouts and sproutd), `sendBatch()` stored every
  body as the text `"[object Object]"`. It now stores the body it was given, and both
  `send()` and `sendBatch()` honour `delaySeconds` there, as the broker already did.
- A consumer whose `queue()` throws now retries every message it had not explicitly
  acked or retried, as on Workers. The embedded transport used to ack the whole batch,
  so a failing consumer lost its messages. Explicit `ack()` / `ackAll()` calls made
  before the throw still count (Cloudflare's documented behaviour; miniflare retries
  those too).

From compatibility date `2026-10-28`, `sendBatch(messages, { delaySeconds })` delays
every message whose own `delaySeconds` is unset or 0. Earlier dates ignore the batch
option.
