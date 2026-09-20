---
"@sproutboat/runtime": minor
---

`Request`/`Response` gain `formData()` (baronunread/sproutboat#60), parsing the buffered body synchronously — `application/x-www-form-urlencoded` via the existing `URLSearchParams` shim, `multipart/form-data` by hand (RFC 7578 boundary parsing, file fields come back as `Blob`s). Also adds `bytes()` (the `Uint8Array` shorthand over `arrayBuffer()`) to both classes. Everything is feature-detected, so this is a no-op the moment Porffor ships either natively.
