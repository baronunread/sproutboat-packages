---
"@sproutboat/toolchain": patch
---

Named class expressions work inside handlers again (baronunread/sproutboat#256). Inside a function, Porffor gave a class expression's own name, as seen from its methods, a new function object instead of the class, so `var R = class l { static lex() { return new l() } }` failed with "value is not a constructor". Every handler has run inside a function since #238, and bundlers emit this shape for any class whose static members refer to themselves, so marked and similar packages broke. A parse-time rewrite turns such a class into the equivalent `(() => { const l = class { ... }; return l; })()`, which Porffor handles correctly.

The ISO date parser no longer reads one byte past the end of the string. When that byte happened to be `+` or `-`, a timezone offset's sign flipped, so `-00:30` could parse as `+00:30` depending on what sat next in memory.
