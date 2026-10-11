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
export const PORFFOR_CHANNEL = "alpha-17";
export const PORFFOR_COMMIT_FULL = "731f1b2a150d441ed22da3d14f8b1e0daaae8ee4";
export const PORFFOR_COMMIT = PORFFOR_COMMIT_FULL.slice(0, 7);
export const PORFFOR_ARCHIVE_SHA256 =
  "8eb65a3e77d58a23bfd2a1a60328672ad50e1ced7931f8d0ca3108e29d6cf846";
export const PORFFOR_ARCHIVE_URL = `https://codeload.github.com/CanadaHonk/porffor/tar.gz/${PORFFOR_COMMIT_FULL}`;

/** A compact identity string for a manifest / report (`alpha-17 (731f1b2)`). */
export function porfforVersion(): string {
  return process.env.PORFFOR_VERSION || `${PORFFOR_CHANNEL} (${PORFFOR_COMMIT})`;
}
