# `@sproutboat/runtime`

The sprout runtime as a unit: the binding and trigger wrapper, handler
source validation, both transports (broker and embedded), and the
native-fetch prelude. These move as one because `wrap.ts` locates the
prelude and transports by file URL beside itself.

```sh
bun add @sproutboat/runtime
```

```ts
import { preludePath, transportPath, wrapNativeFetchHandler } from "@sproutboat/runtime";
import { validateHttpSyncSource } from "@sproutboat/runtime";
```

## API

- `wrapNativeFetchHandler(...)` turns a user's `export default { fetch }`
  into a native-fetch module with bindings, triggers, and env installed.
  `Bindings`, `EMPTY_BINDINGS`, `readVarsFromEnv`, `readBindingsFromEnv`,
  and `neutraliseExports` travel with it.
- `preludePath` / `transportPath(transport)` locate the prelude and the
  `broker` / `embedded` transports on disk. The prelude is read as text
  and prepended before compilation, never imported.
- `TRANSPORT_MARKER`, `BASELINE_COMPATIBILITY_DATE`, `Transport` type.
- `validateHttpSyncSource(source)` checks a bundled handler module
  (`SourceValidation`), used by project checks on both sides.

The prelude shims the Web API surface handlers expect (URL, Response,
crypto random values, binding shims, trigger dispatch) and is identical
for both transports, which is what lets one conformance suite hold them
honest.

## R2 multipart uploads

R2 bindings implement the Cloudflare multipart method shape for objects that
are larger than one safe request body:

```js
const upload = env.FILES.createMultipartUpload("archive.tar", {
  httpMetadata: { contentType: "application/x-tar" },
  customMetadata: { source: "backup" },
});

const parts = [];
parts.push(await upload.uploadPart(1, firstChunk));

const resumed = env.FILES.resumeMultipartUpload(upload.key, upload.uploadId);
parts.push(await resumed.uploadPart(2, finalChunk));

const object = await resumed.complete(parts);
```

Part numbers must be between 1 and 10,000. Parts must be supplied to
`complete()` in ascending order. Every part except the last must have the same
size, and the last cannot be larger. Sproutboat permits parts smaller than
Cloudflare R2's 5 MiB minimum so the default 1 MiB request-body limit remains
useful. Keep each part below the configured request-body limit.

Each part is persisted independently. Standalone completion copies parts into
the finished object through a fixed 64 KiB native buffer, so final object size
does not determine peak Porffor heap use. A single `put()` still buffers its
whole value; use multipart for larger objects. Call `abort()` to remove an
unfinished upload and its parts.

Completed objects use immutable, etag-addressed blob generations. The metadata
row switches to a fully written generation before the previous file is
removed. If a metadata update fails, readers continue seeing the previous
generation with its matching size and etag.

Unfinished uploads expire after seven days. The broker removes expired parts
when another multipart upload starts; a standalone binary removes them when it
initializes its embedded store.
