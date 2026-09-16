---
"@sproutboat/runtime": minor
"@sproutboat/toolchain": patch
---

Add a native standalone R2 direct-upload bridge that streams transfer-ticket
request chunks to a temporary blob file, validates the digest, and atomically
publishes the object without buffering the upload in the Porffor request body.
