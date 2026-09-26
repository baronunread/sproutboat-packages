import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ensurePorffor } from "./acquire";

test("native ISO dates honor signed offsets, zero fields, and fractional seconds", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "sb-date-native-"));
  const samples = [
    "2024-01-02T03:04:05Z",
    "2024-01-02T03:04:05+02:00",
    "2024-01-02T03:04:05-05:00",
    "2024-01-02T03:04:05.250+01:00",
    "2024-01-02T00:00:00Z",
    "2024-01-02T03:04:05.2+02:30",
    "2024-01-02T03:04:05.25-00:30",
  ];
  try {
    const porffor = await ensurePorffor({ cacheRoot: resolve(root, "cache") });
    const source = resolve(root, "date.js");
    const binary = resolve(root, "date-native");
    await writeFile(source, `for (const value of ${JSON.stringify(samples)}) console.log(new Date(value).toISOString());\n`);
    const compile = Bun.spawnSync(["bun", resolve(porffor, "runtime/index.js"), "native", source, "-o", binary, "-s"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(compile.exitCode, Buffer.from(compile.stderr).toString()).toBe(0);
    const run = Bun.spawnSync([binary], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode, Buffer.from(run.stderr).toString()).toBe(0);
    expect(Buffer.from(run.stdout).toString().trim().split("\n")).toEqual(
      samples.map((value) => new Date(value).toISOString()),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
