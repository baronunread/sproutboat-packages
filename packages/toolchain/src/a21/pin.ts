/**
 * The Porffor alpha 21 line pins: a second channel beside `../pin.ts` (alpha 19, the default for the
 * CLI and every existing caller). Sproutd's alpha 21 to alpha 24 generations read these,
 * behind its `--porffor=alpha-21` / `--porffor=alpha-22` / `--porffor=alpha-23` / `--porffor=alpha-24` flag, and standalone builds
 * default to alpha 24 (`standalone-channel.ts`; alpha 23 was the default until the alpha 24 flip). Moving the default channel is a
 * separate decision (see sproutboat-platform/sproutd-alpha21-port.md).
 *
 * One chain (`patch.ts`) serves all four pins: alpha 22 is five commits on alpha 21 (+77/-22 lines) and
 * every alpha 21 pass anchors unchanged on it; alpha 23 is eight more commits (+25/-21, none in
 * `builtins/` or `runtime/`) and every pass anchors unchanged on it too; alpha 24 is fifteen more (TypeScript lowering,
 * decorators, a new `builtins/decorator.ts`, class codegen) and every pass but P5 and P11 anchors unchanged (those two
 * moved: see `patchStableNames`, `patchClassBindingWrite`). The alpha 22 and later passes (P8,
 * shared dispatch functions; P10) are applied where their anchor exists, which is every tree but alpha 21's. The pin a tree is on is read from the tree
 * (`channelOfTree`), so the alpha 21 results stay reproducible from the alpha 21 archive.
 *
 * The sha is `shasum -a 256` of the codeload tarball at the FULL-commit URL: codeload roots the
 * archive after the ref in the URL, so the short-ref tarball holds the same files under another
 * root directory and has another digest.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type PorfforA21Channel = "alpha-21" | "alpha-22" | "alpha-23" | "alpha-24";

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
  // alpha 23 (published 2026-11-10 21:34 UTC): eight commits on alpha 22, +25/-21 lines in five compiler files:
  // ece6782f drops Math.RAD_PER_DEG/DEG_PER_RAD, 6f64fd79 strict assignments to captured bindings,
  // 22159adc export lists have no lexical names, f5eb200f require candidates skip .d.ts, f85e9473 swiftcall for
  // js functions on clang arm64 (PORF_CC), 56b08ce5 six dynamic call args in registers (was four), ea2d36c3
  // constructor returns test new.target by type, a97a0ae8 a missing pkg-config library fails with a message.
  // Nothing in compiler/builtins/ or runtime/ changed. Upstream main is this commit.
  "alpha-23": pin(
    "alpha-23",
    "a97a0ae8e296009aee482dff11b150528098a9b7",
    "c39f102df21dae9fb7ffeada8b3d90eb47256d2e8d83ebb912c2fe9a5c34fd43",
    "0.0.0-alpha.23",
  ),
  // alpha 24 (published 2026-11-14 21:38 UTC): fifteen commits on alpha 23, +~620/-~245 lines. 99bf9066 compiler: ts
  // lowering (new compiler/typescript.js: namespaces, enums and the like) and decorators (new compiler/builtins/decorator.ts,
  // `__Porffor_decorate`), c17f9def runtime tdz for top-level lexicals, cacc5536 and 15df2d2d evaluation order,
  // e92728e3 render: porf_invoke cases per signature, 07df32d3 native: -ffp-contract=off, 1b8225ea builtin instanceof
  // sees proxies, plus loop labels, string index and nul-in-number fixes. Upstream main is this commit.
  "alpha-24": pin(
    "alpha-24",
    "1b8225eafda6664dcd4f274d002603bd9797de6a",
    "0032b12fa9f096e7b05f64c80520cf20e5ab0e7ed83b70fd33095f4ca2a4d59a",
    "0.0.0-alpha.24",
  ),
} as const satisfies Readonly<Record<PorfforA21Channel, PorfforA21Pin>>;

/**
 * Which pin a Porffor tree is on. The tree carries no version of its own (`globalThis.version` is a
 * frozen string), so two lines of codegen that no patch edits tell them apart: alpha 22's shared-dispatch
 * table, and alpha 23's `isIdentAssignable` that lets an assignment to a captured binding through.
 */
export function channelOfTree(root: string): PorfforA21Channel {
  // alpha 24 added the TypeScript lowering as its own file (99bf9066); no pass creates or edits it.
  if (existsSync(resolve(root, "compiler/typescript.js"))) return "alpha-24";
  const codegen = readFileSync(resolve(root, "compiler/codegen.js"), "utf8");
  // alpha 23 lets an assignment to a captured binding through isIdentAssignable (6f64fd79); no pass touches it.
  if (
    codegen.includes(
      "const isIdentAssignable = (scope, name, op = '=') => {\n  if (!scope.strict && op === '=') return true;\n\n  if (lookupName(scope, name)[0] != null || scope.closureCaptures",
    )
  )
    return "alpha-23";
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
export const PORFFOR_A23_CHANNEL = PORFFOR_A21_PINS["alpha-23"].channel;
export const PORFFOR_A23_COMMIT_FULL = PORFFOR_A21_PINS["alpha-23"].commitFull;
export const PORFFOR_A23_COMMIT = PORFFOR_A21_PINS["alpha-23"].commit;
export const PORFFOR_A23_ARCHIVE_SHA256 = PORFFOR_A21_PINS["alpha-23"].archiveSha256;
export const PORFFOR_A23_ARCHIVE_URL = PORFFOR_A21_PINS["alpha-23"].archiveUrl;
export const PORFFOR_A23_NPM_VERSION = PORFFOR_A21_PINS["alpha-23"].npmVersion;
export const PORFFOR_A24_CHANNEL = PORFFOR_A21_PINS["alpha-24"].channel;
export const PORFFOR_A24_COMMIT_FULL = PORFFOR_A21_PINS["alpha-24"].commitFull;
export const PORFFOR_A24_COMMIT = PORFFOR_A21_PINS["alpha-24"].commit;
export const PORFFOR_A24_ARCHIVE_SHA256 = PORFFOR_A21_PINS["alpha-24"].archiveSha256;
export const PORFFOR_A24_ARCHIVE_URL = PORFFOR_A21_PINS["alpha-24"].archiveUrl;
export const PORFFOR_A24_NPM_VERSION = PORFFOR_A21_PINS["alpha-24"].npmVersion;

/** A compact identity string for a manifest / report (`alpha-21 (1f8d148)`). */
export function porfforA21Version(channel: PorfforA21Channel = "alpha-21"): string {
  const p = PORFFOR_A21_PINS[channel];
  return `${p.channel} (${p.commit})`;
}
