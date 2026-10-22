---
"@sproutboat/runtime": minor
"@sproutboat/toolchain": minor
---

`fetch(Request)`, `fetch(Request, init)` and `new Request(request, init)` behave as in workerd from compatibility date `2026-10-23`. This covers outgoing `fetch()`, service-binding `fetch()` and Durable Object stubs, on the broker and embedded transports alike. Every behaviour was checked against workerd 2026-09-27 by the platform's service-binding suite.

From `2026-10-23`:

- `fetch(input, init)` is `fetch(new Request(input, init))`, as the Fetch spec says. The Request's method, headers, body, redirect mode and signal apply unless `init` replaces them, and `init.headers` replaces all of the Request's headers.
- A Request given as `init` brings its method, headers and body.
- A body can be used once. `fetch(request)`, `new Request(request)` and reading it through `request.body` all use it, after which `bodyUsed` is true. Sending or copying a used Request throws `TypeError: Cannot reconstruct a Request with a used body.`, and reading it again throws workerd's "Body has already been used..." message. With a body in `init`, the source Request is left alone.
- A GET or HEAD Request with any body throws, even `""` or one inherited from another Request. An incoming GET or HEAD has `request.body === null`.
- Methods are workerd's: known names in any case are uppercased, and anything else throws `Invalid HTTP method string`. That includes `CONNECT` and custom names.
- `redirect` must be `"follow"` or `"manual"`. As in workerd, `"error"` throws when the Request is made.
- The headers of an incoming request, a fetched or service-binding response, and `Response.redirect()` are immutable: `set`, `append` and `delete` throw `TypeError: Can't modify immutable headers.` Copies are mutable, so `new Request(request)`, `new Response(body, response)` and `new Headers(h)` can still be changed.
- `AbortSignal.abort()`'s default reason reads "The operation was aborted", as in workerd.

With an earlier `compatibility_date` these keep their old behaviour: a copy shares the body, any method name and redirect mode passes, and headers stay mutable. To get the new behaviour, move `compatibility_date` to `2026-10-23` and rebuild.

These are fixed at every date, since no app can depend on the old behaviour:

- `Request.signal` exists. A Request made with `signal` passes it on to copies and to `fetch()`, which aborts with it.
- A `ReadableStream` body in an outgoing `fetch()` is sent as its bytes. Before, it went out as the text `[object ReadableStream]`.
- `request.clone()` and `response.clone()` tee a stream body, so both copies can read it. Before, the second reader failed.
- A copy of an incoming request keeps its raw bytes. Its `text()` decodes UTF-8, and `fetch()` sends the bytes unchanged.
