import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ensurePorffor } from "./acquire";

// Compare native output with Bun, including trap effects and iterator state.
const program = `
const target = { x: 1 };
let calls = 0;
const proxy = new Proxy(target, {
  get(t, key, receiver) { calls++; return key === "virtual" ? 7 : Reflect.get(t, key, receiver); },
  set(t, key, value) { t[key] = value * 2; return true; },
  has(t, key) { return key === "virtual" || key in t; },
  deleteProperty(t, key) { delete t[key]; return true; }
});
proxy.x = 3;
console.log(proxy.x, proxy.virtual, calls, "virtual" in proxy);
delete proxy.x;
console.log("x" in target);
const keys = new Proxy({ a: 1 }, {
  ownKeys() { return ["a"]; },
  getOwnPropertyDescriptor(t, key) { return Object.getOwnPropertyDescriptor(t, key); }
});
console.log(Object.keys(keys).join(","));
const fn = new Proxy(function (x) { return x + 1; }, {
  apply(t, self, args) { return t(args[0]) * 2; }
});
console.log(fn(3));
const ctor = new Proxy(function Item(x) { this.x = x; }, {
  construct(t, args) { return { x: args[0] * 3 }; }
});
console.log(new ctor(4).x);
const revocable = Proxy.revocable({ x: 1 }, {});
console.log(revocable.proxy.x);
revocable.revoke();
try { console.log(revocable.proxy.x); } catch (e) { console.log(e instanceof TypeError); }
const frozen = Object.freeze({ x: 1 });
try { console.log(new Proxy(frozen, { get() { return 2; } }).x); } catch (e) { console.log(e instanceof TypeError); }
const iterator = [1, 2].values();
console.log(iterator.next().value, iterator.next().value, iterator.next().done);
console.log(Array.from(new Map([["a", 1], ["b", 2]]).keys()).join(","));
console.log([...new Set([1, 2, 1])].join(","));
console.log(Array.from("ab").join(","));
const matches = "a1a2".matchAll(/a(\\d)/g);
console.log(matches.next().value[1], matches.next().value[1], matches.next().done);
console.log(Uint8Array.from({ length: 3 }, (_, i) => i + 1).join("-"));
const bytes = new Uint8Array(3); bytes.set([4, 5]); console.log(bytes.toString());
console.log(new Uint8ClampedArray([0.5, 1.5, 2.5, 3.5]).join(","));
class Static { static value = this; static { this.x = 9; } }
console.log(Static.value === Static, Static.x);
const dict = Object.create(null); dict.__proto__ = 5;
console.log(dict.__proto__, Object.getPrototypeOf(dict) === null);
let order = "";
function left() { order += "l"; return 1; }
function right() { order += "r"; return 2; }
console.log(left() + right(), order);
console.log("caffè 東京 🚤");
`;

test("alpha-16: native Proxy, iterators and upstream fixes match Bun", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "sb-alpha16-native-"));
  try {
    const porffor = await ensurePorffor();
    const source = resolve(root, "features.js");
    const binary = resolve(root, "features");
    await writeFile(source, program);
    const reference = Bun.spawnSync(["bun", source], { stdout: "pipe", stderr: "pipe" });
    expect(reference.exitCode).toBe(0);
    await rm(binary, { force: true });
    const compile = Bun.spawnSync(["bun", resolve(porffor, "runtime/index.js"), "native", source, "-o", binary, "-s"], {
      cwd: root, stdout: "pipe", stderr: "pipe",
    });
    expect(compile.exitCode, Buffer.from(compile.stderr).toString()).toBe(0);
    const run = Bun.spawnSync([binary], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    expect(run.exitCode, Buffer.from(run.stderr).toString()).toBe(0);
    const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
    const output = Buffer.from(run.stdout).toString().replace(ansi, "");
    expect(output).toBe(Buffer.from(reference.stdout).toString());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
