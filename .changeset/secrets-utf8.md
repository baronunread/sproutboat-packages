---
"@sproutboat/runtime": minor
---

Secrets read from the environment (a standalone binary, a sproutd worker) are decoded as UTF-8 from the proposed compatibility date 2026-11-07. Before, the handler got the environment's bytes one char per byte, so `é` arrived as `Ã©`. The broker transport is unchanged: its secrets already arrive as real strings. Bytes that are not valid UTF-8 pass through as before.
