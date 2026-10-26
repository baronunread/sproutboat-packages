import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ensurePorffor } from "./acquire";

// Found by the sproutd W2 conformance suite: JSON.stringify of a cycle overflowed the
// native stack (the process died) instead of throwing, and typed arrays had no toString
// tag. Compared against Bun, except the cycle message, which follows V8.
const source = `const out = [];
const a = { n: 1 }; a.self = a;
try { JSON.stringify(a); out.push("no throw"); } catch (e) { out.push(e.name); }
const arr = [1]; arr.push(arr);
try { JSON.stringify(arr); out.push("no throw"); } catch (e) { out.push(e.name); }
const shared = { x: 1 };
out.push(JSON.stringify({ a: shared, b: [shared, [shared]] }));
const bad = { toJSON() { throw new RangeError("t"); } };
try { JSON.stringify({ x: { y: bad } }); } catch (e) { out.push(e.name); }
out.push(JSON.stringify({ x: { y: 1 } }));
out.push([new Uint8Array(1), new Float64Array(1), new BigInt64Array(1), new DataView(new ArrayBuffer(1)), []].map((x) => Object.prototype.toString.call(x)).join(" "));
console.log(JSON.stringify(out));`;

test("JSON.stringify throws on cycles and typed arrays have toString tags, as in Bun", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "sb-json-cycles-"));
  try {
    const porffor = await ensurePorffor();
    const input = resolve(dir, "case.js"), binary = resolve(dir, "case");
    await writeFile(input, source);
    const compile = Bun.spawnSync(["bun", resolve(porffor, "runtime/index.js"), "native", input, "-o", binary, "-s", "-O0"], { stdout: "pipe", stderr: "pipe" });
    expect(compile.exitCode, new TextDecoder().decode(compile.stderr)).toBe(0);
    const run = Bun.spawnSync([binary], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
    const reference = Bun.spawnSync(["bun", input], { stdout: "pipe" });
    const strip = (bytes: Uint8Array) => new TextDecoder().decode(bytes).replaceAll("\x1b[33m", "").replaceAll("\x1b[0m", "").trim();
    expect(JSON.parse(strip(run.stdout))).toEqual(JSON.parse(strip(reference.stdout)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
