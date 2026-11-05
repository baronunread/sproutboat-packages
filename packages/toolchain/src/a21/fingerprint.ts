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
export const A21_RELEASED_FINGERPRINT = "abece69f0a3d";

export const A21_PATCH_FINGERPRINT = a21SourceFingerprint(import.meta.dir) ?? A21_RELEASED_FINGERPRINT;
