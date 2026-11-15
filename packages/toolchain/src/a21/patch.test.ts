import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MANIFEST_FILE,
  SERIES_DIR,
  TARBALL_FILE,
  check,
  listSeries,
  readManifest,
  seriesSha256,
  verify,
} from "../../../../scripts/porffor-patches";
import { ensurePorfforA21, cachedPorfforA21Root } from "./acquire";
import { A21_PATCH_FINGERPRINT } from "./fingerprint";
import { extractPatchedTree } from "./patched-tree";
import { CURRENT_ALPHA, PORFFOR_A21_PINS } from "./pin";

/**
 * What these tests cover: the patch SERIES (`porffor-patches/`, applied to upstream by
 * `scripts/porffor-patches.ts`) and the PATCHED TREE it makes (the vendored tarball the toolchain ships).
 * The first block is cheap and runs everywhere: the committed series, manifest, tarball and PATCHES.md
 * agree. The second reads the shipped tree for what each patch is meant to do and compiles programs with it.
 * Reproducing the tarball from upstream (apply + export + vendor, byte for byte) needs git and the upstream
 * commit: CI runs `bun scripts/porffor-patches.ts verify`, and PORFFOR_SERIES_VERIFY=1 runs it here.
 */

const temporary: string[] = [];
afterAll(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** The shipped patched tree in a fresh directory the test may write to. */
async function patched(): Promise<string> {
  const root = await extractPatchedTree();
  temporary.push(root);
  return root;
}

// --- the series, the manifest and the tarball agree ---

test("the committed series, manifest and tarball agree (no git, no network)", () => {
  expect(check()).toEqual([]);
  const manifest = readManifest();
  expect(manifest.series.sha256).toBe(seriesSha256());
  expect(manifest.series.files).toEqual(listSeries());
  expect(manifest.tarball.sha256).toBe(createHash("sha256").update(readFileSync(TARBALL_FILE)).digest("hex"));
  expect(MANIFEST_FILE.endsWith("vendor/porffor-patched.json")).toBe(true);
});

test("the pin is the manifest's: one alpha, the series hash is the cache fingerprint", () => {
  const manifest = readManifest();
  expect(CURRENT_ALPHA).toBe(manifest.upstream.channel);
  expect(Object.keys(PORFFOR_A21_PINS)).toEqual([CURRENT_ALPHA]);
  const pin = PORFFOR_A21_PINS[CURRENT_ALPHA];
  expect(pin.commitFull).toBe(manifest.upstream.commit);
  expect(pin.commitFull).toMatch(/^[0-9a-f]{40}$/);
  expect(pin.archiveSha256).toBe(manifest.tarball.sha256);
  expect(A21_PATCH_FINGERPRINT).toBe(manifest.series.sha256.slice(0, 12));
  expect(A21_PATCH_FINGERPRINT).toMatch(/^[0-9a-f]{12}$/);
});

test("every patch says what, why and its class; upstream bugs link their issue; PATCHES.md indexes each", () => {
  const index = readFileSync(resolve(SERIES_DIR, "../PATCHES.md"), "utf8");
  const names = listSeries();
  expect(names.length).toBeGreaterThan(20);
  let generated = 0;
  for (const [i, name] of names.entries()) {
    expect(name, "numbered in order").toStartWith(String(i + 1).padStart(4, "0") + "-");
    const text = readFileSync(join(SERIES_DIR, name), "utf8");
    const message = text.slice(0, text.indexOf("\n---\n"));
    const cls = /^Class: (ours|upstream|generated)$/m.exec(message)?.[1];
    expect(cls, `${name}: a \`Class:\` trailer`).toBeDefined();
    expect(message, `${name}: a body, not only a subject`).toMatch(/^Subject: .+\n(.+\n)*\n\S/m);
    expect(message, name).toMatch(/^Pass: .+$/m);
    if (cls === "generated") generated++;
    // The one upstream-class pass with no issue is repeat (nothing to report: it is linear upstream).
    if (cls === "upstream" && !name.includes("repeat"))
      expect(message, `${name}: an upstream issue link`).toMatch(
        /^Upstream: https:\/\/github\.com\/CanadaHonk\/porffor\/issues\/\d+$/m,
      );
    expect(index, `PATCHES.md lists ${name}`).toContain(name);
  }
  // The generated precompile patch is the last one, and the only one.
  expect(generated).toBe(1);
  expect(names.at(-1)).toContain("regenerate-compiler-builtins_precompiled");
});

test("the series reproduces from upstream byte for byte (PORFFOR_SERIES_VERIFY=1; CI runs it as a job)", () => {
  if (!process.env.PORFFOR_SERIES_VERIFY) return;
  expect(verify(process.env.PORFFOR_UPSTREAM, () => {})).toEqual([]);
}, 300_000);

// --- the shipped tree ---

test("acquire unpacks the vendored tarball once, verified, and republishes a damaged cache entry", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-a21-acquire-"));
  temporary.push(cacheRoot);
  const dir = await ensurePorfforA21(CURRENT_ALPHA, { cacheRoot });
  expect(dir).toBe(cachedPorfforA21Root(CURRENT_ALPHA, cacheRoot));
  expect(dir).toContain(A21_PATCH_FINGERPRINT);
  const complete = JSON.parse(await readFile(join(dir, ".sproutboat-complete"), "utf8"));
  expect(complete.commit).toBe(PORFFOR_A21_PINS[CURRENT_ALPHA].commitFull);
  expect(complete.archiveSha256).toBe(readManifest().tarball.sha256);
  expect(complete.patchFingerprint).toBe(A21_PATCH_FINGERPRINT);
  // Same tree as the tarball: nothing was patched on the way.
  const direct = await patched();
  for (const file of ["compiler/codegen.js", "compiler/render.js", "compiler/builtins_precompiled.js"])
    expect(await readFile(join(dir, file), "utf8"), file).toBe(await readFile(join(direct, file), "utf8"));
  expect(await ensurePorfforA21(CURRENT_ALPHA, { cacheRoot })).toBe(dir);
  // A cache entry whose file no longer matches the manifest is replaced, not trusted.
  await rm(join(dir, ".sproutboat-complete"), { force: true });
  await writeFile(join(dir, "compiler/codegen.js"), "// damaged\n");
  const again = await ensurePorfforA21(CURRENT_ALPHA, { cacheRoot });
  expect(again).toBe(dir);
  expect(await readFile(join(dir, "compiler/codegen.js"), "utf8")).toBe(
    await readFile(join(direct, "compiler/codegen.js"), "utf8"),
  );
}, 120_000);

test("the shipped tree carries every patch's edit", async () => {
  const root = await patched();
  const files = [
    "compiler/codegen.js",
    "compiler/modules.js",
    "compiler/render.js",
    "compiler/index.js",
    "compiler/builtins.js",
    "runtime/node/internal/fetch.js",
    "runtime/node/process.js",
    "compiler/builtins/promise.ts",
    "compiler/builtins/string.ts",
    "compiler/builtins/regexp.ts",
    "compiler/builtins/json.ts",
    "compiler/builtins/date.ts",
    "compiler/builtins/_internal_object.ts",
    "compiler/builtins_precompiled.js",
  ];
  const text: Record<string, string> = {};
  for (const f of files) text[f] = await readFile(join(root, f), "utf8");
  for (const [f, marker] of [
    ["compiler/codegen.js", "sproutboat P1: class functions stay in their module's unit"],
    ["compiler/codegen.js", "sproutboat P5: stable derived names"],
    ["compiler/codegen.js", "sproutboat P6: inits of app-module globals"],
    ["compiler/codegen.js", "sproutboat P8: shared dispatch functions belong to the asking unit"],
    ["compiler/codegen.js", "sharedFunc('((o, k) => o[k])', scope, 'get')"],
    ["compiler/codegen.js", "#class_computed_prop_${unitOf(scope)}_"],
    ["compiler/codegen.js", "sproutboat P10: shared dispatch arguments are evaluated in order"],
    ["compiler/codegen.js", "sproutboat P13: the right operand of a logical expression is a branch"],
    // P11 on alpha 24 leaves a decorated or boxed class alone.
    ["compiler/codegen.js", "if (!expr && decl._writes && !classDecorators && !decl._boxed) {"],
    ["compiler/modules.js", "sproutboat P6: app-owned modules"],
    ["compiler/modules.js", "sproutboat P4: prelude-declared names override runtime globals"],
    ["compiler/modules.js", "sproutboat P14: runtime globals pinned to the template's"],
    ["compiler/modules.js", "sproutboat P7: stable entry path"],
    ["compiler/render.js", "sproutboat: collector hooks for the fork template"],
    ["compiler/render.js", "static void porf_gc_scan_template_cards(void)"],
    ["compiler/render.js", "static u64 porf_gc_limit_room(void) {"],
    ["compiler/render.js", "sproutboat: per-request cpu"],
    ["compiler/render.js", "sproutboat P2: app units last, pinned ABI regions"],
    ["compiler/render.js", "sproutboat P3: a unit's segments by content"],
    ["compiler/render.js", "sproutboat P6: app-module globals last"],
    ["compiler/render.js", "sproutboat: glibc select"],
    // alpha 24's own text, untouched by any patch: js functions carry PORF_CC (swiftcall on clang arm64).
    ["compiler/render.js", "#define PORF_CC __attribute__((swiftcall))"],
    ["compiler/builtins/_internal_object.ts", "sproutboat: frozen megamorphic cache"],
    ["compiler/builtins/promise.ts", "sproutboat: per-request cpu"],
    ["compiler/builtins/json.ts", "sproutboat P9: a wide JSON string is sized by its own length"],
    ["compiler/builtins/date.ts", "sproutboat P12: UTC offsets without a colon"],
    ["compiler/index.js", "SB_EXTRA_LINK"],
    ["compiler/index.js", "SB_EXTRA_CFLAGS"],
    ["compiler/builtins.js", "sproutboat: navigator is writable"],
    ["runtime/node/internal/fetch.js", "sproutboat: Response.redirect and Response.error"],
    ["runtime/node/process.js", "sproutboat: null argv and environ"],
    ["compiler/builtins/string.ts", "sproutboat #237: pieces joined once"],
    ["compiler/builtins/string.ts", "sproutboat B16: doubling repeat"],
    ["compiler/builtins/string.ts", "sproutboat: Unicode case mapping"],
    ["compiler/builtins/regexp.ts", "export const __Porffor_regex_replaceCallback = "],
  ] as const)
    expect(text[f], `${marker} in ${f}`).toContain(marker);
  // alpha 24's own file (the TypeScript lowering) is untouched by every patch.
  expect(await Bun.file(join(root, "compiler/typescript.js")).exists()).toBe(true);
  // The table was regenerated after the builtin edits: it carries the replaceAll rewrite and the mega freeze.
  expect(text["compiler/builtins_precompiled.js"]).toContain("replaceAll");
  expect(text["compiler/builtins_precompiled.js"]).toContain("icFreezeMega");
}, 120_000);

test("a shared prelude owns fetch and the timers: the worker compile links no network stack", async () => {
  const root = await patched();
  const work = join(root, "work");
  await mkdir(work);
  // sproutd's compile shape: the entry imports the app unit, which imports the prelude first.
  await writeFile(
    join(work, "shared-prelude.js"),
    "const fetch = () => { throw new Error('fetch: host transport'); };\nglobalThis.fetch = fetch;\n" +
      "class Probe { constructor(x) { this.x = x; } get double() { return this.x * 2; } }\nglobalThis.__sbProbe = Probe;\nexport {};\n",
  );
  await writeFile(
    join(work, "worker.js"),
    "import './shared-prelude.js';\nclass AppThing { twice(y) { return y + y; } }\n" +
      "export const r = Response.redirect('http://example.com/x', 301);\n" +
      "console.log(r.status, r.headers.get('location'), new AppThing().twice(2), new globalThis.__sbProbe(4).double, typeof fetch);\n",
  );
  await writeFile(join(work, "app.js"), "import './worker.js';\n");
  const out = join(work, "out");
  const compile = Bun.spawnSync(["bun", join(root, "runtime/index.js"), "c", join(work, "app.js"), "-o", out], {
    cwd: work,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(compile.exitCode, new TextDecoder().decode(compile.stderr)).toBe(0);
  const units = (await readdir(out)).filter((f) => f.endsWith(".c"));
  expect(
    units.some((f) => /fetch-client|internal_uv|uws|node_net|node_http|node_dns/.test(f)),
    units.join(" "),
  ).toBe(false);
  expect(
    units.some((f) => f.startsWith("worker.js.")),
    units.join(" "),
  ).toBe(true);
  const header = await readFile(join(out, "porf.h"), "utf8");
  expect(header).not.toContain("uv.h");
  // P1: the app's class method lives in the app unit, not in main; the prelude's in the prelude unit.
  const appUnit = await readFile(
    join(
      out,
      units.find((f) => f.startsWith("worker.js."))!,
    ),
    "utf8",
  );
  expect(appUnit).toContain("twice");
  const main = await readFile(join(out, "porf__main.c"), "utf8");
  expect(main).not.toMatch(/^(?:PORF_CC )?jsval p_\w*__23twice/m);
  // P2: the function-record and name regions sit at the pinned offsets (the image is sparse between them).
  expect(main).toContain("porf_fnrecs");
}, 120_000);

test("plan 001 step B: the collector's budget and nursery cap are clamped by the app's memory limit", async () => {
  const root = await patched();
  const render = await readFile(join(root, "compiler/render.js"), "utf8");
  // Both edits are in, each once: the limit and its setter, the budget clamp and the nursery cap clamp.
  for (const needle of [
    "static u64 porf_gc_limit_bytes = 0;",
    "${st}void porf_gc_set_limit(u64 bytes) { porf_gc_limit_bytes = bytes; }",
    "static u64 porf_gc_limit_room(void) {",
    "  return (u64)want > room ? (i64)room : want;\n",
    "  const u32 cap = cap_free > cap_room ? (u32)cap_room : cap_free;\n",
    // the collector-less renderer links against the same hook
    "${st}void porf_gc_set_limit(u64 bytes) { (void)bytes; }",
  ])
    expect(render.split(needle).length, needle).toBe(2);
  // Behaviour, not only text: compile the patched budget with stand-in state and read what it decides.
  const from = render.indexOf("static u64 porf_gc_limit_bytes = 0;");
  const to = render.indexOf("static void porf_gc_cycle(i64 allocated) {", from);
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  const budget = render.slice(from, to).replaceAll("${st}", "");
  const harness =
    "#include <stdio.h>\n#include <stdint.h>\ntypedef uint64_t u64;\ntypedef int64_t i64;\n" +
    "static u64 porf_gc_last_live_bytes; static i64 porf_gc_promoted_since_full, porf_gc_survival; static u64 porf_gc_nursery_bytes;\n" +
    budget +
    "static void row(u64 limit, u64 live, i64 promoted, i64 survival, u64 nursery) {\n" +
    "  porf_gc_set_limit(limit); porf_gc_last_live_bytes = live; porf_gc_promoted_since_full = promoted;\n" +
    "  porf_gc_survival = survival; porf_gc_nursery_bytes = nursery;\n" +
    '  printf("%lld %llu\\n", (long long)porf_gc_budget(), (unsigned long long)porf_gc_limit_room());\n}\n' +
    "int main(void) {\n" +
    "  const u64 M = 1048576ull;\n" +
    "  row(0, 20 * M, 0, 80, 4 * M);        // no limit: twice live while survival is high\n" +
    "  row(0, 20 * M, 0, 10, 4 * M);        // no limit: the nursery\n" +
    "  row(24 * M, 0, 0, 10, 32 * M);       // limit 24 MiB, nothing live: half of it\n" +
    "  row(24 * M, 18 * M, 0, 10, 32 * M);  // 18 MiB live: half of the 6 MiB left\n" +
    "  row(24 * M, 8 * M, 0, 80, 4 * M);    // survival high: twice live would be 16 MiB, the limit allows 8\n" +
    "  row(24 * M, 8 * M, 4 * M, 10, 32 * M); // what minor collections promoted counts as live\n" +
    "  row(24 * M, 30 * M, 0, 10, 32 * M);  // past the limit already: 1 MiB, never zero\n" +
    "  row(24 * M, 2 * M, 0, 10, 2 * M);    // a small nursery stays as it is\n" +
    "  return 0;\n}\n";
  const dir = await mkdtemp(join(tmpdir(), "sb-a21-budget-"));
  temporary.push(dir);
  await writeFile(join(dir, "budget.c"), harness);
  const cc = Bun.spawnSync(["cc", "-O1", "-Wall", "-Werror", "-o", join(dir, "budget"), join(dir, "budget.c")], {
    stderr: "pipe",
  });
  expect(cc.exitCode, new TextDecoder().decode(cc.stderr)).toBe(0);
  const run = Bun.spawnSync([join(dir, "budget")], { stdout: "pipe" });
  expect(new TextDecoder().decode(run.stdout).trim().split("\n")).toEqual([
    "41943040 18446744073709551615",
    "4194304 18446744073709551615",
    "12582912 12582912",
    "3145728 3145728",
    "8388608 8388608",
    "6291456 6291456",
    "1048576 1048576",
    "2097152 11534336",
  ]);
}, 180_000);

test("P8: the shared dispatch functions sit in the unit that asked, under stable names", async () => {
  const root = await patched();
  const work = join(root, "work");
  await mkdir(work);
  // The prelude dispatches trim and padStart on an untyped receiver; the app dispatches four methods, two of them the same.
  await writeFile(
    join(work, "shared-prelude.js"),
    "const fetch = () => { throw new Error('fetch: host transport'); };\nglobalThis.fetch = fetch;\n" +
      "export const pre = r => r.trim() + r.padStart(3);\nglobalThis.__sbPre = pre;\nexport {};\n",
  );
  await writeFile(
    join(work, "worker.js"),
    "import './shared-prelude.js';\nconst app = r => r.toUpperCase() + r.trim() + r.padStart(4) + r.slice(1, 2);\n" +
      "console.log(app('ab'), globalThis.__sbPre(' c '), [1, 2].map(x => x + 1).join(','));\nglobalThis.__forkHandler = app;\n",
  );
  await writeFile(join(work, "app.js"), "import './worker.js';\n");
  const out = join(work, "out");
  const compile = Bun.spawnSync(["bun", join(root, "runtime/index.js"), "c", join(work, "app.js"), "-o", out], {
    cwd: work,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(compile.exitCode, new TextDecoder().decode(compile.stderr)).toBe(0);
  const units = await readdir(out);
  const prelude = await readFile(
    join(
      out,
      units.find((f) => f.startsWith("shared-prelude.js."))!,
    ),
    "utf8",
  );
  const worker = await readFile(
    join(
      out,
      units.find((f) => f.startsWith("worker.js."))!,
    ),
    "utf8",
  );
  const main = await readFile(join(out, "porf__main.c"), "utf8");
  // Stock alpha put every one of these into porf__main.c as p__main__23anonymous_1, _1_, _1__, ...
  expect(main).not.toMatch(/^(?:PORF_CC )?jsval p__main__23anonymous_1_*\(/m);
  expect(main).not.toMatch(/^(?:PORF_CC )?jsval p__main__23shared_/m);
  expect(prelude).toMatch(/^(?:PORF_CC )?jsval p_\w+__23shared_trim_0\(jsval r\) \{$/m);
  expect(prelude).toMatch(/^(?:PORF_CC )?jsval p_\w+__23shared_padStart_1\(jsval r, jsval a0\) \{$/m);
  for (const name of ["trim_0", "padStart_1", "toUpperCase_0", "slice_2"])
    expect(worker).toMatch(new RegExp(`^(?:PORF_CC )?jsval p_\\w+__23shared_${name}\\(`, "m"));
  // One copy per unit: the app unit's trim is its own, not a call into the prelude's.
  const preludeUnit = /^(?:PORF_CC )?jsval (p_\w+?)__23shared_trim_0/m.exec(prelude)![1];
  const workerUnit = /^(?:PORF_CC )?jsval (p_\w+?)__23shared_trim_0/m.exec(worker)![1];
  expect(workerUnit).not.toBe(preludeUnit);
  const run = Bun.spawnSync(["bun", join(root, "runtime/index.js"), join(work, "app.js")], {
    cwd: work,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
  expect(new TextDecoder().decode(run.stdout).trim()).toBe("ABab  abb c c  2,3");
}, 180_000);

test("P9: JSON.parse of a large document with wide strings runs on the shipped alpha 24 tree", async () => {
  const root = await patched();
  const work = join(root, "work-p9");
  await mkdir(work);
  await writeFile(
    join(work, "wide.js"),
    [
      "const items = [];",
      'for (let i = 0; i < 12000; i++) items.push({ id: i, name: "naïve 中文 x" + i, tags: ["a", "b"] });',
      "const doc = JSON.stringify(items);",
      "const back = JSON.parse(doc);",
      "console.log(doc.length, back.length, back[11999].name);",
    ].join("\n"),
  );
  const compile = Bun.spawn(
    ["bun", join(root, "runtime/index.js"), "native", join(work, "wide.js"), "-o", join(work, "wide"), "-O0"],
    {
      cwd: work,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await compile.exited, await new Response(compile.stderr).text()).toBe(0);
  const run = Bun.spawn([join(work, "wide")], { stdout: "pipe", stderr: "pipe" });
  const [code, out] = await Promise.all([run.exited, new Response(run.stdout).text()]);
  expect(code).toBe(0);
  expect(out.trim()).toBe("637781 12000 naïve 中文 x11999");
}, 180_000);

test("P14: runtime globals are pinned to the template's set, and a free reference outside it is a compile error", async () => {
  const root = await patched();
  // The shared prelude owns performance (an assignment) and process (a lazy accessor, `Object.defineProperty(globalThis, 'process', ...)`),
  // both P4, the way sproutd's does; the template names MessageEvent.
  const prelude =
    "globalThis.performance = { now() { return 1; }, timeOrigin: 0 };\n" +
    "Object.defineProperty(globalThis, 'process', { get() { return { env: {}, platform: 'linux' }; }, set(v) {}, configurable: true });\n" +
    "globalThis.__sbAnchor = () => [ MessageEvent, global ];\nexport {};\n";
  const compile = async (name: string, body: string, pin?: string[]) => {
    const work = join(root, name);
    await mkdir(work);
    await writeFile(join(work, "shared-prelude.js"), prelude);
    await writeFile(join(work, "worker.js"), `import './shared-prelude.js';\n${body}\n`);
    await writeFile(join(work, "app.js"), "import './worker.js';\n");
    const path = process.env.PATH ?? "";
    const env = pin ? { PATH: path, SB_GLOBALS_PIN: JSON.stringify(pin) } : { PATH: path };
    const out = join(work, "out");
    const run = Bun.spawnSync(["bun", join(root, "runtime/index.js"), "c", join(work, "app.js"), "-o", out], {
      cwd: work,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = new TextDecoder().decode(run.stderr) + new TextDecoder().decode(run.stdout);
    const globals =
      run.exitCode === 0 ? (await readdir(out)).find((f) => f.includes("internal_globals.js")) : undefined;
    return { code: run.exitCode, text, globals: globals ? await readFile(join(out, globals), "utf8") : undefined };
  };
  // The template: its names, in its order, are what the pin records.
  const template = await compile("template", "console.log(typeof global, typeof MessageEvent);");
  expect(template.code, template.text).toBe(0);
  const pin = ["global", "MessageEvent"];
  // Same pinned set whatever the app references first, owned names included: the same globals unit, byte for byte.
  const pinned = await compile("a", "console.log(typeof MessageEvent, typeof global);", pin);
  const owned = await compile(
    "b",
    "console.log(performance.now(), typeof process.stdin, typeof process, typeof global);",
    pin,
  );
  const none = await compile("c", "console.log(1);", pin);
  for (const r of [pinned, owned, none]) expect(r.code, r.text).toBe(0);
  expect(pinned.globals).toBeDefined();
  expect(owned.globals).toBe(pinned.globals!);
  expect(none.globals).toBe(pinned.globals!);
  // A name the template did not install is named in the error.
  const outside = await compile("d", "console.log(typeof MessageChannel);", pin);
  expect(outside.code).not.toBe(0);
  expect(outside.text).toContain("MessageChannel is not available in the shared generation");
  // Without a pin nothing changes: the app installs what it uses.
  const free = await compile("e", "console.log(typeof MessageChannel);");
  expect(free.code, free.text).toBe(0);
}, 180_000);
