---
"@sproutboat/runtime": patch
---

Storage review fix M4 (design 029), dark like the rest of S1: the next epoch number of a captured file is also above the `epoch-floor` file in the file's spool directory (decimal; the host role's reseed leaves the epoch the replica's file has reached), not only above the position record and the clock. A promoted host whose clock is behind the previous leader's last epoch no longer numbers its epochs below what the replicas applied.
