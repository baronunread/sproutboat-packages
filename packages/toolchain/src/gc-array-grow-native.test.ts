import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ensurePorffor } from "./acquire";

// Regression: an array that grew while old left its previous entries block behind, still holding
// pointers to objects that later died, and a minor collection scanned it when a neighbouring write
// dirtied its card: it marked whatever had reused those blocks as the type the stale slot claimed
// (a Promise), and read the reused array as a Promise. Unpatched, this binary dies with SIGBUS.
test("a collection does not scan the entries block an array left behind when it grew", async () => {
  const workdir = await mkdtemp(resolve(tmpdir(), "sb-array-grow-gc-"));
  try {
    const porffor = await ensurePorffor();
    const source = resolve(import.meta.dir, "../test/gc-array-grow.js.txt");
    const binary = resolve(workdir, "array-grow-gc");
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
