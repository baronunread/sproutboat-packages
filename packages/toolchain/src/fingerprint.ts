import { createHash } from "node:crypto";
// The patch chain's own source text, embedded by Bun's text loader (it survives
// `bun build --compile`, where these files do not exist on disk). TypeScript sees
// a module, not a string, hence the expect-errors.
// @ts-expect-error text import
import caseMap from "./case-map.ts" with { type: "text" };
// @ts-expect-error text import
import fetchClasses from "./fetch-classes.ts" with { type: "text" };
// @ts-expect-error text import
import headersClass from "./headers-class.ts" with { type: "text" };
// @ts-expect-error text import
import patch from "./patch.ts" with { type: "text" };
// @ts-expect-error text import
import pin from "./pin.ts" with { type: "text" };
// @ts-expect-error text import
import streaming from "./streaming.ts" with { type: "text" };
// @ts-expect-error text import
import textDecoder from "./text-decoder.ts" with { type: "text" };
// @ts-expect-error text import
import unicode from "./unicode.ts" with { type: "text" };
// @ts-expect-error text import
import urlClass from "./url-class.ts" with { type: "text" };

/** Every module that shapes the patched compiler. fingerprint.test.ts fails when one is missing. */
export const PATCH_SOURCES = {
  "case-map.ts": caseMap,
  "fetch-classes.ts": fetchClasses,
  "headers-class.ts": headersClass,
  "patch.ts": patch,
  "pin.ts": pin,
  "streaming.ts": streaming,
  "text-decoder.ts": textDecoder,
  "unicode.ts": unicode,
  "url-class.ts": urlClass,
} satisfies Record<string, string>;

/**
 * Identifies the patch chain, not just the toolchain release. A cache entry is keyed by it, so
 * an edited patch gets a fresh, fully patched compiler instead of one a same-version build
 * already marked complete (B19: the prelude began calling sb_stream_*, which only the new
 * chain defines, and every build against an older entry failed to link).
 */
export const PATCH_FINGERPRINT = (() => {
  const hash = createHash("sha256");
  for (const [name, source] of Object.entries(PATCH_SOURCES).sort(([a], [b]) => a.localeCompare(b)))
    hash.update(`${name}\0${source}\0`);
  return hash.digest("hex").slice(0, 12);
})();
