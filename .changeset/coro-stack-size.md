---
"@sproutboat/toolchain": patch
---

Raise Porffor's per-coroutine fiber stack from 256 KiB to 8 MiB. A large async handler compiled at -O0 (`sproutboat dev`) overflowed it within a few nested awaits and died with SIGBUS on its first request (baronunread/sproutboat#178). Only touched pages cost memory.
