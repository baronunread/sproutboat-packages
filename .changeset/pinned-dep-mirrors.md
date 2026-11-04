---
"@sproutboat/toolchain": patch
---

Add `fetchPinned` and the BearSSL pin (`BEARSSL_URLS`, `BEARSSL_SHA256`): an ordered mirror list with our own release asset first and bearssl.org as the fallback, a bounded retry with backoff on 5xx, and a sha256 check on every source, so an upstream outage no longer stops a build and a mirror cannot change what gets built.
