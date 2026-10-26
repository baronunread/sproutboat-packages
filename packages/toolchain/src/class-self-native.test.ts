import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ensurePorffor } from "./acquire";

// baronunread/sproutboat#256: inside a function, a named class expression's own
// name must be the class itself. marked's minified Lexer has exactly this shape.
const program = `function inner() {
  var R = class l { constructor(o) { this.o = o || E; } static make(o) { return new l(o); } lex(s) { return s.length; } static lex(s) { return new l().lex(s); } };
  var E = { d: 1 };
  var C = class k extends R { lex(s) { return super.lex(s) + 1; } static make() { return new k(); } };
  var plain = class { static make() { return 7; } };
  return [R === new R().constructor, R.make().o.d, R.lex("abc"), C.make().lex("ab"), C.name, plain.make()].join(" ");
}
async function viaAwait() {
  var A = class m { static async load() { await null; return new m(); } ok() { return "ok"; } };
  return (await A.load()).ok();
}
console.log(inner());
viaAwait().then((v) => console.log(v));
`;

test("#256: a named class expression inside a function sees itself", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "sb-class-self-"));
  try {
    const porffor = await ensurePorffor();
    const source = resolve(root, "classes.js");
    const binary = resolve(root, "classes");
    await writeFile(source, program);
    const compile = Bun.spawnSync(["bun", resolve(porffor, "runtime/index.js"), "native", source, "-o", binary, "-s"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(compile.exitCode, Buffer.from(compile.stderr).toString()).toBe(0);
    const run = Bun.spawnSync([binary], { stdout: "pipe", stderr: "pipe" });
    const lines = Buffer.from(run.stdout).toString().replace(/\u001b\[[0-9;]*m/g, "").trim().split("\n");
    expect(lines).toEqual(["true 1 3 3 k 7", "ok"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
