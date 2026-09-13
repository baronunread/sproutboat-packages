---
"@sproutboat/toolchain": minor
---

Vendor the pinned Porffor commit tarball (`packages/toolchain/vendor/`) so `ensurePorffor()` needs no network on the happy path — same pattern as sproutboat-cli's vendored uWebSockets archive. Falls back to the existing checksummed download if the file is missing, or was left stale by a pin bump that forgot to re-vendor.

Part of sproutboat-cli #134 item 3.
