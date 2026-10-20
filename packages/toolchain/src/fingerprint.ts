import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Every module that shapes the patched compiler. fingerprint.test.ts fails when one is missing. */
export const PATCH_SOURCES = [
  "case-map.ts",
  "fetch-classes.ts",
  "headers-class.ts",
  "patch.ts",
  "pin.ts",
  "streaming.ts",
  "text-decoder.ts",
  "unicode.ts",
  "url-class.ts",
] as const;

/**
 * The fingerprint of the sources as released. A compiled CLI (`bun build --compile`) has
 * no source files to hash, and cannot embed them either: Bun bundles a text import of
 * patch.ts as the module patch.ts is everywhere else. Kept current by fingerprint.test.ts
 * (UPDATE_FINGERPRINT=1 bun test packages/toolchain/src/fingerprint.test.ts).
 */
export const RELEASED_FINGERPRINT = "405c8f04fb7d";

/** The fingerprint of the sources in dir, or null where they are not on disk. */
export function sourceFingerprint(dir: string): string | null {
  const hash = createHash("sha256");
  try {
    for (const name of PATCH_SOURCES) hash.update(`${name}\0${readFileSync(join(dir, name), "utf8")}\0`);
  } catch {
    return null;
  }
  return hash.digest("hex").slice(0, 12);
}

/**
 * Identifies the patch chain, not just the toolchain release. A cache entry is keyed by it, so
 * an edited patch gets a fresh, fully patched compiler instead of one a same-version build
 * already marked complete (B19: the prelude began calling sb_stream_*, which only the new
 * chain defines, and every build against an older entry failed to link). From the sources
 * when they are on disk, so an unreleased edit counts at once; else as released.
 */
export const PATCH_FINGERPRINT = sourceFingerprint(import.meta.dir) ?? RELEASED_FINGERPRINT;
