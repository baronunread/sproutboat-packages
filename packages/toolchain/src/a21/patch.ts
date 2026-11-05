/**
 * The Porffor alpha 21 patch chain (`ensurePorfforPatchedA21`). A second channel beside
 * `../patch.ts`, which stays the alpha 19 chain every existing caller runs; nothing here is
 * reached unless a caller asks for alpha 21 (sproutd's `--porffor=alpha-21` generation).
 *
 * Alpha 20 replaced the native-fetch server, the fetch globals, the generated-C GC and the
 * uWebSockets shim that most of the alpha 19 chain edited. Of its 50 passes, 7 still have a
 * failing test or program on stock alpha 20/21 (porffor-alpha20-stageA.md, section 1), and they
 * are the first group below. The second group is new: the determinism patches P1 to P6 from the
 * alpha 21 gates (porffor-alpha21-gates.md, section 2), which make the C that the shared runtime
 * prelude compiles to independent of the app compiled with it, so sproutd's template ABI holds
 * across apps. The third group is small gaps in the alpha 21 runtime the corpus hits.
 *
 * Every edit is anchored on exact source text that must occur exactly once, marker-guarded so
 * the chain is idempotent, and re-applied on every build (never a `postinstall`).
 */
import { readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { patchCaseMapping, patchRepeatDoubling, patchReplaceAll } from "../patch";
import { patchRegexReplace } from "../strings";
import { A21_PATCH_FINGERPRINT } from "./fingerprint";
import { PORFFOR_A21_COMMIT_FULL } from "./pin";
import { version as TOOLCHAIN_VERSION } from "../../package.json" with { type: "json" };

type Edit = readonly [anchor: string, replacement: string];

/** Replace each anchor, which must occur exactly once, unless the marker is already in the file. */
async function editOnce(file: string, what: string, marker: string, edits: readonly Edit[]): Promise<void> {
  let src = await readFile(file, "utf8");
  if (src.includes(marker)) return;
  for (const [anchor, replacement] of edits) {
    if (src.split(anchor).length !== 2)
      throw new Error(
        `could not patch Porffor alpha 21 for ${what}: anchor not found once in ${file}: ${anchor.slice(0, 70)}`,
      );
    src = src.replace(anchor, () => replacement);
  }
  if (!src.includes(marker)) throw new Error(`could not patch Porffor alpha 21 for ${what}: marker missing after edit`);
  await writeFile(file, src);
}

// --- group 1: alpha 19 passes that still earn their place ---

// Extra link inputs and compiler flags for the C the platform links in (SQLite, BearSSL, the
// broker and R2 transfer glue). Alpha 21's `Porffor.link` names libraries in the source; these
// two come from the environment of whoever builds, so they stay.
const LINK_MARKER = "SB_EXTRA_LINK";
const CFLAGS_MARKER = "SB_EXTRA_CFLAGS";
export async function patchCompilerArgsA21(root: string): Promise<void> {
  const file = resolve(root, "compiler/index.js");
  let src = await readFile(file, "utf8");
  let changed = false;
  for (const [marker, anchor, inject, before, what] of [
    [
      LINK_MARKER,
      "        '-lm', // link math.h\n",
      "        ...(process.env.SB_EXTRA_LINK ? process.env.SB_EXTRA_LINK.split(' ').filter(Boolean) : []),\n",
      true,
      "extra link args",
    ],
    [
      CFLAGS_MARKER,
      "        ...darwinReleaseCompileArgs,\n",
      "        ...(process.env.SB_EXTRA_CFLAGS ? process.env.SB_EXTRA_CFLAGS.split(' ').filter(Boolean) : []),\n",
      false,
      "extra compiler flags",
    ],
  ] as const) {
    if (src.includes(marker)) continue;
    const at = src.indexOf(anchor);
    if (at === -1 || src.split(anchor).length !== 2)
      throw new Error(`could not patch Porffor alpha 21 for ${what}: anchor not found once in ${file}`);
    src = before
      ? src.slice(0, at) + inject + src.slice(at)
      : src.slice(0, at + anchor.length) + inject + src.slice(at + anchor.length);
    changed = true;
  }
  if (changed) await writeFile(file, src);
}

// navigator.userAgent is a frozen "Porffor/<version>". workerd's is "Cloudflare-Workers", and pg
// chooses its Workers socket code on that exact string, so the prelude sets it from the compatibility
// date that has connect() (__sbSetCompat). That needs the property to be writable.
const NAVIGATOR_MARKER = "sproutboat: navigator is writable";
export async function patchNavigatorWritableA21(root: string): Promise<void> {
  await editOnce(resolve(root, "compiler/builtins.js"), "a writable navigator", NAVIGATOR_MARKER, [
    [
      "      writable: false,\n      enumerable: true,\n      configurable: false\n    }, {\n      userAgent:",
      "      writable: true, // " +
        NAVIGATOR_MARKER +
        "\n      enumerable: true,\n      configurable: true\n    }, {\n      userAgent:",
    ],
  ]);
}

export async function precompileBuiltinsA21(root: string): Promise<void> {
  const table = resolve(root, "compiler/builtins_precompiled.js");
  // Porffor only writes the table when import.meta.url matches argv[1]; macOS's /var -> /private/var
  // symlink makes a noncanonical argv[1] skip it. Alpha 20+ sources use `with { type: 'text' }`
  // imports, which Node rejects, so the precompile runs under bun.
  const precompile = await realpath(resolve(root, "compiler/precompile.js"));
  const child = Bun.spawn(["bun", precompile], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`could not precompile Porffor alpha 21's patched builtins: ${stderr || stdout}`);
  if ((await readFile(table)).length === 0) throw new Error(`Porffor precompile produced an empty ${table}`);
}

// --- group 2: determinism for the shared-template model (P1 to P6, porffor-alpha21-gates.md 2.2 and 2.3) ---

/**
 * What counts as the app in a sproutd compile: every module that is neither Porffor's runtime nor
 * the shared prelude (`shared-prelude.js`, plus the anchor's namespace module `anchor-ns.js`), nor the
 * entry (sproutd's `app.js` only imports the app unit; its top-level code lands in main, and its unit
 * sits before the app's with fixed content). The app unit (`worker.js`) and everything under
 * `node_modules` are the app's.
 * Shared JS text, inserted into modules.js, codegen.js and render.js by the passes below.
 */
const APP_MODULE_RULE = "/(^|\\/)(shared-prelude|anchor-ns)\\.js$/";

/** P1: methods and constructors of a module's classes stay in that module's unit instead of `main`. */
const P1_MARKER = "sproutboat P1: class functions stay in their module's unit";
export async function patchClassUnit(root: string): Promise<void> {
  await editOnce(resolve(root, "compiler/codegen.js"), "class functions in their module's unit (P1)", P1_MARKER, [
    [
      "const declareClass = (scope, decl) => {\n",
      "let classUnit = null; // " +
        P1_MARKER +
        " instead of #main\n" +
        "const declareClass = (scope, decl) => {\n" +
        "  const prev = classUnit; if (decl._unit != null) classUnit = decl._unit; try { return declareClass0(scope, decl); } finally { classUnit = prev; }\n" +
        "};\n" +
        "const declareClass0 = (scope, decl) => {\n",
    ],
    [
      "const generateClass = (scope, decl) => {\n",
      "const generateClass = (scope, decl) => {\n" +
        "  const prevClassUnit = classUnit; if (decl._unit != null) classUnit = decl._unit; try { return generateClass0(scope, decl); } finally { classUnit = prevClassUnit; }\n" +
        "};\n" +
        "const generateClass0 = (scope, decl) => {\n",
    ],
    [
      "    unit: decl._unit ?? decl._hoistedUnit ?? scope.unit,\n",
      "    unit: decl._unit ?? decl._hoistedUnit ?? scope.unit ?? classUnit,\n",
    ],
  ]);
}

/**
 * P6 (modules.js part): the ids of app modules are recorded as they are loaded, and their
 * namespace declarations come after the shared modules' ones, so the template's initializer prefix
 * is app-independent. Exports `appModuleIds` for codegen.js and render.js.
 */
const P6_MODULES_MARKER = "sproutboat P6: app-owned modules";
export async function patchAppModuleIds(root: string): Promise<void> {
  await editOnce(resolve(root, "compiler/modules.js"), "app-owned module ids (P6)", P6_MODULES_MARKER, [
    [
      "export const isEsmSource = (file, src) => {\n",
      "// " +
        P6_MODULES_MARKER +
        ": ids of every module that is neither the runtime's nor the shared prelude's,\n" +
        "// so their globals, inits and namespace bindings can be emitted after the shared ones\n" +
        "export const appModuleIds = new Set();\n" +
        "export const isAppModule = (file, rel, entry) => !entry && !file.startsWith(RUNTIME_ROOT) && !file.startsWith('data:') && !" +
        APP_MODULE_RULE +
        ".test(rel);\n" +
        "export const isEsmSource = (file, src) => {\n",
    ],
    [
      "    mod = { file, rel, src: source, id: hashId(rel), entry, esm: true, exports: new Map(), stars: [], imports: [], deps: [], body: null, nsUsed: false };\n",
      "    mod = { file, rel, src: source, id: hashId(rel), entry, esm: true, exports: new Map(), stars: [], imports: [], deps: [], body: null, nsUsed: false };\n" +
        "    if (isAppModule(file, rel, entry)) appModuleIds.add(mod.id);\n",
    ],
    [
      "  // namespaces declared up front for cycles, filled after the module's last class\n  for (const mod of order) {\n",
      "  // namespaces declared up front for cycles, filled after the module's last class\n" +
        "  // (app modules' declarations after the shared ones: the template's initializer prefix is app-independent)\n" +
        "  for (const mod of [ ...order.filter(m => !appModuleIds.has(m.id)), ...order.filter(m => appModuleIds.has(m.id)) ]) {\n",
    ],
  ]);
}

/**
 * P4: a name the shared prelude declares at its top level (`const fetch = ...`, its own timers
 * and web classes) is the prelude's own global, so the runtime's is not installed. Restricted to
 * `shared-prelude.js`: an app declaring `const process` must not hide the real one from the
 * modules beside it. Without this any free `fetch(` in app code links fetch-client, http, net,
 * dns, uws and libuv into the worker.
 */
const P4_MARKER = "sproutboat P4: prelude-declared names override runtime globals";
export async function patchPreludeOwnedGlobals(root: string): Promise<void> {
  await editOnce(resolve(root, "compiler/modules.js"), "prelude-owned globals (P4)", P4_MARKER, [
    [
      "    usedNames([ ...vmSources.values() ], names, used);\n",
      "    usedNames([ ...vmSources.values() ], names, used);\n" +
        "    // " +
        P4_MARKER +
        "\n" +
        "    for (const mod of modules.values()) if (/(^|\\/)shared-prelude\\.js$/.test(mod.rel) && !mod.file.startsWith(RUNTIME_ROOT))\n" +
        "      for (const st of mod.body) for (const d of st.type === 'VariableDeclaration' ? st.declarations : st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration' ? [ st ] : [])\n" +
        "        if (d.id?.type === 'Identifier') used.delete(d.id.name.replace(/#m\\w+$/, ''));\n",
    ],
  ]);
}

/**
 * P5: names the compiler derives from global function indices become stable. The per-activation
 * function-value cache was `#func_cache_<global index>`, which any app shifts, so the prelude's
 * unit differed byte-wise between apps (442 lines for yaml); the function's name (or source start)
 * is as unique within a scope and app-independent. A class's computed-key global carries its unit
 * so an app's computed keys are attributable to the app.
 * P6 (codegen.js part): app modules' builtin-global inits run after the shared ones.
 */
const P5_MARKER = "sproutboat P5: stable derived names";
export async function patchStableNames(root: string): Promise<void> {
  await editOnce(resolve(root, "compiler/codegen.js"), "stable derived names (P5) and app inits last (P6)", P5_MARKER, [
    ["import { patternNames } from './modules.js';\n", "import { patternNames, appModuleIds } from './modules.js';\n"],
    [
      "  const cache = local(scope, `#func_cache_${func.start ?? func.index}`, T.jsval);\n",
      "  const cache = local(scope, `#func_cache_${func.start ?? func.name}`, T.jsval); // " + P5_MARKER + "\n",
    ],
    [
      "        const keyGlobal = `#class_computed_prop${scope.start ?? scope.index}` + uniqId(scope);\n",
      "        const keyGlobal = `#class_computed_prop_${unitOf(scope)}_${scope.start ?? scope.index}` + uniqId(scope);\n",
    ],
    [
      "  if (builtinGlobalInits.length !== 0) topLevelFunc.body.unshift(...builtinGlobalInits);\n",
      "  // sproutboat P6: inits of app-module globals (namespace objects and the like) go after the shared ones\n" +
        "  { const isApp = n => { const s = JSON.stringify(n); return [ ...appModuleIds ].some(id => s.includes('#m' + id) || s.includes('_' + id + '_') || s.includes('_' + id + '\"')); }; builtinGlobalInits = [ ...builtinGlobalInits.filter(n => !isApp(n)), ...builtinGlobalInits.filter(isApp) ]; }\n" +
        "  if (builtinGlobalInits.length !== 0) topLevelFunc.body.unshift(...builtinGlobalInits);\n",
    ],
  ]);
}

/**
 * P2: app units go last, in their original order, so every shared unit keeps its function-index
 * base, and the module ABI regions sproutd's template script pins are fixed: static data under
 * 1 MiB, function records at 1 MiB, names at 2 MiB, zero data at 4 MiB, under 65,536 functions.
 * P3: each unit's data segments are laid out by content, not by creation order (which follows
 * first use and so depends on the app); P3b: identical immutable byte segments in one unit share
 * one offset, so two equal strings cannot swap places between apps. Static arrays are excluded
 * from the sharing: they are written in place.
 * P6 (render.js part): app modules' globals are declared, and rooted, after the shared ones.
 */
const P2_MARKER = "sproutboat P2: app units last, pinned ABI regions";
export async function patchUnitLayout(root: string): Promise<void> {
  await editOnce(resolve(root, "compiler/render.js"), "unit layout (P2, P3, P6)", P2_MARKER, [
    [
      "import { TYPES, TYPE_NAMES, ITERATOR_TYPES } from './types.js';\n",
      "import { TYPES, TYPE_NAMES, ITERATOR_TYPES } from './types.js';\nimport { appModuleIds } from './modules.js'; // sproutboat P6\n",
    ],
    [
      "  unitOrder.push('main');\n",
      "  unitOrder.push('main');\n" +
        "  // " +
        P2_MARKER +
        "\n" +
        "  { const appIds = (units ?? []).filter(u => appModuleIds.has(u.id)).map(u => u.id).filter(id => unitOrder.includes(id)); for (const id of appIds) unitOrder.splice(unitOrder.indexOf(id), 1); unitOrder.push(...appIds); }\n",
    ],
    [
      "      for (let i = 0; i < data.length; i++) {\n" +
        "        if (dataUnits[i] !== u || zeroed[i] !== zero) continue;\n" +
        "        dataOffsets[i] = off;\n" +
        "        off += align8(data[i].length);\n" +
        "      }\n",
      "      // sproutboat P3: a unit's segments by content, not by creation order (which follows first use, and so the app)\n" +
        "      const ids = [];\n" +
        "      for (let i = 0; i < data.length; i++) if (dataUnits[i] === u && zeroed[i] === zero) ids.push(i);\n" +
        "      const keys = new Map();\n" +
        "      let prevKey = null, prevOff = 0;\n" +
        "      const key = i => { if (!keys.has(i)) { const seg = data[i]; keys.set(i, seg.staticArray ? 'A' + JSON.stringify(seg.staticArray.map(it => it.str !== undefined ? ['s', key(it.str)] : it)) : 'B' + Array.from(seg, b => String.fromCharCode(b)).join('')); } return keys.get(i); };\n" +
        "      if (!zero) ids.sort((x, y) => key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0);\n" +
        "      for (const i of ids) {\n" +
        "        // P3b: identical immutable byte segments (string literals) share one offset, so equal-content ties cannot swap\n" +
        "        if (!zero && !data[i].staticArray && prevKey === key(i)) { dataOffsets[i] = prevOff; continue; }\n" +
        "        dataOffsets[i] = off; prevKey = zero ? null : key(i); prevOff = off;\n" +
        "        off += align8(data[i].length);\n" +
        "      }\n",
    ],
    [
      "  const fnrecBase = off;\n",
      "  if (off >= 1048576) throw new Error('static data exceeds module ABI region');\n  const fnrecBase = 1048576; off = fnrecBase;\n",
    ],
    [
      "  // empty names reuse offset 0",
      "  if (linkFuncs.length >= 65536) throw new Error('function capacity exceeded');\n  off = 2097152;\n  // empty names reuse offset 0",
    ],
    [
      "  const imageEnd = off;\n",
      "  const imageEnd = off;\n  if (off >= 4194304) throw new Error('function names exceed module ABI region');\n  off = 4194304;\n",
    ],
    [
      "  // module globals (top-level JS bindings)\n",
      "  // module globals (top-level JS bindings)\n" +
        "  // sproutboat P6: app-module globals last, so the shared prefix of the declaration and root lists is app-independent\n" +
        "  { const isApp = g => [ ...appModuleIds ].some(id => g.name.includes('#m' + id) || g.name.includes('_' + id + '_') || g.name.endsWith('_' + id)); globals = [ ...globals.filter(g => !isApp(g)), ...globals.filter(isApp) ]; }\n",
    ],
  ]);
}

// --- group 3: alpha 21 runtime gaps the corpus hits ---

/**
 * A top-level binding named `select` fails the C compile on Linux: glibc's sys/select.h declares
 * select() and Porffor's reserved-name list lacks it (porffor-alpha20-stageA.md, section 5).
 */
const SELECT_MARKER = "sproutboat: glibc select";
export async function patchReservedSelect(root: string): Promise<void> {
  await editOnce(resolve(root, "compiler/render.js"), "the reserved name select", SELECT_MARKER, [
    [
      "const cReservedNames = new Set([\n",
      "const cReservedNames = new Set([\n  'select', // " + SELECT_MARKER + ": sys/select.h redeclares it\n",
    ],
  ]);
}

/**
 * `Response.redirect` and `Response.error` are missing from alpha 21's `internal/fetch.js`, which
 * defines only `Response.json`; two corpus apps throw on their redirect branches without them
 * (porffor-alpha21-gates.md 1.3).
 */
const REDIRECT_MARKER = "sproutboat: Response.redirect and Response.error";
export async function patchResponseStatics(root: string): Promise<void> {
  await editOnce(resolve(root, "runtime/node/internal/fetch.js"), "Response.redirect", REDIRECT_MARKER, [
    [
      "    if (!new Headers(init.headers).has('content-type')) response.headers.set('content-type', 'application/json');\n    return response;\n  }\n}\nObject.assign(Response.prototype, bodyMethods);\n",
      "    if (!new Headers(init.headers).has('content-type')) response.headers.set('content-type', 'application/json');\n    return response;\n  }\n\n" +
        "  // " +
        REDIRECT_MARKER +
        "\n" +
        "  static redirect(url, status = 302) {\n" +
        "    status = Number(status);\n" +
        "    if (status !== 301 && status !== 302 && status !== 303 && status !== 307 && status !== 308) throw new RangeError(`Invalid status code ${status}`);\n" +
        "    return new Response(null, { status, headers: { location: new URL(String(url)).href } });\n" +
        "  }\n\n" +
        "  static error() {\n" +
        "    const response = new Response(null, { status: 200 });\n" +
        "    response.status = 0;\n" +
        "    response.type = 'error';\n" +
        "    return response;\n" +
        "  }\n" +
        "}\nObject.assign(Response.prototype, bodyMethods);\n",
    ],
  ]);
}

// --- the chain ---

const done = new Set<string>();

async function patchedByThisVersion(root: string): Promise<boolean> {
  try {
    // SAFETY: private manifest written by the caller that acquires the tree; three fields are read.
    const manifest = JSON.parse(await readFile(resolve(root, ".sproutboat-complete"), "utf8")) as {
      commit?: string;
      toolchainVersion?: string;
      patchFingerprint?: string;
    };
    return (
      manifest.commit === PORFFOR_A21_COMMIT_FULL &&
      manifest.toolchainVersion === TOOLCHAIN_VERSION &&
      manifest.patchFingerprint === A21_PATCH_FINGERPRINT
    );
  } catch {
    return false;
  }
}

/** Every pass, in order, on a pristine alpha 21 tree at `root`. Idempotent. */
export async function ensurePorfforPatchedA21(root: string): Promise<void> {
  if (done.has(root)) return;
  if (await patchedByThisVersion(root)) {
    done.add(root);
    return;
  }
  // Group 1: the alpha 19 passes with a failing case on stock alpha 21.
  await patchCompilerArgsA21(root);
  await patchNavigatorWritableA21(root);
  await patchReplaceAll(root);
  await patchRepeatDoubling(root);
  await patchCaseMapping(root);
  await patchRegexReplace(root);
  // Group 2: determinism. modules.js first: codegen.js and render.js import appModuleIds from it.
  await patchAppModuleIds(root);
  await patchPreludeOwnedGlobals(root);
  await patchClassUnit(root);
  await patchStableNames(root);
  await patchUnitLayout(root);
  // Group 3: runtime gaps.
  await patchReservedSelect(root);
  await patchResponseStatics(root);
  // Last: the precompile picks up the builtin edits above.
  await precompileBuiltinsA21(root);
  done.add(root);
}
