---
"@sproutboat/runtime": patch
"@sproutboat/toolchain": patch
---

An unhandled promise rejection no longer ends the process. A D1 call that failed and was never awaited (`db.prepare("INSERT ...").run()` that broke a foreign key) threw its error out of Porffor's promise job loop into the host's "Uncaught ..." exit, taking every in-flight request down even with a try/catch around the call. As on Workers it is now reported: a log line (`Uncaught (in promise) ...`) and an `unhandledrejection` event (`PromiseRejectionEvent` with `promise` and `reason`) on the global scope when `addEventListener("unhandledrejection", ...)` has a listener, and the process and other requests carry on. This applies at every compatibility date, because a crash is a bug rather than a behaviour an app can depend on. The toolchain's `patchUnhandledRejections` calls the runtime's `globalThis.__sbOnUnhandledRejection`; plain Porffor without it keeps the throw. Applies to every binding call that returns a rejecting Promise (D1, KV, R2, Durable Objects, Queues, fetch). An un-awaited `async function` that throws is still dropped silently, as before.
