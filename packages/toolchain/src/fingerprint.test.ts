import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { PATCH_FINGERPRINT, PATCH_SOURCES } from "./fingerprint";

// Not part of the patched compiler: acquisition, the barrel, generators and this module.
const NOT_PATCH_SOURCES = new Set(["acquire.ts", "index.ts", "fingerprint.ts"]);

test("the patch fingerprint covers every toolchain module that shapes the compiler", async () => {
  const modules = (await readdir(import.meta.dir)).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.startsWith("gen-") && !NOT_PATCH_SOURCES.has(name),
  );
  expect(Object.keys(PATCH_SOURCES).sort()).toEqual(modules.sort());
  const embedded = new Map<string, string>(Object.entries(PATCH_SOURCES));
  for (const name of modules) expect(embedded.get(name)).toBe(await Bun.file(`${import.meta.dir}/${name}`).text());
  expect(PATCH_FINGERPRINT).toMatch(/^[0-9a-f]{12}$/);
});
