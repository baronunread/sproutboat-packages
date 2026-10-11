---
"@sproutboat/toolchain": patch
---

Register direct-only local function expressions in their lexical scope so type inference does not borrow an unrelated same-named function's return type. Fixes Better Auth's model-name resolver incorrectly treating an existing user schema as missing.

Correct Uint8Array base64 option string tags and complete-chunk truncation, unblocking base64url signatures and fixing padding and decoding.
