import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorfforPatchedA21 } from "./patch";
import { PORFFOR_A21_PINS } from "./pin";

// Three miscompiles the control-plane spike found on Porffor alpha 22 (postgres.js and drizzle-orm
// run into all three). Each program is compiled to a native binary with the patched alpha 22 tree.
let root = "";
let work = "";
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "sb-a21-mis-")));
  work = join(root, "work");
  const pin = PORFFOR_A21_PINS["alpha-22"];
  const archive = resolve(import.meta.dir, "../../vendor", pin.vendoredArchive);
  const tar = Bun.spawnSync(["tar", "-xzf", archive, "-C", root, "--strip-components=1"], { stderr: "pipe" });
  expect(tar.exitCode, new TextDecoder().decode(tar.stderr)).toBe(0);
  await ensurePorfforPatchedA21(root);
  await Bun.write(join(root, "work/.keep"), "");
}, 120_000);
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function run(name: string, program: string): Promise<string[]> {
  const source = join(work, `${name}.js`);
  const binary = join(work, name);
  await writeFile(source, program);
  const compile = Bun.spawnSync(["bun", join(root, "runtime/index.js"), "native", source, "-o", binary], {
    cwd: work,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(compile.exitCode, new TextDecoder().decode(compile.stderr)).toBe(0);
  const out = Bun.spawnSync([binary], { stdout: "pipe", stderr: "pipe" });
  expect(out.exitCode, new TextDecoder().decode(out.stderr)).toBe(0);
  return new TextDecoder()
    .decode(out.stdout)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trim()
    .split("\n");
}

test("a method call on an unknown receiver evaluates its arguments left to right (Buffer#toString(enc, i, i += n))", async () => {
  // postgres.js decodes every DataRow value as x.toString('utf8', index, index += length).
  const lines = await run(
    "dispatch",
    `function decode(x, index, length) { return x.toString("utf8", index, index += length) + "|" + index; }
function sub(x, index, length) { return JSON.stringify(Array.from(x.subarray(index, index += length))) + "|" + index; }
function pick(x, index, length) { return x.slice(index, index += length) + "|" + index; }
const buf = Buffer.from("hello world");
console.log(decode(buf, 0, 5));
console.log(decode(buf, 6, 5));
console.log(sub(buf, 1, 2));
console.log(pick("abcdef", 2, 3));
console.log(pick([1, 2, 3, 4, 5], 1, 2).replace(/,/g, ""));
`,
  );
  expect(lines).toEqual(["hello|5", "world|11", "[101,108]|3", "cde|5", "23|3"]);
}, 60_000);

test("Date parses Postgres text timestamps (space separator, +00 and +0000 offsets)", async () => {
  const samples: [string, number][] = [
    ["2026-11-08 14:48:19.097+00", Date.UTC(2026, 10, 8, 14, 48, 19, 97)],
    ["2026-11-08 14:48:19.097+0000", Date.UTC(2026, 10, 8, 14, 48, 19, 97)],
    ["2026-11-08 14:48:19+00", Date.UTC(2026, 10, 8, 14, 48, 19)],
    ["2026-11-08T14:48:19.097+0530", Date.UTC(2026, 10, 8, 9, 18, 19, 97)],
    ["2026-11-08 14:48:19.097-05", Date.UTC(2026, 10, 8, 19, 48, 19, 97)],
    ["2026-11-08 14:48:19.097-05:30", Date.UTC(2026, 10, 8, 20, 18, 19, 97)],
    ["2026-11-08 14:48:19.097+00:00", Date.UTC(2026, 10, 8, 14, 48, 19, 97)],
  ];
  const lines = await run(
    "dates",
    `for (const s of ${JSON.stringify(samples.map(([s]) => s))}) console.log(new Date(s).getTime());
for (const s of ["2026-11-08 14:48:19+0", "2026-11-08 14:48:19+000", "2026-11-08 14:48:19+99", "2026-11-08 14:48:19+0075", "2026-11-08 14:48:19+00x"]) console.log(new Date(s).getTime());
`,
  );
  expect(lines.slice(0, samples.length).map(Number)).toEqual(samples.map(([, t]) => t));
  expect(lines.slice(samples.length)).toEqual(["NaN", "NaN", "NaN", "NaN", "NaN"]);
}, 60_000);

test("a class binding can be reassigned: the TypeScript namespace-merge pattern", async () => {
  // drizzle's sql/sql.js: class SQL {}; (function (SQL) { ... })(SQL || (SQL = {}));
  const lines = await run(
    "classwrite",
    `class SQL { static x = 1; static hi() { return "hi"; } }
(SQL || (SQL = {}));
console.log(typeof SQL, SQL.x, SQL.hi(), new SQL() instanceof SQL);
class Other { static y = 2; }
Other = Other;
console.log(typeof Other, Other.y);
class Swapped { static z = 3; }
const old = Swapped;
Swapped = { z: 4 };
console.log(old.z, Swapped.z);
function scoped() { class L { static v = 5; } (L || (L = {})); return L.v; }
console.log(scoped());
(function (Q) { Q.extra = 9; })(SQL || (SQL = {}));
console.log(SQL.extra);
`,
  );
  expect(lines).toEqual(["function 1 hi true", "function 2", "3 4", "5", "9"]);
}, 60_000);

test("an assignment on the right of || / && / ?? does not retype the left operand", async () => {
  // the compile-time type of a local followed the assignment although the branch may not run
  const lines = await run(
    "logicinfer",
    `const a = (() => { let o = 1; o || (o = {}); return typeof o; })();
const b = (() => { let o = 0; o || (o = "s"); return typeof o; })();
const c = (() => { let o = 1; o && (o = "t"); return typeof o; })();
const d = (() => { let o = 1; o ?? (o = {}); return typeof o; })();
const e = (() => { let o = 1; const r = o || (o = {}); return typeof o + typeof r; })();
const f = (() => { class L { static v = 5; } L || (L = {}); const t = typeof L; return t + L.v + new L().constructor.name; })();
console.log([a, b, c, d, e, f].join(" "));
`,
  );
  expect(lines).toEqual(["number string string number numbernumber function5L"]);
}, 60_000);
