---
"@sproutboat/toolchain": minor
---

The collector can be told the app's memory limit. `porf_gc_set_limit(bytes)` (a new export of the generated runtime, next to `porf_gc_quiet` and `porf_gc_seal_heap`) sets the share of the limit the JS heap may reach, and `porf_gc_budget` and `porf_gc_cycle`'s nursery cap then stay below half of what that leaves above what is live (never under 1 MiB). Unset, the pacing is Porffor's own, byte for byte. sproutd's worker calls it at start with 75% of its cgroup's `memory.max`; a worker at the default 32 MiB was OOM-killed 26 to 28 times in 400 requests of 1 MiB bodies at concurrency 8, because one JS turn allocated 12 to 17 MiB before the host could collect. The runtime changes, so the sproutd generation's ABI changes with it; no app source changes and nothing an app can observe does (no compatibility date). The standalone server is unchanged: it never sets a limit.
