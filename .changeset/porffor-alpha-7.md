---
"@sproutboat/toolchain": patch
---

Bump the pinned Porffor commit to the `alpha-7` tag. All local patches
(render.js, uwebsockets.js) verified against the real alpha-7 source via
`ensurePorffor()` — no anchor drift, full test suite green. `UWS_COMMIT`
unchanged, no uWebSockets re-vendor needed.
