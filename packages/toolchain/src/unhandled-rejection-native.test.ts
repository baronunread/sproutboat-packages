import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ensurePorffor } from "./acquire";

// An unhandled rejection used to throw out of Porffor's promise job loop and end the process
// ("Uncaught Error: ..." and exit 1). With the prelude's hook installed it is reported and the
// program carries on, as on Workers. Without a hook, plain Porffor keeps its throw.
async function run(source: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const workdir = await mkdtemp(resolve(tmpdir(), "sb-unhandled-"));
  try {
    const porffor = await ensurePorffor();
    const file = resolve(workdir, "app.js");
    const binary = resolve(workdir, "app");
    await writeFile(file, source);
    const compile = Bun.spawn(
      ["bun", resolve(porffor, "runtime/index.js"), "native", file, "-o", binary, "-O0", "-s"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, out, err] = await Promise.all([
      compile.exited,
      new Response(compile.stdout).text(),
      new Response(compile.stderr).text(),
    ]);
    expect(code, err + out).toBe(0);
    const ran = Bun.spawnSync([binary], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    return {
      code: ran.exitCode ?? -1,
      stdout: Buffer.from(ran.stdout).toString(),
      stderr: Buffer.from(ran.stderr).toString(),
    };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

test("with the prelude hook, an unhandled rejection is reported and the program continues", async () => {
  const result = await run(`
    globalThis.__sbOnUnhandledRejection = function (reason, promise) {
      console.log("reported " + reason.message);
    };
    Promise.reject(new Error("boom"));
    new Promise(function (resolve, reject) { reject(new Error("second")); });
    const late = Promise.reject(new Error("handled later"));
    late.catch(function () { console.log("caught"); });
    Promise.resolve().then(function () { console.log("still running"); });
  `);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("reported boom");
  expect(result.stdout).toContain("reported second");
  expect(result.stdout).toContain("still running");
  expect(result.stdout).not.toContain("reported handled later");
}, 180_000);

test("without a hook, an unhandled rejection still ends the program", async () => {
  const result = await run(`
    Promise.reject(new Error("boom"));
    Promise.resolve().then(function () { console.log("unreachable"); });
  `);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("Uncaught");
}, 180_000);
