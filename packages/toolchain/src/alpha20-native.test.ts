import { expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ensurePorffor } from "./acquire";

// Every program in test/probes is a case the toolchain used to patch (or a repro for one) on
// Porffor alpha 19. Each now compiles on the toolchain's alpha 20 and prints what Bun prints, so
// the patch was dropped; a failure here is a reason to bring one back. Lines are compared as sets:
// the order microtasks and timers interleave in is not what these probes are about.
const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const lines = (bytes: Uint8Array) => new TextDecoder().decode(bytes).replace(ansi, "").trim().split("\n").sort();

// Bun leaves the content type of a string-bodied Response out of headers; workerd (and Porffor) type it.
const WORKERD_ONLY = "ct text/plain;charset=UTF-8";

const probes = [
  "typedarray-shadow",
  "call-arg-order",
  "macro-names",
  "promise-null",
  "local-function-types",
  "zero-delay-timers",
  "unhandled-rejection",
  "async-context",
  "groupby-private",
  "fp-contract",
  "unicode-strings",
  "unicode-json",
  "web-classes",
  "bigint-gc",
  "many-functions",
];

for (const name of probes) {
  test(`alpha 20 needs no patch for ${name}`, async () => {
    const dir = await mkdtemp(resolve(tmpdir(), `sb-probe-${name}-`));
    try {
      const porffor = await ensurePorffor();
      const input = resolve(dir, `${name}.js`);
      const binary = resolve(dir, name);
      await copyFile(resolve(import.meta.dir, `../test/probes/${name}.js.txt`), input);
      const compile = Bun.spawnSync(
        ["bun", resolve(porffor, "runtime/index.js"), "native", input, "-o", binary, "-s"],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(compile.exitCode, new TextDecoder().decode(compile.stderr)).toBe(0);
      const run = Bun.spawnSync([binary], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
      expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
      const reference = Bun.spawnSync(["bun", input], { stdout: "pipe", stderr: "pipe" });
      const want = lines(reference.stdout);
      const got = lines(run.stdout);
      if (name === "web-classes") expect(got).toContain(WORKERD_ONLY);
      expect(got.filter((line) => line !== WORKERD_ONLY)).toEqual(want.filter((line) => !line.startsWith("ct ")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
}
