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
export const PORFFOR_CHANNEL = "alpha-5";
export const PORFFOR_COMMIT_FULL = "1f4ae4ae3e0a5f0a93b3bc084359e1a3a23391fd";
export const PORFFOR_COMMIT = PORFFOR_COMMIT_FULL.slice(0, 7);
export const PORFFOR_ARCHIVE_SHA256 = "a49a0e857574e93cb09c574dcf53b7cc049d3cb65c5b944b169755cad2a51d5d";
export const PORFFOR_ARCHIVE_URL = `https://codeload.github.com/CanadaHonk/porffor/tar.gz/${PORFFOR_COMMIT_FULL}`;

/** A compact identity string for a manifest / report (`alpha-5 (1f4ae4a)`). */
export function porfforVersion(): string {
  return process.env.PORFFOR_VERSION || `${PORFFOR_CHANNEL} (${PORFFOR_COMMIT})`;
}
