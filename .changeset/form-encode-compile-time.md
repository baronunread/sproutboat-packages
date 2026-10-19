---
"@sproutboat/runtime": patch
---

Builds are fast again: the URLSearchParams serializer added in the previous release doubled native compile time (a hello-world handler went from 6.6 s to 13.4 s); it now encodes in one pass and compiles in 6.8 s.
