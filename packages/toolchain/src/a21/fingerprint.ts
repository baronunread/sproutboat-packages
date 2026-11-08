import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every module that shapes the alpha 21 patched compiler: this directory's, plus the alpha 19
 * modules the chain reuses (`patchReplaceAll`, `patchRepeatDoubling`, `patchCaseMapping` from
 * `../patch.ts`; `patchRegexReplace` from `../strings.ts`; the case tables). Separate from
 * `../fingerprint.ts` on purpose: an edit here must not invalidate every machine's alpha 19 cache.
 */
export const A21_PATCH_SOURCES = ["patch.ts", "pin.ts", "../patch.ts", "../strings.ts", "../case-map.ts"] as const;

/** The fingerprint of the sources in dir, or null where they are not on disk. */
export function a21SourceFingerprint(dir: string): string | null {
  const hash = createHash("sha256");
  try {
    for (const name of A21_PATCH_SOURCES) hash.update(`${name}\0${readFileSync(join(dir, name), "utf8")}\0`);
  } catch {
    return null;
  }
  return hash.digest("hex").slice(0, 12);
}

/** As released; kept current by a21/patch.test.ts (UPDATE_FINGERPRINT=1). */
export const A21_RELEASED_FINGERPRINT = "dcb7c7d2a59d";

export const A21_PATCH_FINGERPRINT = a21SourceFingerprint(import.meta.dir) ?? A21_RELEASED_FINGERPRINT;

/**
 * Every source that shapes a standalone binary on this channel beyond the compiler: the composition,
 * the shim pass, the build recipe, the bridge and the two JS shims. A build cache keyed on it (the
 * CLI's compile cache) rebuilds when one of them changes, as it does for the alpha 19 patch chain.
 */
export const A21_STANDALONE_SOURCES = [
  "standalone.ts",
  "standalone-shim.ts",
  "standalone-build.ts",
  "native-fetch-a22.c",
  "standalone-dispatch.js",
  "standalone-preamble.js",
] as const;

export function a21StandaloneFingerprint(dir: string): string | null {
  const hash = createHash("sha256");
  try {
    for (const name of A21_STANDALONE_SOURCES) hash.update(`${name}\0${readFileSync(join(dir, name), "utf8")}\0`);
  } catch {
    return null;
  }
  return hash.digest("hex").slice(0, 12);
}

/** The patched tree plus the standalone sources: what a standalone binary on this channel depends on. */
export const A21_STANDALONE_FINGERPRINT = `${A21_PATCH_FINGERPRINT}-${a21StandaloneFingerprint(import.meta.dir) ?? "released"}`;
