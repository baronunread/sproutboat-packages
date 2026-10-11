import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ensurePorffor } from "./acquire";

const values = [-2.5, -1.5, -0.5, -0.1, 0, 0.5, 1.5, 2.5];
const strings = ["", " 42 ", "0xff", "0b101", "0o17", "1.2345678901234567", "1e-7", "-0", "12junk"];
const expected = {
  rounded: values.map((value) => [Math.round(value), Object.is(Math.round(value), -0)]),
  parsed: strings.map((value) => [Number(value), Object.is(Number(value), -0)]),
  formatted: [1.2345678901234567, 1e-7, 1e21, 255].map((value) => [value.toString(), value.toString(16), value.toFixed(3)]),
  field: [1, 2],
};
const source = `const values=${JSON.stringify(values)}, strings=${JSON.stringify(strings)};
class Field { value = (() => { const data = [1,2]; return () => data; })()(); }
console.log(JSON.stringify({
 rounded:values.map(value=>[Math.round(value),Object.is(Math.round(value),-0)]),
 parsed:strings.map(value=>[Number(value),Object.is(Number(value),-0)]),
 formatted:[1.2345678901234567,1e-7,1e21,255].map(value=>[value.toString(),value.toString(16),value.toFixed(3)]),
 field:new Field().value
}));
console.log(1.2345678901234567);`;

test("alpha-17: dynamic number conversion, rounding, precision and class fields match Bun", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "sb-alpha17-"));
  try {
    const porffor = await ensurePorffor();
    const input = resolve(dir, "numbers.js"), binary = resolve(dir, "numbers");
    await writeFile(input, source);
    await rm(binary, { force: true });
    const compile = Bun.spawnSync(["bun", resolve(porffor, "runtime/index.js"), "native", input, "-o", binary, "-s", "-O0"], { stdout: "pipe", stderr: "pipe" });
    expect(compile.exitCode, new TextDecoder().decode(compile.stderr)).toBe(0);
    const run = Bun.spawnSync([binary], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
    const lines = new TextDecoder().decode(run.stdout).replaceAll("\x1b[33m", "").replaceAll("\x1b[0m", "").trim().split("\n");
    expect(JSON.parse(lines[0])).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(lines[1]).toBe("1.2345678901234567");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
