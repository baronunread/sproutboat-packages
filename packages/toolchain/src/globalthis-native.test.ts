import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ensurePorffor } from "./acquire";

// Porffor's globalThis getter re-synced every top-level function and var into the global
// object on every access, so a read cost one hashed write per binding. Bindings are now written when
// the object is built and rewritten on a read only if their value changed.
async function run(source: string): Promise<string> {
  const workdir = await mkdtemp(resolve(tmpdir(), "sb-globalthis-"));
  try {
    const porffor = await ensurePorffor();
    const file = resolve(workdir, "app.js");
    const binary = resolve(workdir, "app");
    await writeFile(file, source);
    const compile = Bun.spawn(
      ["bun", resolve(porffor, "runtime/index.js"), "native", file, "-o", binary, "-O0", "-s"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, out, err] = await Promise.all([
      compile.exited,
      new Response(compile.stdout).text(),
      new Response(compile.stderr).text(),
    ]);
    expect(code, err + out).toBe(0);
    const ran = Bun.spawnSync([binary], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    expect(ran.exitCode, Buffer.from(ran.stderr).toString()).toBe(0);
    return Buffer.from(ran.stdout).toString();
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

const functions = (n: number) => Array.from({ length: n }, (_, i) => `function f${i}() { return ${i}; }`).join("\n");

test("globalThis shows function bindings and follows var bindings, however often it is read", async () => {
  const out = await run(`
    ${functions(40)}
    var counter = 1;
    globalThis.marker = "m";
    console.log(typeof globalThis.f7, globalThis.f7(), globalThis.f39());
    console.log(globalThis.counter, globalThis.marker);
    counter = 5;
    console.log(globalThis.counter);
    const g = globalThis;
    counter = 9;
    console.log(globalThis.counter, g.counter);
    globalThis.added = 3;
    console.log(globalThis.added, "added" in globalThis, "f0" in globalThis);
  `);
  expect(out.trim().split("\n")).toEqual(["function 7 39", "1 m", "5", "9 9", "3 true true"]);
});

test("reading globalThis does not rewrite every top-level function", async () => {
  const out = await run(`
    ${functions(600)}
    globalThis.marker = 1;
    let sum = 0;
    const start = Date.now();
    for (let i = 0; i < 20000; i++) sum += globalThis.marker;
    console.log(sum, Date.now() - start);
  `);
  expect(out.startsWith("20000 ")).toBe(true);
  // 600 functions took 9,300 ms for these 20,000 reads before the patch (one hashed write per
  // function per read) and take a few ms after it, at -O0.
  expect(Number(out.trim().split(" ")[1])).toBeLessThan(1000);
}, 120_000);
