---
"@sproutboat/runtime": patch
"@sproutboat/wire": patch
---

Outbound `fetch()` and service-binding responses keep binary bodies intact (baronunread/sproutboat#232). `arrayBuffer()` and `bytes()` on a fetched response used to go through Porffor's `text()`, which the runtime overrides to decode UTF-8, so binary bodies collapsed; they now read the raw bytes. Through the broker, `fetch` and `service.fetch` sent over a v1 frame now get the upstream body as raw bytes in the frame's binary section instead of `TextDecoder` output. v0 frames, which already-deployed sprouts use, are unchanged, and a new sprout talking to an older broker falls back to the previous text behaviour.
