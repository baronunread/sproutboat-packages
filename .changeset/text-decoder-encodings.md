---
"@sproutboat/toolchain": patch
---

`TextDecoder` now decodes UTF-16LE, UTF-16BE and windows-1252 (with its `latin1`, `iso-8859-1` and `ascii` labels) besides UTF-8: BOM handling, `fatal`, `ignoreBOM`, lone surrogates and `{ stream: true }` across odd chunk boundaries follow the Encoding standard. Any other label still throws a RangeError. `Blob.prototype.stream()` now exists and returns a one-chunk byte stream, and a `Response` you construct has `url` "" and `redirected` false instead of `undefined`. Found while testing third-party packages.
