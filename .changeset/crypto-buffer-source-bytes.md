---
"@sproutboat/runtime": patch
---

Preserve raw bytes in `crypto.subtle.digest`, HMAC signing, and `crypto.scryptVerify`. The runtime's byte conversion already produces UTF-8 bytes for text and copies BufferSource inputs exactly, so the native bridge must pass those bytes through without encoding them again. This fixes repeated HMAC signing with digest bytes above `0x7f`.
