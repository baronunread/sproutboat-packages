import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STREAM_REGISTRY, STREAM_STUBS } from "./streaming";

// Mach-O will not link an undefined weak reference (no -U), so a macOS standalone build failed when the prelude
// declared sb_stream_pending and sb_stream_wait `weak` and nothing in the standalone server defined them.
// Every sb_stream_* function the prelude calls must be defined by the standalone server's registry (or be a weak
// definition in the stubs): defined, not merely declared weak.
test("every sb_stream_* extern of the prelude is defined for a standalone link", () => {
  const prelude = readFileSync(join(import.meta.dir, "../../runtime/src/native-fetch-prelude.js"), "utf8");
  const declared = new Set([...prelude.matchAll(/extern\s+[^;(]*?\b(sb_stream_\w+)\s*\(/g)].map((m) => m[1]!));
  expect(declared.size).toBeGreaterThan(0);
  for (const name of declared) {
    const defined =
      new RegExp(`extern "C"[^;{]*\\b${name}\\s*\\([^)]*\\)\\s*\\{`).test(STREAM_REGISTRY) ||
      new RegExp(`__attribute__\\(\\(weak\\)\\)[^;{]*\\b${name}\\s*\\([^)]*\\)\\s*\\{`).test(STREAM_STUBS);
    expect(defined, `${name} has no definition in the standalone shim`).toBe(true);
  }
});
