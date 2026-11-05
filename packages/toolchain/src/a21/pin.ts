/**
 * The Porffor alpha 21 line pins: a second channel beside `../pin.ts` (alpha 19, the default for the
 * CLI and every existing caller). Only sproutd's alpha 21 and alpha 22 generations read these,
 * behind its `--porffor=alpha-21` / `--porffor=alpha-22` flag. Moving the default channel is a
 * separate decision (see sproutboat-platform/sproutd-alpha21-port.md).
 *
 * One chain (`patch.ts`) serves both pins: alpha 22 is five commits on alpha 21 (+77/-22 lines) and
 * every alpha 21 pass anchors unchanged on it; the one alpha 22 only pass (P8, shared dispatch
 * functions) is applied where its anchor exists. The pin a tree is on is read from the tree
 * (`channelOfTree`), so the alpha 21 results stay reproducible from the alpha 21 archive.
 *
 * The sha is `shasum -a 256` of the codeload tarball at the FULL-commit URL: codeload roots the
 * archive after the ref in the URL, so the short-ref tarball holds the same files under another
 * root directory and has another digest.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type PorfforA21Channel = "alpha-21" | "alpha-22";

export interface PorfforA21Pin {
  readonly channel: PorfforA21Channel;
  readonly commitFull: string;
  readonly commit: string;
  readonly archiveSha256: string;
  readonly archiveUrl: string;
  /** The npm `porffor` version with this gitHead. */
  readonly npmVersion: string;
  /** The archive vendored beside this package (`vendor/porffor-<commit>.tar.gz`). */
  readonly vendoredArchive: string;
}

function pin(channel: PorfforA21Channel, commitFull: string, archiveSha256: string, npmVersion: string): PorfforA21Pin {
  const commit = commitFull.slice(0, 7);
  return {
    channel,
    commitFull,
    commit,
    archiveSha256,
    archiveUrl: `https://codeload.github.com/CanadaHonk/porffor/tar.gz/${commitFull}`,
    npmVersion,
    vendoredArchive: `porffor-${commit}.tar.gz`,
  };
}

export const PORFFOR_A21_PINS = {
  "alpha-21": pin(
    "alpha-21",
    "1f8d14845f0dee33b330013ee19ab0294499dfe2",
    "7ee2694f9316a4ff3589bc7f39bce2a58b6658aa984109dcea3707b1d72a2d8d",
    "0.0.0-alpha.21",
  ),
  // alpha 22 (published 2026-11-05 16:40 UTC): a081ebd7 regexp cache hits, 273545d4 regex cache marked in one
  // pass, 9da42a82 precompile shebang, 135fda29 shared dispatch on unknown receivers, 12ef1a9f deduped split
  // runtime helpers. The tarball's compiler/ and runtime/ equal the git checkout at the commit (diff -rq clean).
  "alpha-22": pin(
    "alpha-22",
    "a081ebd71177b898b2859298376e3191f088af32",
    "b32ed03abcfd34766cbafe73b4765e4117f6bc36e8e6122e51696b8d52059ae2",
    "0.0.0-alpha.22",
  ),
} as const satisfies Readonly<Record<PorfforA21Channel, PorfforA21Pin>>;

/**
 * Which pin a Porffor tree is on. The tree carries no version of its own (`globalThis.version` is a
 * frozen string), so the alpha 22 codegen's shared-dispatch table, which no patch removes, tells the
 * two apart.
 */
export function channelOfTree(root: string): PorfforA21Channel {
  const codegen = readFileSync(resolve(root, "compiler/codegen.js"), "utf8");
  return codegen.includes("\nlet sharedFuncs;\n") ? "alpha-22" : "alpha-21";
}

export function pinOfTree(root: string): PorfforA21Pin {
  return PORFFOR_A21_PINS[channelOfTree(root)];
}

// The alpha 21 pin by name, as the first callers (sproutd's build/deps.ts) read it.
export const PORFFOR_A21_CHANNEL = PORFFOR_A21_PINS["alpha-21"].channel;
export const PORFFOR_A21_COMMIT_FULL = PORFFOR_A21_PINS["alpha-21"].commitFull;
export const PORFFOR_A21_COMMIT = PORFFOR_A21_PINS["alpha-21"].commit;
export const PORFFOR_A21_ARCHIVE_SHA256 = PORFFOR_A21_PINS["alpha-21"].archiveSha256;
export const PORFFOR_A21_ARCHIVE_URL = PORFFOR_A21_PINS["alpha-21"].archiveUrl;
export const PORFFOR_A21_NPM_VERSION = PORFFOR_A21_PINS["alpha-21"].npmVersion;
export const PORFFOR_A22_CHANNEL = PORFFOR_A21_PINS["alpha-22"].channel;
export const PORFFOR_A22_COMMIT_FULL = PORFFOR_A21_PINS["alpha-22"].commitFull;
export const PORFFOR_A22_COMMIT = PORFFOR_A21_PINS["alpha-22"].commit;
export const PORFFOR_A22_ARCHIVE_SHA256 = PORFFOR_A21_PINS["alpha-22"].archiveSha256;
export const PORFFOR_A22_ARCHIVE_URL = PORFFOR_A21_PINS["alpha-22"].archiveUrl;
export const PORFFOR_A22_NPM_VERSION = PORFFOR_A21_PINS["alpha-22"].npmVersion;

/** A compact identity string for a manifest / report (`alpha-21 (1f8d148)`). */
export function porfforA21Version(channel: PorfforA21Channel = "alpha-21"): string {
  const p = PORFFOR_A21_PINS[channel];
  return `${p.channel} (${p.commit})`;
}
