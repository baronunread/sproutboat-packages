---
"@sproutboat/toolchain": patch
"@sproutboat/runtime": patch
---

`Headers` is iterable (`new Map(headers)`, `[...headers]`, `Object.fromEntries(headers)`), and `new Headers([["name", "value"]])` reads the pairs instead of producing headers named "0", "1"...
