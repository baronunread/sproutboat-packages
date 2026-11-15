/**
 * The Porffor alpha 21 line's pin: a second channel beside `../pin.ts` (alpha 19, which stays for the
 * CLI's `--with-restore` build and as the source of the uWebSockets shim and the web classes the
 * standalone build composes). The toolchain supports ONE alpha at a time on this line: `CURRENT_ALPHA`.
 *
 * What the pin names is the patched tree. `vendor/porffor-patched.tar.gz` is upstream's `commit` with the
 * series in `porffor-patches/` applied (`scripts/porffor-patches.ts`), and `vendor/porffor-patched.json`
 * records the upstream commit, the series hash and the tarball's sha256. Nothing is patched on the
 * user's machine: `acquire.ts` verifies the tarball against that sha256 and unpacks it.
 *
 * To move to a new alpha: "Upgrading to a new alpha" in PATCHES.md. This file then needs only
 * `CURRENT_ALPHA` and the npm version in the manifest.
 */
import manifest from "../../vendor/porffor-patched.json" with { type: "json" };

/** The one supported alpha. A test checks it against the manifest. */
export const CURRENT_ALPHA = "alpha-24";

export type PorfforA21Channel = typeof CURRENT_ALPHA;

export interface PorfforA21Pin {
  readonly channel: PorfforA21Channel;
  /** The upstream commit the series is applied to. */
  readonly commitFull: string;
  readonly commit: string;
  /** sha256 of the vendored PATCHED tarball (not of upstream's archive). */
  readonly archiveSha256: string;
  /** sha256 over the patch series, in order (`seriesSha256` in scripts/porffor-patches.ts). */
  readonly seriesSha256: string;
  /** The npm `porffor` version with this gitHead. */
  readonly npmVersion: string;
  /** The tarball vendored beside this package (`vendor/porffor-patched.tar.gz`). */
  readonly vendoredArchive: string;
}

const commitFull = manifest.upstream.commit;

export const PORFFOR_A21_PINS = {
  [CURRENT_ALPHA]: {
    channel: CURRENT_ALPHA,
    commitFull,
    commit: commitFull.slice(0, 7),
    archiveSha256: manifest.tarball.sha256,
    seriesSha256: manifest.series.sha256,
    npmVersion: manifest.upstream.npmVersion,
    vendoredArchive: manifest.tarball.file,
  },
} as const satisfies Readonly<Record<PorfforA21Channel, PorfforA21Pin>>;

export const PORFFOR_A24_CHANNEL = PORFFOR_A21_PINS["alpha-24"].channel;
export const PORFFOR_A24_COMMIT_FULL = PORFFOR_A21_PINS["alpha-24"].commitFull;
export const PORFFOR_A24_COMMIT = PORFFOR_A21_PINS["alpha-24"].commit;
/** sha256 of the vendored patched tarball. */
export const PORFFOR_A24_ARCHIVE_SHA256 = PORFFOR_A21_PINS["alpha-24"].archiveSha256;
export const PORFFOR_A24_SERIES_SHA256 = PORFFOR_A21_PINS["alpha-24"].seriesSha256;
export const PORFFOR_A24_NPM_VERSION = PORFFOR_A21_PINS["alpha-24"].npmVersion;

/** A compact identity string for a manifest / report (`alpha-24 (1b8225e)`). */
export function porfforA21Version(channel: PorfforA21Channel = CURRENT_ALPHA): string {
  const p = PORFFOR_A21_PINS[channel];
  return `${p.channel} (${p.commit})`;
}
