import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ensurePorffor } from "./acquire";

// strings.ts: in-place `s += e`, replace(regex, fn) and JSON.parse character reads keep
// Bun's results (aliasing, self-reference, coercion, wide strings, closures, generators,
// async), and building or rewriting a 100,000-piece string is linear.
const APPEND = String.raw`
const out = [];
const log = (...a) => out.push(a.map(x => typeof x === 'string' ? JSON.stringify(x) : String(x)).join(' '));
function alias1() { let s = "a"; s += "b"; s += "c"; const t = s; s += "d"; s += "e"; return [t, s]; }
function alias2() { let s = ""; const keep = []; for (let i = 0; i < 50; i++) { s += i; if (i % 7 == 0) keep.push(s); } return keep.join("|") + "#" + s; }
function selfRef() { let s = "x"; for (let i = 0; i < 5; i++) s += s; return s.length + ":" + s.slice(0, 5); }
function assignInRhs() { let s = "ab"; s += "c"; s += (s = "Z", "q"); s += "w"; return s; }
function numbers() { let s = 1; s += 2; s += "x"; s += 3; s += 4; return s; }
function objects() { let s = ""; s += { toString() { return "T"; } }; s += [1, 2]; s += null; s += undefined; s += 1.5; s += true; s += { valueOf() { return 7; }, toString() { return "no"; } }; return s; }
function symbolThrow() { let s = "a"; try { s += Symbol("x"); } catch (e) { return s + ":" + e.constructor.name; } return "no throw"; }
function wide() { let s = "ab"; s += "é"; s += "中"; s += "xyz"; for (let i = 0; i < 20; i++) s += String.fromCharCode(0x4e00 + i); s += "end"; return s; }
function wideFirst() { let s = "中"; for (let i = 0; i < 30; i++) s += "ab"; return s; }
function lengthReads() { let s = ""; while (s.length < 100) s += "xyz"; return s.length + s.slice(-4); }
function inLoopVar() { const r = []; for (let k = 0; k < 3; k++) { var v = "k" + k; v += "!"; v += "?"; r.push(v); } return r.join(","); }
function blockLet() { const r = []; for (let k = 0; k < 3; k++) { let v = ""; for (let j = 0; j < 4; j++) v += j; r.push(v); } return r.join(","); }
function passed() { let s = ""; const seen = []; const f = x => seen.push(x); for (let i = 0; i < 10; i++) { s += "a"; f(s); } return seen.join(","); }
function returnedEarly() { let s = "q"; for (let i = 0; i < 10; i++) { s += i; if (i == 5) return s; } return "x"; }
function exprPos() { let s = "a"; s += "b"; const t = (s += "c"); s += "d"; return t + "/" + s; }
function updateExpr() { let s = "5"; s += "1"; s++; s += "x"; return s; }
function shorthand() { let s = "a"; s += "b"; const o = { s }; s += "c"; return o.s + s; }
function template() { let s = "a"; s += "b"; const t = "<" + s + ">"; s += "c"; return t + s; }
function closureRead() { let s = "a"; s += "b"; const g = () => s; s += "c"; return g() + s; }
function closureWrite() { let s = "a"; const g = () => { s += "!"; }; s += "b"; g(); s += "c"; return s; }
function arrayHold() { let s = ""; const a = []; for (let i = 0; i < 20; i++) { s += String.fromCharCode(97 + i); a[i] = s; } return a[3] + a[10] + a[19]; }
function mapKey() { let s = "k"; const m = new Map(); for (let i = 0; i < 5; i++) { s += i; m.set(s, i); } return [...m.keys()].join(","); }
function objKey() { let s = "k"; const o = {}; for (let i = 0; i < 5; i++) { s += i; o[s] = i; } return Object.keys(o).join(","); }
function big() { let s = ""; for (let i = 0; i < 20000; i++) s += "item" + (i % 97) + ","; let h = 0; for (let i = 0; i < s.length; i += 1013) h = (h * 31 + s.charCodeAt(i)) | 0; return s.length + ":" + h; }
function bigAlias() { let s = ""; const snaps = []; for (let i = 0; i < 5000; i++) { s += "ab"; if (i % 1000 == 999) snaps.push(s); } return snaps.map(x => x.length).join(",") + ":" + snaps[0].slice(-3); }

function emptyApp() { let s = "abc"; s += ""; s += ""; const t = s; s += ""; s += "d"; return t + "|" + s; }
function compare() { let s = "a"; s += "b"; const eq = s === "ab"; s += "c"; return eq + ":" + (s === "abc"); }
async function asyncFn() { let s = ""; for (let i = 0; i < 5; i++) { s += await Promise.resolve(i); s += "-"; } return s; }
function* gen() { let s = ""; for (let i = 0; i < 4; i++) { s += i; yield s; } }
function strictFn() { "use strict"; var s = "u"; s += "s"; s += "e"; return s; }
function varTwiceInLoop() { const r = []; for (let i = 0; i < 3; i++) { var w = "w"; w += i; r.push(w); w += "z"; r.push(w); } return r.join(","); }
function labeled() { let s = ""; outer: for (let i = 0; i < 3; i++) { lbl: s += i; if (i == 1) break outer; } return s; }
function switchy(n) { let s = "s"; switch (n) { case 1: s += "one"; break; default: s += "other"; } s += "!"; return s; }
function shadow() { let s = "o"; { let s = "i"; s += "x"; } s += "y"; return s; }
function charCode() { let s = ""; for (let i = 0; i < 300; i++) s += "a"; return s.charCodeAt(5) + ":" + s.charCodeAt(299) + ":" + s.charCodeAt(300) + ":" + s.charCodeAt(-1) + ":" + s.charCodeAt(1.7) + ":" + s.charCodeAt("2") + ":" + s.charCodeAt(NaN) + ":" + s.charCodeAt(-0.5) + ":" + "中x".charCodeAt(0) + ":" + "中x".charCodeAt(1.9); }
for (const f of [alias1, alias2, selfRef, assignInRhs, numbers, objects, symbolThrow, wide, wideFirst, lengthReads, inLoopVar, blockLet, passed, returnedEarly, exprPos, updateExpr, shorthand, template, closureRead, closureWrite, arrayHold, mapKey, objKey, big, bigAlias, emptyApp, compare, strictFn, varTwiceInLoop, labeled, shadow, charCode]) log(f.name, f());
log("switch", switchy(1), switchy(2));
log("gen", [...gen()].join(","));
asyncFn().then(v => { log("async", v); console.log(out.join("\n")); });
`;

const REPLACE = String.raw`
const out = [];
const log = (...a) => out.push(a.map(x => typeof x === 'string' ? JSON.stringify(x) : String(x)).join(' '));
const S = "item12,item7,x99y,,a1b22c333";
log(1, S.replace(/\d+/g, d => String(d.length)));
log(2, S.replace(/(\d)(\d)?/g, (m, a, b, pos, str) => "[" + [m, a, b, pos, str === S].join("|") + "]"));
log(3, "abc".replace(/x*/g, m => "<" + m + ">"));
log(4, "".replace(/x*/g, m => "<" + m + ">"));
log(5, "😀a😀".replace(/(?:)/gu, () => "|"));
log(6, "😀a😀".replace(/(?:)/g, () => "|").length);
const re = /a/g; log(7, "aaaa".replace(re, (m, p) => { re.lastIndex = 100; return p; }), re.lastIndex);
const re2 = /b/g; re2.lastIndex = 3; log(8, "abcb".replace(re2, m => m.toUpperCase()), re2.lastIndex);
log(9, "aXbX".replace(/X/g, () => 42), "aXbX".replace(/X/g, () => null), "aXbX".replace(/X/g, () => ({ toString() { return "T"; } })));
try { "aXb".replace(/X/g, () => { throw new Error("boom"); }); } catch (e) { log(10, e.message); }
log(11, "2026-10-25".replace(/(?<y>\d+)-(?<m>\d+)/g, (...a) => JSON.stringify(a[a.length - 1])));
const re3 = /o/g; re3.exec = function (s) { return RegExp.prototype.exec.call(this, s); }; log(12, "foo".replace(re3, m => "0"));
log(13, "hello world".replace(/o/gy, "0"), "oohello".replace(/o/gy, () => "0"));
log(14, "中文abc中".replace(/[一-鿿]/g, c => c.charCodeAt(0).toString(16)));
log(15, "aaa".replace(/a/, () => "b"), "aaa".replace(/a/g, "$&$&"));
let big = ""; for (let i = 0; i < 5000; i++) big += "k" + i + ";";
log(16, big.replace(/\d+/g, d => d * 2).length, big.replace(/k(\d)(\d)?/g, (m, a, b) => b === undefined ? "U" : a + b).slice(0, 60));
const re4 = /x/g; let calls = 0; log(17, "xyx".replace(re4, (m) => { calls++; return re4.test("xxx") ? "T" : "F"; }), calls, re4.lastIndex);
log(19, "a.b.c".replaceAll(/\./g, (m, p) => p));
log(20, "Ünïcödé".replace(/[^a-z]/gi, c => "_"), "Ünïcödé".replace(/[^a-z]/giu, c => "_"));
// JSON.parse
const J = (s) => { try { return JSON.stringify(JSON.parse(s)); } catch (e) { return e.constructor.name; } };
for (const s of ['{"a":1,"b":[true,false,null],"c":"x\\ny\\u0041\\"z"}', ' [ 1 , 2.5e3 , -0.25 , 1E-2 ] ', '"中\\u6587"', '{"é":"è"}', '', ' ', '[', '[1,]', '{"a":1,}', 'tru', 'nul', 'fals', '"abc', '"a\\x"', '"\\u12"', '01', '1.', '-', '{"a" 1}', '{1:2}', '[1] x', '"\t"', '[1,2', '{"a":', '123', ' "s" ', '[[[[]]]]', '{"a":{"b":{"c":[1,{"d":"e"}]}}}', '"\\/\\b\\f\\r\\t"', '1e', '-01', '[-]', '"\ud800"']) log("J", JSON.stringify(s), J(s));
const arr = []; for (let i = 0; i < 500; i++) arr.push({ id: i, name: "n" + i, v: [i, i / 3], s: "q\"\\中" }); const txt = JSON.stringify(arr); log("Jbig", txt.length, JSON.stringify(JSON.parse(txt)) === txt);
log("rev", JSON.stringify(JSON.parse('{"a":[1,2],"b":"x"}', (k, v) => typeof v === "number" ? v * 10 : v)));
console.log(out.join("\n"));
`;

// Function locals only: the pass leaves top-level code alone.
const TIMED = `function main() {
  let t = performance.now();
  let s = ""; for (let i = 0; i < 100000; i++) s += "item" + (i % 1000) + ",";
  const build = performance.now() - t;
  t = performance.now();
  const r = s.replace(/\\d+/g, (d) => String(d.length));
  const replace = performance.now() - t;
  console.log(JSON.stringify({ length: s.length, r: r.length }));
  console.log(Math.round(build) + " " + Math.round(replace));
}
main();`;

async function compileAndRun(dir: string, name: string, source: string) {
  const porffor = await ensurePorffor();
  const input = resolve(dir, `${name}.js`),
    binary = resolve(dir, name);
  await writeFile(input, source);
  const compile = Bun.spawnSync(
    ["bun", resolve(porffor, "runtime/index.js"), "native", input, "-o", binary, "-s", "-O0"],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(compile.exitCode, new TextDecoder().decode(compile.stderr)).toBe(0);
  const run = Bun.spawnSync([binary], { stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
  const reference = Bun.spawnSync(["bun", input], { stdout: "pipe" });
  const text = (bytes: Uint8Array) =>
    new TextDecoder().decode(bytes).replaceAll("\x1b[33m", "").replaceAll("\x1b[0m", "").trim();
  return { got: text(run.stdout), want: text(reference.stdout) };
}

test("string appends, replace with a callback and JSON.parse match Bun", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "sb-strings-"));
  try {
    for (const [name, source] of [
      ["append", APPEND],
      ["replace", REPLACE],
    ] as const) {
      const { got, want } = await compileAndRun(dir, name, source);
      expect(got.split("\n")).toEqual(want.split("\n"));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);

test("a 100,000-append loop and a 100,000-match replace are linear", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "sb-strings-timed-"));
  try {
    const { got, want } = await compileAndRun(dir, "timed", TIMED);
    const [result, ms] = got.split("\n");
    expect(result).toBe(want.split("\n")[0]);
    // Quadratic copying moved ~25 GB here (seconds); linear takes a few ms even at -O0.
    const [build, replace] = ms!.split(" ").map(Number);
    expect(build).toBeLessThan(250);
    expect(replace).toBeLessThan(500);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
