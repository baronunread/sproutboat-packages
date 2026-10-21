---
"@sproutboat/runtime": minor
---

Add experimental bounded local LTX replication to the embedded SQLite transport.
Opt in with compatibility date 2026-10-22 and SB_LTX_ENABLE=1. A single writer
owns the database, commits are captured durably before checkpoint, and the WAL
has an enforced byte ceiling. Default behavior and the broker are unchanged.

Developed with AI assistance from OpenAI Codex (GPT-6.1).
