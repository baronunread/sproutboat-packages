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
export const PORFFOR_CHANNEL = "alpha-15";
export const PORFFOR_COMMIT_FULL = "72d048d73d49e217631ac8a1bc4fa9070d22fbc9";
export const PORFFOR_COMMIT = PORFFOR_COMMIT_FULL.slice(0, 7);
export const PORFFOR_ARCHIVE_SHA256 =
  "1e12be943b29691ad84bb25baecffa810655dcf7d9a490b8399352509da7a1d5";
export const PORFFOR_ARCHIVE_URL = `https://codeload.github.com/CanadaHonk/porffor/tar.gz/${PORFFOR_COMMIT_FULL}`;

/** A compact identity string for a manifest / report (`alpha-15 (72d048d)`). */
export function porfforVersion(): string {
  return process.env.PORFFOR_VERSION || `${PORFFOR_CHANNEL} (${PORFFOR_COMMIT})`;
}
