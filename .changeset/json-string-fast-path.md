---
"@sproutboat/toolchain": patch
---

Faster `JSON.stringify` of strings: each character is read straight from the string and stored when it needs no escape, instead of a `charCodeAt` call per character. Quotes, backslashes, control characters and every surrogate still take the escaping branches, so the output is byte-identical to the spec's (new native test `test:native-json-strings`: control characters, DEL, U+2028 and U+2029, Latin-1, BMP and astral text, lone and misordered surrogates, as values, keys, array items and nested, compared with Bun).
