---
"@sproutboat/runtime": patch
---

`atob()` and `btoa()` give the right result for any string. They used Porffor's own implementations, which read how a string is stored, so they went wrong on strings held as UTF-16, such as ones from `JSON.parse` or `TextDecoder`:

- `atob(JSON.parse('"AQL/"'))` returned two wrong bytes instead of `01 02 ff`;
- `btoa` of a parsed `"héllo"` encoded the UTF-16 storage.

Both are now plain JavaScript, with the same validation and errors as before.
