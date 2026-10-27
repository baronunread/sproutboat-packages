import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ensurePorffor } from "./acquire";

// Alpha 18 made our typed-array bounds (#238/#241) and JSON toJSON patches
// redundant; these cases keep the upstream behaviour we now rely on. The local
// function cases still need patchLocalFunctionTypes: unpatched Alpha 18 throws
// a TypeError, inferring each call's type from the unrelated same-named async
// function instead of the local binding.
const source = `async function resolve(x) { return x; }
function outer() { const resolve = function (v) { return v * 2; }; return resolve(5) + 1; }
const models = { user: "u" };
function pick(name) { const getModel = (n) => models[n] ?? n; return getModel(name).toUpperCase(); }
async function getModel() { return null; }
const a = new Uint8Array(4); a[1] = 7; a[10] = 9; a[-1] = 5;
const b = new Uint8Array(4);
console.log(JSON.stringify({
 local: [outer(), pick("user"), pick("post")],
 typed: [String(a[10]), String(a[-1]), String(a[1.5]), a.join(","), b.join(",")],
 json: [JSON.stringify({ d: new Date(0), o: { toJSON() { return "x"; } }, n: [1, { toJSON(k) { return k; } }] }),
   JSON.stringify({ a: 1, b: 2 }, (k, v) => (k === "a" ? undefined : v))],
 iterators: [[1, 2, 3].values().map((x) => x * 2).toArray().join(","), [...new Set([1, 2]).union(new Set([3]))].join(",")],
}));`;

test("alpha-18: local function types, typed-array bounds, toJSON and iterator helpers match Bun", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "sb-alpha18-"));
  try {
    const porffor = await ensurePorffor();
    const input = resolve(dir, "alpha18.js"),
      binary = resolve(dir, "alpha18");
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
