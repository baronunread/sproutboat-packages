---
"@sproutboat/runtime": patch
---

`crypto.getRandomValues` fills every byte of the view, as WebCrypto does. It filled only the low byte of each element, so a `Uint32Array` came back with values below 256 and any code that draws an integer from `getRandomValues(new Uint32Array(1))` got the same bucket every time. It now also throws a `TypeMismatchError` for a `Float32Array`, a `Float64Array`, a `DataView` or a non-view, and the 65536 limit counts bytes, not elements. Found while testing third-party packages.
