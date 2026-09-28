# Porffor alpha-10 upgrade audit

The source pin moves from alpha-9 (`de4eb58`) to the [alpha-10 release](https://github.com/CanadaHonk/porffor/releases/tag/alpha-10), commit `08ac7ee1077c05da2bec18dcca15197051e87b62`, published September 27, 2026. The vendored codeload archive has SHA-256 `d49ce6724efde555b4cdeea0d2610baddd4310153956c79b352d86ba9cf0f60f`.

Alpha-10 changes coroutine and `finally` handling, fixes object handling for `null`, replaces array storage with C reuse, and removes threads. Its `compiler/uwebsockets.js` still pins `360c276d609d59af56ae6932adb95154ace9f15f`, so the CLI's vendored uWebSockets archive does not change. The existing Sproutboat patch set applies without changing its anchors or markers.

The native package suite passed 152 tests. The CLI passed 103 tests, 28 broker checks, 30 standalone checks, all 17 default examples, and the five focused Worker/handler fixtures when linked to the local runtime and toolchain. The platform's 32-handler comparison compiled all 32 and matched Bun on 30, unchanged from alpha-9. The remaining two failures are non-ISO date parsing in `15-date-iso.js` and `16-date-parts.js`. See [the scorecard](PORFFOR_SCORECARD.md) for the exact results and patch inventory.

The source upgrade is ready for a toolchain package release. Existing CLI and platform lockfiles still resolve the published alpha-9 toolchain until that package is released and dependencies are refreshed.
