import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { A21_PATCH_FINGERPRINT, A21_RELEASED_FINGERPRINT, a21SourceFingerprint } from "./fingerprint";
import {
  ensurePorfforPatchedA21,
  patchClassUnit,
  patchGlobalsPin,
  patchPreludeOwnedGlobals,
  patchReservedSelect,
  patchResponseStatics,
  patchStableEntryPath,
  patchUnitLayout,
} from "./patch";
import { PORFFOR_A21_COMMIT_FULL, PORFFOR_A21_PINS, channelOfTree, pinOfTree, type PorfforA21Channel } from "./pin";

const temporary: string[] = [];
afterAll(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A pristine alpha 21 (or alpha 22) tree from the vendored archive, in a fresh directory. */
async function pristine(channel: PorfforA21Channel = "alpha-21"): Promise<string> {
  // Canonical: a module's unit is named by its path relative to the entry directory, and macOS's
  // /var -> /private/var symlink would otherwise give it the absolute path.
  const root = await realpath(await mkdtemp(join(tmpdir(), "sb-a21-")));
  temporary.push(root);
  const pin = PORFFOR_A21_PINS[channel];
  const archive = resolve(import.meta.dir, "../../vendor", pin.vendoredArchive);
  const digest = new Bun.CryptoHasher("sha256").update(await readFile(archive)).digest("hex");
  expect(digest).toBe(pin.archiveSha256);
  const tar = Bun.spawnSync(["tar", "-xzf", archive, "-C", root, "--strip-components=1"], { stderr: "pipe" });
  expect(tar.exitCode, new TextDecoder().decode(tar.stderr)).toBe(0);
  return root;
}

test("a pass that finds its anchor twice or not at all stops with the pass's name", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-a21-anchor-"));
  temporary.push(root);
  await mkdir(join(root, "compiler"), { recursive: true });
  await writeFile(join(root, "compiler/render.js"), "x\n");
  await expect(patchReservedSelect(root)).rejects.toThrow("the reserved name select");
  await writeFile(
    join(root, "compiler/render.js"),
    "const cReservedNames = new Set([\nconst cReservedNames = new Set([\n",
  );
  await expect(patchReservedSelect(root)).rejects.toThrow("anchor not found once");
  await writeFile(join(root, "compiler/render.js"), "const cReservedNames = new Set([\n  'auto',\n");
  await patchReservedSelect(root);
  const once = await readFile(join(root, "compiler/render.js"), "utf8");
  expect(once).toContain("'select', // sproutboat: glibc select");
  await patchReservedSelect(root);
  expect(await readFile(join(root, "compiler/render.js"), "utf8")).toBe(once);
});

test("the alpha 21 chain applies to the pinned tree, once, and the second run changes nothing", async () => {
  const root = await pristine();
  await ensurePorfforPatchedA21(root);
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
    "compiler/builtins/_internal_object.ts",
    "compiler/builtins_precompiled.js",
  ];
  const first: Record<string, string> = {};
  for (const f of files) first[f] = await readFile(join(root, f), "utf8");
  for (const [f, marker] of [
    ["compiler/codegen.js", "sproutboat P1: class functions stay in their module's unit"],
    ["compiler/codegen.js", "sproutboat P5: stable derived names"],
    ["compiler/codegen.js", "sproutboat P6: inits of app-module globals"],
    ["compiler/modules.js", "sproutboat P6: app-owned modules"],
    ["compiler/modules.js", "sproutboat P4: prelude-declared names override runtime globals"],
    ["compiler/modules.js", "sproutboat P14: runtime globals pinned to the template's"],
    ["compiler/modules.js", "sproutboat P7: stable entry path"],
    ["compiler/render.js", "sproutboat: collector hooks for the fork template"],
    ["compiler/render.js", "static void porf_gc_scan_template_cards(void)"],
    ["compiler/builtins/_internal_object.ts", "sproutboat: frozen megamorphic cache"],
    ["compiler/render.js", "sproutboat: per-request cpu"],
    ["compiler/builtins/promise.ts", "sproutboat: per-request cpu"],
    ["compiler/render.js", "sproutboat P2: app units last, pinned ABI regions"],
    ["compiler/render.js", "sproutboat P3: a unit's segments by content"],
    ["compiler/render.js", "sproutboat P6: app-module globals last"],
    ["compiler/render.js", "sproutboat: glibc select"],
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
    expect(first[f], `${marker} in ${f}`).toContain(marker);
  // The precompile ran after the builtin edits: the table carries the replaceAll rewrite.
  expect(first["compiler/builtins_precompiled.js"]).toContain("replaceAll");
  expect(first["compiler/builtins_precompiled.js"]).toContain("icFreezeMega");
  // Idempotent: a fresh chain on the patched tree (no manifest, so every pass runs) is a no-op.
  const { ensurePorfforPatchedA21: again } = await import(`./patch.ts?${Date.now()}`);
  await again(root);
  for (const f of files) expect(await readFile(join(root, f), "utf8"), f).toBe(first[f]);
}, 120_000);

test("a shared prelude owns fetch and the timers: the worker compile links no network stack", async () => {
  const root = await pristine();
  await ensurePorfforPatchedA21(root);
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
  expect(main).not.toMatch(/^jsval p_\w*__23twice/m);
  // P2: the function-record and name regions sit at the pinned offsets (the image is sparse between them).
  expect(main).toContain("porf_fnrecs");
}, 120_000);

test("P1, P2 and P4 edits are anchored on exact alpha 21 text", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-a21-p-"));
  temporary.push(root);
  await mkdir(join(root, "compiler"), { recursive: true });
  await mkdir(join(root, "runtime/node/internal"), { recursive: true });
  await writeFile(join(root, "compiler/codegen.js"), "const declareClass = (scope, decl) => {\n");
  await expect(patchClassUnit(root)).rejects.toThrow("class functions in their module's unit (P1)");
  await writeFile(join(root, "compiler/render.js"), "  unitOrder.push('main');\n");
  await expect(patchUnitLayout(root)).rejects.toThrow("unit layout (P2, P3, P6)");
  await writeFile(join(root, "compiler/modules.js"), "nothing\n");
  await expect(patchPreludeOwnedGlobals(root)).rejects.toThrow("prelude-owned globals (P4)");
  await expect(patchGlobalsPin(root)).rejects.toThrow("the pinned runtime globals (P14)");
  await expect(patchStableEntryPath(root)).rejects.toThrow("a stable entry path (P7)");
  await writeFile(join(root, "runtime/node/internal/fetch.js"), "class Response {}\n");
  await expect(patchResponseStatics(root)).rejects.toThrow("Response.redirect");
});

test("the alpha 21 fingerprint covers its sources and is as released", async () => {
  expect(A21_PATCH_FINGERPRINT).toMatch(/^[0-9a-f]{12}$/);
  expect(A21_PATCH_FINGERPRINT).toBe(a21SourceFingerprint(import.meta.dir)!);
  expect(a21SourceFingerprint("/nonexistent")).toBeNull();
  expect(PORFFOR_A21_COMMIT_FULL).toMatch(/^[0-9a-f]{40}$/);
  const actual = a21SourceFingerprint(import.meta.dir)!;
  if (process.env.UPDATE_FINGERPRINT && actual !== A21_RELEASED_FINGERPRINT) {
    const file = `${import.meta.dir}/fingerprint.ts`;
    const text = await Bun.file(file).text();
    await Bun.write(
      file,
      text.replace(
        `A21_RELEASED_FINGERPRINT = "${A21_RELEASED_FINGERPRINT}"`,
        `A21_RELEASED_FINGERPRINT = "${actual}"`,
      ),
    );
    return;
  }
  expect(A21_RELEASED_FINGERPRINT, "run UPDATE_FINGERPRINT=1 bun test packages/toolchain/src/a21/patch.test.ts").toBe(
    actual,
  );
});

test("the alpha 22 pin is the alpha 21 chain plus P8, applied once, and the tree tells its own channel", async () => {
  const root = await pristine("alpha-22");
  expect(channelOfTree(root)).toBe("alpha-22");
  expect(pinOfTree(root).commitFull).toBe("a081ebd71177b898b2859298376e3191f088af32");
  await ensurePorfforPatchedA21(root);
  expect(channelOfTree(root)).toBe("alpha-22");
  const codegen = await readFile(join(root, "compiler/codegen.js"), "utf8");
  for (const marker of [
    "sproutboat P1: class functions stay in their module's unit",
    "sproutboat P5: stable derived names",
    "sproutboat P8: shared dispatch functions belong to the asking unit",
    "sharedFunc('((o, k) => o[k])', scope, 'get')",
  ])
    expect(codegen, marker).toContain(marker);
  const render = await readFile(join(root, "compiler/render.js"), "utf8");
  for (const marker of [
    "sproutboat P2: app units last, pinned ABI regions",
    "sproutboat: collector hooks for the fork template",
    "sproutboat: per-request cpu",
    "sproutboat: glibc select",
  ])
    expect(render, marker).toContain(marker);
  expect(await readFile(join(root, "compiler/builtins_precompiled.js"), "utf8")).toContain("icFreezeMega");
  expect(await readFile(join(root, "compiler/builtins/json.ts"), "utf8")).toContain(
    "sproutboat P9: a wide JSON string is sized by its own length",
  );
  // An alpha 21 tree never gets P8 (its codegen has no shared dispatch).
  const a21 = await pristine("alpha-21");
  expect(channelOfTree(a21)).toBe("alpha-21");
  await ensurePorfforPatchedA21(a21);
  expect(await readFile(join(a21, "compiler/codegen.js"), "utf8")).not.toContain("sproutboat P8");
  // Idempotent on alpha 22 too.
  const first = await readFile(join(root, "compiler/codegen.js"), "utf8");
  const { ensurePorfforPatchedA21: again } = await import(`./patch.ts?a22-${Date.now()}`);
  await again(root);
  expect(await readFile(join(root, "compiler/codegen.js"), "utf8")).toBe(first);
}, 180_000);

test("P8: alpha 22's shared dispatch functions sit in the unit that asked, under stable names", async () => {
  const root = await pristine("alpha-22");
  await ensurePorfforPatchedA21(root);
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
  // Stock alpha 22 put every one of these into porf__main.c as p__main__23anonymous_1, _1_, _1__, ...
  expect(main).not.toMatch(/^jsval p__main__23anonymous_1_*\(/m);
  expect(main).not.toMatch(/^jsval p__main__23shared_/m);
  expect(prelude).toMatch(/^jsval p_\w+__23shared_trim_0\(jsval r\) \{$/m);
  expect(prelude).toMatch(/^jsval p_\w+__23shared_padStart_1\(jsval r, jsval a0\) \{$/m);
  for (const name of ["trim_0", "padStart_1", "toUpperCase_0", "slice_2"])
    expect(worker).toMatch(new RegExp(`^jsval p_\\w+__23shared_${name}\\(`, "m"));
  // One copy per unit: the app unit's trim is its own, not a call into the prelude's.
  const preludeUnit = /^jsval (p_\w+?)__23shared_trim_0/m.exec(prelude)![1];
  const workerUnit = /^jsval (p_\w+?)__23shared_trim_0/m.exec(worker)![1];
  expect(workerUnit).not.toBe(preludeUnit);
  const run = Bun.spawnSync(["bun", join(root, "runtime/index.js"), join(work, "app.js")], {
    cwd: work,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
  expect(new TextDecoder().decode(run.stdout).trim()).toBe("ABab  abb c c  2,3");
}, 180_000);

test("P9: JSON.parse of a large document with wide strings runs on patched alpha 22", async () => {
  const root = await pristine("alpha-22");
  await ensurePorfforPatchedA21(root);
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
  const root = await pristine("alpha-22");
  await ensurePorfforPatchedA21(root);
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
