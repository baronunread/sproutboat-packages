---
"@sproutboat/toolchain": patch
---

A standalone binary writes a response's plain-ASCII header names, header values and body straight from the JavaScript heap. The native server used to copy each of them into a `malloc`ed UTF-8 buffer one byte at a time, twice for every header and once for the body: about 5% of the CPU of a 4 KB reply. A bytestring whose bytes are all below 0x80 already is its UTF-8 text, so it is now read in place; a UTF-16 string or a byte of 0x80 or more takes the same copying path as before. The change is in the native shim only (`compiler/uwebsockets.js`); `render.js`, and so sproutd, is untouched.
