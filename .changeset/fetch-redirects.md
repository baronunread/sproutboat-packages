---
"@sproutboat/runtime": minor
---

From compatibility date `2026-10-22`, `fetch()` and service bindings follow redirects as Fetch does:

- Under `redirect: "follow"`, the default, the request goes again to the new location, up to 20 times. Each outbound hop is checked against the egress rules like the first.
- A 303 turns the request into a GET with no body, and so does a 301 or 302 that answers a POST.
- A hop to another origin drops `Authorization`.
- A service binding follows through the same binding, as in workerd.
- `redirect: "error"` rejects with a `TypeError`.
- `redirect: "manual"` returns the 3xx as it is.

Before this date, a 3xx came back to the handler whatever the mode, and still does for apps with an earlier `compatibility_date`.

A response from `fetch()` or a service binding that has no `Content-Type` no longer gains `text/plain;charset=UTF-8`.
