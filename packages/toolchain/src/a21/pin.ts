/**
 * The Porffor pin. The toolchain supports ONE alpha at a time: `CURRENT_ALPHA`. (The standalone server's own
 * sources, the uWebSockets shim and the web classes, are vendored in `standalone-server/`, not taken from a tree.)
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
export const CURRENT_ALPHA = "alpha-25";

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

export const PORFFOR_A25_CHANNEL = PORFFOR_A21_PINS["alpha-25"].channel;
export const PORFFOR_A25_COMMIT_FULL = PORFFOR_A21_PINS["alpha-25"].commitFull;
export const PORFFOR_A25_COMMIT = PORFFOR_A21_PINS["alpha-25"].commit;
/** sha256 of the vendored patched tarball. */
export const PORFFOR_A25_ARCHIVE_SHA256 = PORFFOR_A21_PINS["alpha-25"].archiveSha256;
export const PORFFOR_A25_SERIES_SHA256 = PORFFOR_A21_PINS["alpha-25"].seriesSha256;
export const PORFFOR_A25_NPM_VERSION = PORFFOR_A21_PINS["alpha-25"].npmVersion;

/** A compact identity string for a manifest / report (`alpha-25 (c9af40c)`). */
export function porfforA21Version(channel: PorfforA21Channel = CURRENT_ALPHA): string {
  const p = PORFFOR_A21_PINS[channel];
  return `${p.channel} (${p.commit})`;
}
