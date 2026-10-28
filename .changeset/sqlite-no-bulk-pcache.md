---
"@sproutboat/runtime": patch
---

A standalone binary stops mapping and unmapping 88 KiB for every statement that builds a temporary table. SQLite allocates 20 pages in one block for each page cache it creates, and `INSERT ... RETURNING` (and any sort that spills to a temporary table) creates one, so each such statement cost an `mmap` and an `munmap`. The runtime now sets the initial page-cache allocation to 0 before SQLite starts, so a cache takes its pages one at a time as it grows. Query results and the main database's cache size are unchanged.
