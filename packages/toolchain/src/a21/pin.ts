/**
 * The Porffor alpha 21 pin: a second channel beside `../pin.ts` (alpha 19, the default for the
 * CLI and every existing caller). Only sproutd's alpha 21 generation reads it, behind its
 * `--porffor=alpha-21` flag. Moving the default channel is a separate decision (see
 * sproutboat-platform/sproutd-alpha21-port.md).
 *
 * The sha is `shasum -a 256` of the codeload tarball at the FULL-commit URL: codeload roots the
 * archive after the ref in the URL, so the short-ref tarball holds the same files under another
 * root directory and has another digest.
 */
export const PORFFOR_A21_CHANNEL = "alpha-21";
export const PORFFOR_A21_COMMIT_FULL = "1f8d14845f0dee33b330013ee19ab0294499dfe2";
export const PORFFOR_A21_COMMIT = PORFFOR_A21_COMMIT_FULL.slice(0, 7);
export const PORFFOR_A21_ARCHIVE_SHA256 = "7ee2694f9316a4ff3589bc7f39bce2a58b6658aa984109dcea3707b1d72a2d8d";
export const PORFFOR_A21_ARCHIVE_URL = `https://codeload.github.com/CanadaHonk/porffor/tar.gz/${PORFFOR_A21_COMMIT_FULL}`;
/** npm `porffor@0.0.0-alpha.21` has this gitHead. */
export const PORFFOR_A21_NPM_VERSION = "0.0.0-alpha.21";

/** A compact identity string for a manifest / report (`alpha-21 (1f8d148)`). */
export function porfforA21Version(): string {
  return `${PORFFOR_A21_CHANNEL} (${PORFFOR_A21_COMMIT})`;
}
