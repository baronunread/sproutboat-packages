---
"@sproutboat/runtime": minor
"@sproutboat/wire": minor
---

KV matches workerd from compatibility date `2026-10-25`:

- `get`, `getWithMetadata`, `put`, `delete` and `list` return Promises, and errors reject them.
- `get(key, type)` takes `"text"`, `"json"`, `"arrayBuffer"` and `"stream"`, and `get([keys])` returns a `Map`.
- `getWithMetadata(key, type)` returns `{ value, metadata, cacheStatus }`.
- `put(key, value, { expiration, expirationTtl, metadata })` takes strings, bytes and `ReadableStream`s, and stores the metadata.
- `list({ prefix, limit, cursor })` returns `{ keys: [{ name, expiration?, metadata? }], list_complete, cursor?, cacheStatus }` and pages at up to 1,000 keys.
- Keys, values, expirations, metadata and list limits fail with KV's own errors. For example: `Key name cannot be empty.`, `KV PUT failed: 414 UTF-8 encoded length of 513 exceeds key length limit of 512.`, `KV PUT failed: 400 Invalid expiration_ttl of 30. Expiration TTL must be at least 60.`, and `KV PUT failed: 413 Metadata length of 1110 exceeds limit of 1024.`

Earlier dates keep the synchronous shim. Two changes apply at every date:

- **A `list()` prefix now matches exactly.** It used SQL `LIKE`, so it ignored case and read `_` and `%` as wildcards. For example, the prefix `a_` also listed `ab`, and `a` also listed `AB`.
- **Both transports store KV metadata in a new column.** It's added to existing stores when they open.
