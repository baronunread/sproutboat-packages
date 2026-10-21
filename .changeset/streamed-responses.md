---
"@sproutboat/runtime": minor
"@sproutboat/wire": minor
---

Responses to `fetch()` and service-binding calls stream. In a deployed sprout with compatibility date `2026-10-21` or later, the call resolves as soon as the status and headers arrive. `response.body` is then a `ReadableStream` that receives each chunk as the upstream sends it.

Before, the whole body had to arrive first. A response streamed over several seconds, such as server-sent events or a long download, reached the caller only at the end.

The 32 MiB `SB_FETCH_MAX_BYTES` cap still applies to the total. Cancelling the body, or aborting the call's signal, stops the upstream request.

In `@sproutboat/wire`:
- the broker streams a `fetch` or `service.fetch` that asks for it (`stream: true`), sending the head and each chunk as `FRAME_V1_MORE` frames through the new `emit` argument of `handleFrame`;
- the final frame ends the response;
- a request that doesn't ask is answered whole, as before.
