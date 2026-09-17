/**
 * The single pinned Porffor identity for the whole platform — the CLI and the
 * monorepo both read it from here. The `alpha-*` git tags ship no package.json,
 * so there is no npm dep to resolve; `ensurePorffor` fetches the commit tarball
 * and verifies it against `PORFFOR_ARCHIVE_SHA256`.
 *
 * To move the pin: bump all four constants below (the sha is
 * `shasum -a 256` of the archive at `PORFFOR_ARCHIVE_URL`), check whether the
 * new `compiler/uwebsockets.js` changed `UWS_COMMIT` — if so re-vendor the
 * uWebSockets archive in `sproutboat-cli/vendor/` — then run both repos'
 * test + conformance suites. See sproutboat-cli/MIGRATION.md.
 */
export const PORFFOR_CHANNEL = "alpha-7";
export const PORFFOR_COMMIT_FULL = "8f01541498d6d61c0cbbf8a71be152330888be7e";
export const PORFFOR_COMMIT = PORFFOR_COMMIT_FULL.slice(0, 7);
export const PORFFOR_ARCHIVE_SHA256 =
  "fae9cfb00c0a21e20e3aa79a9a8093bd24820062039985c6bde2b23e3e8bdb8c";
export const PORFFOR_ARCHIVE_URL = `https://codeload.github.com/CanadaHonk/porffor/tar.gz/${PORFFOR_COMMIT_FULL}`;

/** A compact identity string for a manifest / report (`alpha-7 (8f01541)`). */
export function porfforVersion(): string {
  return process.env.PORFFOR_VERSION || `${PORFFOR_CHANNEL} (${PORFFOR_COMMIT})`;
}
