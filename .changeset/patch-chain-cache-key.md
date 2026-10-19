---
"@sproutboat/toolchain": patch
---

The Porffor cache entry is keyed by a fingerprint of the patch chain as well as the toolchain release. A patch edit that ships under the same version now gets a freshly patched compiler, instead of reusing an entry an older chain marked complete. Builds against such an entry failed to link once the runtime began calling `sb_stream_*`. Old entries stay on disk and are no longer used.
