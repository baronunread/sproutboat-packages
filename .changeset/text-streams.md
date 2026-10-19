---
"@sproutboat/runtime": patch
---

`TextEncoderStream` and `TextDecoderStream` exist. The decoder runs `TextDecoder` in streaming mode, so a character split across chunks decodes correctly, and the encoder holds a lone high surrogate until the next chunk.
