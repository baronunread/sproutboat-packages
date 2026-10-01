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
export const PORFFOR_CHANNEL = "alpha-13";
export const PORFFOR_COMMIT_FULL = "547c7815125b6f02474591950f8b0dd7031a03f0";
export const PORFFOR_COMMIT = PORFFOR_COMMIT_FULL.slice(0, 7);
export const PORFFOR_ARCHIVE_SHA256 =
  "d0ff4bf7778f85445ff99bb8f6b2e07f2b83a33a109612f9eba6f2e5cba291b5";
export const PORFFOR_ARCHIVE_URL = `https://codeload.github.com/CanadaHonk/porffor/tar.gz/${PORFFOR_COMMIT_FULL}`;

/** A compact identity string for a manifest / report (`alpha-13 (547c781)`). */
export function porfforVersion(): string {
  return process.env.PORFFOR_VERSION || `${PORFFOR_CHANNEL} (${PORFFOR_COMMIT})`;
}
