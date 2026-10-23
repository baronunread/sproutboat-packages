---
"@sproutboat/runtime": minor
---

Durable Objects like workerd from compatibility date `2026-10-29`:

- **RPC on stubs.** In a class that extends `DurableObject` (from `cloudflare:workers`),
  any method can be called as `await stub.method(args)`. Arguments and results are
  copied as structured clone does (the 2026-10-28 storage codec: Date, Map, Set,
  BigInt, `Uint8Array`, `undefined` in containers and so on), and a function argument
  becomes a callback the object can call. The call goes through the object's input
  gate like `fetch()`. An exception in the method rejects the caller's Promise with the
  same error. A getter is read with `await stub.prop`. A method the class does not
  define rejects with workerd's TypeError, and a Symbol argument with a DataCloneError.
  `this.ctx` and `this.env` are set on the instance.
- **Ids are 64 hex digits**, with `equals()` and, from `idFromName`, `name`.
  `idFromName` is deterministic and differs per class. `idFromString` throws a
  TypeError for anything other than 64 hex digits and for an id made by another
  namespace. `newUniqueId()` is random.
- `namespace.getByName(name)`, `namespace.jurisdiction()`, and `stub.id` and `stub.name`.
- **An exception in the object rejects `stub.fetch()`** with that error, as in workerd.
  It used to resolve to a 500 response.

No data is lost by moving an app to `2026-10-29`. The storage and the alarm of an object
named under an earlier date (`name:NAME`) move to its 64-hex id the first time a process
creates the object. `idFromString` still accepts the `name:` and `uid:` strings that
earlier dates gave out.

At `2026-10-28` too, a Symbol given to Durable Object storage is named in its DataCloneError
(`Symbol(s) could not be cloned.`) instead of `value`.
