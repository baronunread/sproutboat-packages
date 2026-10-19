/**
 * The single pinned Porffor identity for the whole platform — the CLI and the
 * monorepo both read it from here. Porffor's npm package ships only a prebuilt
 * native binary (no compiler source), and sproutboat needs patchable source
 * (see `patch.ts`), so `ensurePorffor` fetches the commit's git-archive tarball
 * instead and verifies it against `PORFFOR_ARCHIVE_SHA256`.
 *
 * To move the pin: bump all four constants below (the sha is
 * `shasum -a 256` of the archive at `PORFFOR_ARCHIVE_URL`), check whether the
 * new `compiler/uwebsockets.js` changed `UWS_COMMIT` — if so re-vendor the
 * uWebSockets archive in `sproutboat-cli/vendor/` — then run both repos'
 * test + conformance suites. See sproutboat-cli/MIGRATION.md.
 */
export const PORFFOR_CHANNEL = "alpha-18";
export const PORFFOR_COMMIT_FULL = "deda4945a526d3974ff79e499e8c1dcef0873f3a";
export const PORFFOR_COMMIT = PORFFOR_COMMIT_FULL.slice(0, 7);
export const PORFFOR_ARCHIVE_SHA256 =
  "4626ffba0d5bd417ba2c5b96506d40a152dbbeeaa8a698c904054bdef6bc6e64";
export const PORFFOR_ARCHIVE_URL = `https://codeload.github.com/CanadaHonk/porffor/tar.gz/${PORFFOR_COMMIT_FULL}`;

/** A compact identity string for a manifest / report (`alpha-17 (731f1b2)`). */
export function porfforVersion(): string {
  return process.env.PORFFOR_VERSION || `${PORFFOR_CHANNEL} (${PORFFOR_COMMIT})`;
}
