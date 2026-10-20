---
"@sproutboat/runtime": patch
---

Scheduled, queue and Durable Object alarm triggers answer `204` with no body again. The prelude built that reply as `new Response("", { status: 204 })`, which the Fetch-spec `Response` of 0.17.0 rejects (an empty string is still a body), so the first cron or alarm failed, and on the alarm path the error took the server down.
