import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ensurePorffor } from "./acquire";

// Regression: a static (compile-time) array that grew onto the heap kept its entries unmarked, so
// the next collection freed them while Promise's list of pending rejections still wrote to them.
// Unpatched, this binary corrupts the strings that reuse the block, or dies.
test("a collection marks the heap entries of a grown static array", async () => {
  const workdir = await mkdtemp(resolve(tmpdir(), "sb-static-array-gc-"));
  try {
    const porffor = await ensurePorffor();
    const source = resolve(import.meta.dir, "../test/gc-static-array.js.txt");
    const binary = resolve(workdir, "static-array-gc");
    const compile = Bun.spawn(
      ["bun", resolve(porffor, "runtime/index.js"), "native", source, "-o", binary, "-O0", "-s"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      compile.exited,
      new Response(compile.stdout).text(),
      new Response(compile.stderr).text(),
    ]);
    expect(code, stderr + stdout).toBe(0);
    const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
    for (let run = 0; run < 5; run++) {
      const result = Bun.spawnSync([binary], { stdout: "pipe", stderr: "pipe", timeout: 20_000 });
      expect(result.exitCode, Buffer.from(result.stderr).toString()).toBe(0);
      expect(Buffer.from(result.stdout).toString().replace(ansi, "").trim()).toBe("0");
    }
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}, 120_000);
