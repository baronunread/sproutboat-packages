---
"@sproutboat/runtime": patch
"@sproutboat/toolchain": patch
---

A request's fixed cost in a native sprout drops five items. The CPU stamp and the streamed-body probe come back as numbers instead of formatted and parsed text (a `printf` and a `parseFloat` each, per request). The ingress reads of `x-sb-trigger` and `x-sb-remote-addr` scan the stored header names instead of validating and lowercasing a name for each, and the three `x-sb-` names the runtime strips are looked for in one pass. `SB_EDGE_TOKEN` is read once. `Headers` checks a name and a value in C and only falls back to its regular expression for a name it cannot judge there, so `get`, `has`, `set`, `append` and `new Response(body, { headers })` stop compiling that expression on every call. Behavior is unchanged.
