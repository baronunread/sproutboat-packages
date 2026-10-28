---
"@sproutboat/runtime": patch
---

A strict D1 query in a standalone binary does less around SQLite. It skips the generic dispatch (a request object, a walk down the op list, a result object), a statement is a class instead of an object with five closures, `raw()` and `first()` no longer build the `meta` they throw away (two clock reads), the transaction-keyword check reads character codes instead of compiling a regular expression on every query, and the column names, change count and row id come back as JavaScript values built in C instead of as JSON text that is written, parsed and discarded. Replies, errors and `meta` are unchanged.
