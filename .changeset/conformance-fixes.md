---
"@sproutboat/toolchain": patch
"@sproutboat/runtime": patch
---

Fixes found by the new differential conformance suite against workerd:

- `JSON.stringify` of a cyclic object throws `TypeError` instead of crashing the process (it recursed until the native stack overflowed), so one request can no longer take a worker down.
- `structuredClone` follows the structured-clone algorithm: cycles, `Map`, `Set`, `Date`, `RegExp`, typed arrays, `DataView` and errors survive the copy, and functions and symbols throw `DataCloneError`. It was a JSON round-trip that lost every non-JSON type and also crashed on cycles.
- `Event`, `CustomEvent`, `EventTarget`, `AbortSignal` (`abort`, `timeout`, `any`, `throwIfAborted`) and `AbortController` exist.
- `Object.prototype.toString` names typed arrays (`[object Uint8Array]`, not `[object Object]`).
