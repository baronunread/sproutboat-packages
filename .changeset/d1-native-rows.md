---
"@sproutboat/runtime": patch
---

Faster strict D1 queries in standalone builds (compatibility date 2026-10-24 and later): the rows of a result are built as JS arrays in C, straight from the SQLite cells, instead of being written as JSON text in C and parsed again in JS. NULL, numbers, text (UTF-8 decoded exactly as the JSON path decoded it, including invalid sequences), BLOBs (byte arrays) and empty results are unchanged. Only a small header (columns, changes, last row id) still goes through JSON. Older compatibility dates and non-D1 operations keep the JSON path.

On one pinned x86 core at a fixed rate, CPU per request against a 500,000-row feed API, see the PR for numbers.
