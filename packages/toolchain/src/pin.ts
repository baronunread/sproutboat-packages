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
export const PORFFOR_CHANNEL = "alpha-6";
export const PORFFOR_COMMIT_FULL = "038f415e08efc5f87a6bfcb05a18824caa3a14f6";
export const PORFFOR_COMMIT = PORFFOR_COMMIT_FULL.slice(0, 7);
export const PORFFOR_ARCHIVE_SHA256 =
  "61f65d8fac5f94a7910f0a3f046e8929a852addb0033a032b9f7e08d0b07df5c";
export const PORFFOR_ARCHIVE_URL = `https://codeload.github.com/CanadaHonk/porffor/tar.gz/${PORFFOR_COMMIT_FULL}`;

/** A compact identity string for a manifest / report (`alpha-6 (038f415)`). */
export function porfforVersion(): string {
  return process.env.PORFFOR_VERSION || `${PORFFOR_CHANNEL} (${PORFFOR_COMMIT})`;
}
