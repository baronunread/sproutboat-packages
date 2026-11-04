---
"@sproutboat/toolchain": patch
---

Add `fetchPinned` and the BearSSL pin (`BEARSSL_VENDORED_PATH`, `BEARSSL_URLS`, `BEARSSL_SHA256`): the source tarball is vendored in the repo and read locally first, bearssl.org is the fallback, a bounded retry with backoff applies to 5xx, and a sha256 check applies to every source, so an upstream outage no longer stops a build and a bad file cannot change what gets built.
