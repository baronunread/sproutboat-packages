import { expect, test } from "bun:test";
import { validateManifest } from "./manifest";

const legacy = {
  schemaVersion: 2,
  project: "example",
  target: "linux-x86_64",
  runtime: "native-fetch",
  capabilityProfile: "http-sync-v0",
  porfforVersion: "alpha-7",
  esbuildVersion: "0.25",
  buildImage: "zig-musl",
  sourceHash: `sha256:${"a".repeat(64)}`,
  binaryHash: `sha256:${"b".repeat(64)}`,
  binarySize: 100,
  builtAt: "2026-09-26T00:00:00.000Z",
};

test("compile duration is optional for old artifacts and validated when present", () => {
  const old = validateManifest(legacy);
  expect(old.ok).toBe(true);
  const current = validateManifest({ ...legacy, compileMs: 0 });
  expect(current.ok).toBe(true);
  if (current.ok) expect(current.value.compileMs).toBe(0);
  const invalid = validateManifest({ ...legacy, compileMs: -1 });
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.errors).toContain("compileMs must be a non-negative integer");
});
