---
"@sproutboat/runtime": minor
---

Background work on sproutd (sproutd B22), and cron-only Workers everywhere:

- A Worker may export only `scheduled()` or `queue()`, with no `fetch()`, as on workerd
  (Cloudflare's `cron-trigger` example used to be refused at build). An HTTP request to such
  a Worker answers 500 and logs workerd's "Handler does not export a fetch() function.".
- A Worker whose only binding-like setting is `triggers.crons` now runs its crons in a
  standalone executable; before, the local triggers started only when another binding existed.
- The embedded transport's cron runs `scheduled()` with `env` from compatibility date
  2026-09-28, like the broker path, and logs a throw instead of leaving it unhandled. Queue
  consumers and `scheduled()` may be `WorkerEntrypoint` methods.
- When the worker host takes notes (sproutd's bridge sets `sb_host_note_hook`; nothing else
  does), the embedded transport starts no trigger timers. It reports its crons, and when queued
  messages and Durable Object alarms fall due, and the host delivers them with an
  `x-sb-trigger: scheduled` or `due` request, waking a reaped app for them. Standalone and
  platform sprouts behave as before.
