---
"@sproutboat/runtime": patch
---

Outbound `fetch()` sends the port in `Host` when it isn't the scheme's default (`Host: api.example.com:8080`), as HTTP/1.1 requires. A sandboxed host can now open outbound connections on a sprout's behalf: with `SB_EGRESS_FD` set, `fetch()` asks that socket for a connected socket instead of resolving and connecting itself.
