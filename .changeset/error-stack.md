---
"@sproutboat/runtime": patch
---

`error.stack` is a string, V8's first line (`TypeError: message`), instead of `undefined`, for every error type including errors the runtime throws. Porffor keeps no frames to list after it.
