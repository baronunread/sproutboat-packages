import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ensurePorffor } from "./acquire";

// sproutd B16: the doubling String.prototype.repeat matches Bun on edge cases and
// repeats 600 KB in well under a millisecond instead of ~2.4 ms per call.
const source = `const cases = [["ab", 0], ["ab", 1], ["ab", 2], ["ab", 3], ["abc", 7], ["x", 1000], ["é", 5], ["😀", 3], ["", 5], ["héllo", 33]];
const out = cases.map(([s, n]) => { const r = s.repeat(n); return [r.length, r.slice(0, 12), r.slice(-6)]; });
const t = performance.now(); let n = 0; for (let i = 0; i < 50; i++) n += "ab".repeat(300000).length + "é".repeat(200000).length;
console.log(JSON.stringify({ out, n }));
console.log(Math.round(performance.now() - t));`;

test("B16: String.prototype.repeat matches Bun and is linear in copies, not repetitions", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "sb-repeat-"));
  try {
    const porffor = await ensurePorffor();
    const input = resolve(dir, "case.js"),
      binary = resolve(dir, "case");
    await writeFile(input, source);
    const compile = Bun.spawnSync(
      ["bun", resolve(porffor, "runtime/index.js"), "native", input, "-o", binary, "-s", "-O0"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(compile.exitCode, new TextDecoder().decode(compile.stderr)).toBe(0);
    const run = Bun.spawnSync([binary], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
    const reference = Bun.spawnSync(["bun", input], { stdout: "pipe" });
    const lines = (bytes: Uint8Array) =>
      new TextDecoder().decode(bytes).replaceAll("\x1b[33m", "").replaceAll("\x1b[0m", "").trim().split("\n");
    const [got, ms] = lines(run.stdout);
    expect(JSON.parse(got)).toEqual(JSON.parse(lines(reference.stdout)[0]));
    // Per-repetition copying took ~180 ms here at -O0; doubling takes a few.
    expect(Number(ms)).toBeLessThan(60);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
