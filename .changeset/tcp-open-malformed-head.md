---
"@sproutboat/wire": patch
---

The `connect()` tunnel no longer throws on an opening frame it cannot parse. A `tcp.open` head whose JSON was malformed used to raise out of the egress service's (and the broker's) socket handler before the token was checked, which ended the egress process for every app. The egress service now answers it with an `expected tcp.open` error frame and closes only that connection, like any other first frame that is not a `tcp.open`; the broker answers it as a bad request. A refused head also stops buffering whatever the client keeps sending.
