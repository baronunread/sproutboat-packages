import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PORFFOR_A24_SERIES_SHA256 } from "./pin";

/**
 * What shapes the patched compiler is the patch series, so its fingerprint is the series hash from
 * the manifest (`vendor/porffor-patched.json`, written by `scripts/porffor-patches.ts vendor` and
 * checked against the committed patches by `patch.test.ts`).
 */
export const A21_PATCH_FINGERPRINT = PORFFOR_A24_SERIES_SHA256.slice(0, 12);

/**
 * Every source that shapes a standalone binary on this channel beyond the compiler: the composition,
 * the shim pass, the build recipe, the bridge and the two JS shims. A build cache keyed on it (the
 * CLI's compile cache) rebuilds when one of them changes.
 */
export const A21_STANDALONE_SOURCES = [
  "standalone.ts",
  "standalone-shim.ts",
  "standalone-build.ts",
  "native-fetch-a22.c",
  "standalone-dispatch.js",
  "standalone-preamble.js",
  "standalone-server/uws-shim.cpp",
  "standalone-server/web-classes.js",
  "standalone-server/uws-patches/0001-remove-default-404.patch",
  "standalone-server/uws-patches/0002-shorten-uws-errors.patch",
  "standalone-server/uws-patches/0003-http10.patch",
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
