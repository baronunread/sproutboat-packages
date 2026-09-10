/**
 * `@sproutboat/toolchain` — the one place the Porffor pin and the source
 * patches live. Both `sproutboat-cli` and the `sproutboat` monorepo depend on
 * this so they cannot drift apart (which is exactly what happened before).
 *
 * - `pin` — the pinned commit + archive hash, and `porfforVersion()`.
 * - `patch` — `ensurePorfforPatched(root)` and the individual patch passes.
 * - `acquire` — `ensurePorffor()`: fetch, verify, extract, patch, cache.
 */
export * from "./pin";
export * from "./patch";
export * from "./acquire";
