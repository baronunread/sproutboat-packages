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
