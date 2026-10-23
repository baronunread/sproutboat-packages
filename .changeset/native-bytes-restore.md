---
"@sproutboat/toolchain": minor
---

Add a versioned native bytes ABI for a trusted offline LTX restore build. The
compiler rejects every adapter builtin unless the builder explicitly sets
`--sb-native-bytes-v1`. Ordinary app builds never enable this flag. No runtime
compatibility date changes: the feature is a build-only opt-in, and unused
programs receive no helper bodies.

The lazy builtins validate fixed Uint8Array views, bounded positioned I/O and
file-control operations. CRC64 reuses `sb_ltx_crc` from the actual embedded
transport being compiled; a missing provider fails compilation. Layout and
patch guards fail on unexpected compiler changes. The patch fingerprint changes,
so native hosts must regenerate and requalify before adoption.

AI assistance: OpenAI Codex (GPT-6.1).
