---
"@sproutboat/runtime": patch
---

`DOMException` is now a real, constructible global. Porffor's own `DOMException` reports `typeof` "function" but throws "not a constructor", so `new DOMException("m", "AbortError")` failed and any library that tests `error instanceof DOMException` or builds one could not run. The prelude installs a class that extends Error with the legacy numeric `code`, the `ABORT_ERR`-style constants, the `{ name, cause }` options form, and `AbortSignal` abort and timeout reasons and WebCrypto errors are instances of it. Found while testing third-party packages (timers, queue, rpc, websockets).
