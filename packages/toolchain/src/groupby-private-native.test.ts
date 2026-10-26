import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ensurePorffor } from "./acquire";

// baronunread/sproutboat#286: Map.groupBy exists, and private fields stay out of
// Object.keys, for-in, Object.entries and JSON.stringify. Compared against Bun.
const source = `const m = Map.groupBy([1, 2, 3, 4, NaN, NaN], (x) => (x !== x ? "nan" : x % 2 ? "odd" : "even"));
const key = {};
const byObject = Map.groupBy([1, 2, 3], (x) => (x > 1 ? key : 0));
class A { #s = 1; pub = 2; static #t = 3; static u = 4; get s() { return this.#s; } static get t() { return A.#t; } inc() { this.#s++; return this.#s; } }
const a = new A();
const forIn = []; for (const k in a) forIn.push(k);
console.log(JSON.stringify({
  groups: [...m], size: m.size, isMap: m instanceof Map, byObject: [byObject.get(key), byObject.get(0)],
  keys: Object.keys(a), json: JSON.stringify(a), values: [a.s, a.inc(), A.t], staticKeys: Object.keys(A),
  forIn, entries: Object.entries(a),
}));`;

test("#286: Map.groupBy and private fields match Bun", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "sb-286-"));
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
    const strip = (bytes: Uint8Array) =>
      new TextDecoder().decode(bytes).replaceAll("\x1b[33m", "").replaceAll("\x1b[0m", "").trim();
    expect(JSON.parse(strip(run.stdout))).toEqual(JSON.parse(strip(reference.stdout)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
