---
"@sproutboat/runtime": minor
---

Service bindings support Workers RPC.

**Callee.** A deployment whose default export extends `WorkerEntrypoint`, imported from `cloudflare:workers`, exposes its methods:

- `env.SERVICE.add(2, 3)` runs `add(2, 3)` on a fresh instance, with `this.env` and `this.ctx` set, and resolves to its result.
- Arguments and results are copied as structured clone does: `undefined`, `NaN`, `-0`, `Date`, `RegExp`, binary data, `Map`, `Set` and errors survive the trip.
- An error the method throws rejects the call with the same class and message.
- An unknown method rejects with workerd's `TypeError`.
- Passing functions or RPC stubs is not supported yet.

**Where it works.** RPC travels over the service-binding calls a platform edge vouches for, so no client can invoke a method.

**Imports.** `cloudflare:workers` provides `WorkerEntrypoint`, `DurableObject`, `RpcTarget` and `env`. The runtime turns the import into globals, so a handler that imports it runs both bundled and as plain ESM.

**Default exports.**
- A class default export is instantiated per request, for `fetch`, `scheduled` and `queue`.
- A `WorkerEntrypoint` may have no `fetch` at all.
