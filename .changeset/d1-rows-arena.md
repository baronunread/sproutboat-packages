---
"@sproutboat/runtime": patch
---

A strict D1 query hands its rows to JavaScript with fewer copies: the text of every cell goes into one arena instead of one `malloc` per cell, and a cell that is plain ASCII becomes its JS string in one copy (it used to go through a UTF-16 buffer, an 8-bit buffer and a third copy, three `malloc`s each). Non-ASCII text still takes the old path, so the strings are unchanged.
