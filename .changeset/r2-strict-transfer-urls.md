---
"@sproutboat/runtime": patch
---

runtime: the promise-returning R2 binding (compatibility date 2026-10-26 and later) has `createUploadUrl()` and `createDownloadUrl()` again, with the semantics of the legacy binding (the same `r2.transfer.create` call, now returning promises). They were missing there, so an app that moved past 2026-10-26 lost direct transfer with a "not a function" error. No date gate: the methods did not exist at those dates, so nothing that worked changes.
