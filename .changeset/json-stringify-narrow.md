---
"@sproutboat/toolchain": patch
---

`JSON.stringify` hands back an 8-bit string when every character fits in one byte (it always returned UTF-16), and a plain string that needs no escape no longer takes a 4 KiB zeroed buffer. A response built from `JSON.stringify` pieces stays 8-bit, so concatenating it copies half the bytes and the server writes it without re-encoding each unit. The characters are unchanged (`test:native-json` and `test:native-json-strings` pass).
