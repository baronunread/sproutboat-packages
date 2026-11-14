---
"@sproutboat/toolchain": minor
---

Standalone builds default to Porffor alpha 24 (`1b8225e`) instead of alpha 23. `SPROUTBOAT_PORFFOR_CHANNEL=alpha-23` selects the previous default for one release as a fallback; `alpha-22` and `alpha-19` stay selectable. The `native-cc` and `native-lto` checks now run on alpha 24 as well (they skipped on any channel but alpha 23). Do not merge before the production promote of 2026-11-15.
