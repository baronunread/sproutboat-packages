---
"@sproutboat/runtime": minor
---

`HTMLRewriter`, matching Cloudflare's API and lol-html's output.

- **Handlers:** `on(selector, { element, text, comments })` and `onDocument({ doctype, text, comments, end })`.
- **Element methods:** attributes, `tagName`, `before`/`after`/`prepend`/`append`/`replace`/`setInnerContent` with `{ html }`, `remove`, `removeAndKeepContent` and `onEndTag`.
- **Selectors:** type, `*`, `#id`, `.class`, the attribute operators, descendant and child combinators, and lists.
- **Async:** handlers may be async.

It reads the whole body before rewriting rather than streaming it. 37 cases are checked against Bun's lol-html-based HTMLRewriter, including where lol-html keeps attributes byte for byte and does not imply end tags.
