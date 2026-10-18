# `@sproutboat/wire`

Broker frame protocol and the JSON validation utilities it is built on.
Single source of truth shared by the CLI dev broker and the platform's
edge and supervisor.

```sh
bun add @sproutboat/wire
```

```ts
import { createBroker } from "@sproutboat/wire";
import { parseJsonValue } from "@sproutboat/wire";
```

## API

- `createBroker(options)` opens a binding broker over a resource file:
  KV, D1, R2, queues, Durable Object storage and alarms, Analytics Engine
  points, secrets, outbound fetch. Frame envelope, both directions:
  `[u32 LE length][payload]`.
- Frame helpers: `frameOf`, `encodeFrame`, `encodeV1`, `FRAME_V1`,
  `cronMatches`, plus the `Broker`, `BrokerOptions`, `BrokerServer`,
  `FetchLike` and `Frame` types.
- JSON boundary parsing: `parseJsonValue`, `jsonObject`, guards
  (`isString`, `isBoolean`, `isSafeInteger`), `JsonValue` and `JsonObject`
  types. Parse at the I/O boundary, then narrow; nothing downstream takes
  an unparsed value.

See `src/broker.test.ts` for the protocol contract in executable form.

## Shared SQL execution budgets

Shared mode requires the small SQLite deadline extension. Build it during host
or image preparation, before starting the broker, with:

```sh
bun packages/wire/src/build-d1-budget.ts
```

From the published package directory, use `bun run build:sql-budget`. The build
needs a C compiler and SQLite development headers (`gcc libsqlite3-dev` on
Debian/Ubuntu). It uses SQLite's extension ABI and does not link another SQLite
engine on Linux. Native outputs are host-specific and excluded from the source
package. The platform installer builds the extension during provisioning and
staged updates; tenant requests never invoke a compiler.

The default shared D1 execution budget is 1,000 ms per operation, including an
entire transactional batch. Operators can set `SPROUTBOAT_D1_EXECUTION_MS` to an
integer from 10 to 30,000. Queue admission remains 128 active/queued calls per
broker, 16 per session, with a separate ten-second queue deadline. Tenant request
fields cannot change execution budgets.

A native progress callback checks the monotonic deadline every 1,000 SQLite VM
instructions. Interrupted batches roll back, and the same SQL lane remains
usable. Multi-statement `exec` retains SQLite's existing partial-commit behavior:
earlier statements can have committed before a later statement fails. The
executor never automatically retries uncertain mutations.

Locks and other native operations may not poll SQLite progress. A broker-thread
watchdog allows one additional second, then revokes the broker and all of its
sessions through supervisor recovery. That fallback reports an uncertain SQL
outcome; it does not assert that every earlier mutation rolled back. Shared mode
remains opt-in, and this mechanism is not a memory isolation boundary.

On macOS, Bun's default Apple SQLite disables extensions. Install an
extension-capable SQLite library and select it before opening any SQLite DBs.
The shared broker and package test preload select Homebrew's standard library
location; `SPROUTBOAT_D1_SQLITE_LIBRARY` overrides it. `SQLITE_INCLUDE` overrides
the build header directory, and `SPROUTBOAT_D1_BUDGET_EXTENSION` overrides the
trusted extension path. Linux uses Bun's existing SQLite engine. Dedicated
broker mode does not enable execution budgets.
