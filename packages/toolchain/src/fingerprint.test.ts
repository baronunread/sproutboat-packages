import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { PATCH_FINGERPRINT, PATCH_SOURCES, RELEASED_FINGERPRINT, sourceFingerprint } from "./fingerprint";

// Not part of the patched compiler: acquisition, the barrel, generators and this module.
const NOT_PATCH_SOURCES = new Set(["acquire.ts", "index.ts", "fingerprint.ts"]);

test("the patch fingerprint covers every toolchain module that shapes the compiler", async () => {
  const modules = (await readdir(import.meta.dir)).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.startsWith("gen-") && !NOT_PATCH_SOURCES.has(name),
  );
  expect(modules.sort()).toEqual(PATCH_SOURCES.map(String).sort());
  expect(PATCH_FINGERPRINT).toMatch(/^[0-9a-f]{12}$/);
  expect(PATCH_FINGERPRINT).toBe(sourceFingerprint(import.meta.dir)!);
  expect(sourceFingerprint("/nonexistent")).toBeNull();
});

// A compiled CLI falls back to RELEASED_FINGERPRINT, so it must match the sources.
test("RELEASED_FINGERPRINT matches the sources", async () => {
  const actual = sourceFingerprint(import.meta.dir)!;
  if (process.env.UPDATE_FINGERPRINT && actual !== RELEASED_FINGERPRINT) {
    const file = `${import.meta.dir}/fingerprint.ts`;
    const text = await Bun.file(file).text();
    await Bun.write(file, text.replace(`RELEASED_FINGERPRINT = "${RELEASED_FINGERPRINT}"`, `RELEASED_FINGERPRINT = "${actual}"`));
    return;
  }
  expect(RELEASED_FINGERPRINT, "run UPDATE_FINGERPRINT=1 bun test packages/toolchain/src/fingerprint.test.ts").toBe(actual);
});
