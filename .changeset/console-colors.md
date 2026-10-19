---
"@sproutboat/toolchain": patch
---

`console.log` colours values only when stdout is a terminal. Piped or redirected output, like sproutd's per-app logs or a standalone sprout's output collected by a service manager, no longer contains ANSI escape codes such as `\x1b[33m42\x1b[0m`.
