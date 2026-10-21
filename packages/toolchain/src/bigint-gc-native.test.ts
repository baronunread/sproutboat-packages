import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ensurePorffor } from "./acquire";

test("conservative roots retain encoded heap BigInts on the stack and in untyped blocks", async () => {
  const workdir = await mkdtemp(resolve(tmpdir(), "sb-bigint-gc-"));
  try {
    const porffor = await ensurePorffor();
    const source = resolve(import.meta.dir, "../test/gc-bigint.js.txt");
    const binary = resolve(workdir, "bigint-gc");
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
    const run = Bun.spawnSync([binary], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    expect(run.exitCode, Buffer.from(run.stderr).toString()).toBe(0);
    const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
    expect(Buffer.from(run.stdout).toString().replace(ansi, "").trim()).toBe("3");
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}, 120_000);
