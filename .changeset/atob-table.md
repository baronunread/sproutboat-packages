---
"@sproutboat/runtime": patch
---

Faster `atob`: each character is looked up in a 128-entry table instead of `indexOf` over the alphabet, and the same pass validates, so the regex test over the whole input is gone. Same output and same `InvalidCharacterError` cases (checked against the platform `atob` on 9,000 random inputs and edge cases).

A JWT check decodes three base64url parts. On one pinned x86 core at a fixed rate, CPU per request: like 854 to 761 us, create 922 to 866 us; feed and post reads do not call `atob`.
