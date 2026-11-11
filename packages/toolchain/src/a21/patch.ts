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
 *
 * Alpha 22 (pin.ts) runs the same chain: every pass anchors unchanged on it, plus P8 for the
 * shared dispatch functions its codegen introduces (135fda29).
 */
import { readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { patchCaseMapping, patchRepeatDoubling, patchReplaceAll } from "../patch";
import { patchRegexReplace } from "../strings";
import { A21_PATCH_FINGERPRINT } from "./fingerprint";
import { channelOfTree, pinOfTree } from "./pin";
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
 * P4: a name the shared prelude declares at its top level (`const fetch = ...`) or assigns on
 * `globalThis` anywhere in its body (`globalThis.setTimeout = ...` in an installer it calls at
 * init; the assignment binds every free reference program-wide at run time, checked on alpha 21)
 * is the prelude's own global, so the runtime's is not installed. Restricted to
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
        "    for (const mod of modules.values()) if (/(^|\\/)shared-prelude\\.js$/.test(mod.rel) && !mod.file.startsWith(RUNTIME_ROOT)) {\n" +
        "      for (const st of mod.body) for (const d of st.type === 'VariableDeclaration' ? st.declarations : st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration' ? [ st ] : [])\n" +
        "        if (d.id?.type === 'Identifier') used.delete(d.id.name.replace(/#m\\w+$/, ''));\n" +
        "      // a name the prelude assigns on globalThis anywhere (globalThis.fetch = ..., in an installer it calls at init) is\n" +
        "      // the prelude's too: the assignment binds every free reference to it at run time\n" +
        "      const owned = new Set(); const walk = n => { if (n == null || typeof n !== 'object') return; if (Array.isArray(n)) { for (const x of n) walk(x); return; }\n" +
        "        if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && !n.left.computed && n.left.object.type === 'Identifier' && n.left.object.name === 'globalThis') owned.add(n.left.property.name);\n" +
        "        for (const k in n) if (k !== 'loc' && k !== 'range') walk(n[k]); };\n" +
        "      walk(mod.body); for (const name of owned) used.delete(name);\n" +
        "      // and the members of an owned object (process.stdin when the prelude owns process): the object is the prelude's\n" +
        "      for (const name of owned) for (const dotted of [ ...used ]) if (dotted.startsWith(name + '.')) used.delete(dotted);\n" +
        "    }\n",
    ],
  ]);
}

/**
 * P14 (sproutd issue 97; the label P10 was taken by `patchDispatchArgOrder`): the runtime globals an
 * app may use are the ones the template installed, in the template's order. The compiler builds
 * `node/internal/globals.js` from the names the program references, in first-use order, so a free
 * `performance` in app code reordered its installs, and through their import edges the order of
 * every node unit behind them: an `abi_rejected` for an ordinary program. With `SB_GLOBALS_PIN` set
 * (a JSON array of the names, which sproutd's admission passes from the template's metadata) a name
 * outside the array is an error, `<name> is not available in the shared generation`, and the module
 * installs exactly the array, in its order, whatever the program uses. The names the program would
 * install are always left in `globalThis.__sbGlobalsUsed`, which the template build records as the pin.
 */
const P14_MARKER = "sproutboat P14: runtime globals pinned to the template's";
export async function patchGlobalsPin(root: string): Promise<void> {
  await editOnce(resolve(root, "compiler/modules.js"), "the pinned runtime globals (P14)", P14_MARKER, [
    [
      "    if (used.size > 0) {\n      let src = '';\n",
      "    // " +
        P14_MARKER +
        "\n" +
        "    if (process.env.SB_GLOBALS_PIN) {\n" +
        "      const pin = JSON.parse(process.env.SB_GLOBALS_PIN);\n" +
        "      for (const name of used) if (!pin.includes(name)) throw new Error(`${name} is not available in the shared generation`);\n" +
        "      used.clear(); for (const name of pin) used.add(name);\n" +
        "    }\n" +
        "    globalThis.__sbGlobalsUsed = [ ...used ];\n" +
        "    if (used.size > 0) {\n      let src = '';\n",
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

/**
 * P7: the entry file's absolute path, which `node:process` bakes into its unit as `entryFile`
 * (and `argv[1]`), is replaced by the `--sb-entry-file=PATH` pref when given. Every sproutd
 * app compiles in its own directory; without this any template that anchors `process` would
 * differ from every app in the process unit's data.
 */
const P7_MARKER = "sproutboat P7: stable entry path";
export async function patchStableEntryPath(root: string): Promise<void> {
  await editOnce(resolve(root, "compiler/modules.js"), "a stable entry path (P7)", P7_MARKER, [
    [
      "          if (node.name === '__porffor_entry_file' && mod.file.startsWith(RUNTIME_ROOT)) return literal(entryFile);\n",
      "          if (node.name === '__porffor_entry_file' && mod.file.startsWith(RUNTIME_ROOT)) return literal(typeof Prefs.sbEntryFile === 'string' ? Prefs.sbEntryFile : entryFile); // " +
        P7_MARKER +
        "\n",
    ],
  ]);
}

/**
 * P8 (alpha 22 only; 135fda29 "codegen: share dispatch on unknown receivers"): a call or indexed
 * read on a receiver of unknown type is routed through a small synthetic function, one per method
 * and argument count, that alpha 22 generates on first use into unit `main` under the name
 * `#anonymous_1` (then `_1_`, `_1__`, ... in creation order). In the shared-template model that
 * puts an app-created function into the common prefix: the first app to call `r.foo(x)` on an
 * untyped `r` grows K by one and renames every later one, so no two apps agree on the runtime
 * ABI (probe: 2026-11-05, a two-line app moved two functions into porf__main.c). After this pass
 * the function belongs to the unit of the site that asked for it (one copy per unit, deduplicated
 * within the unit, so an app's land in the app module and the prelude's in the prelude unit) and
 * is named after the method and argument count (`#shared_push_1`, `#shared_get`), so its symbol
 * does not depend on creation order.
 */
const P8_MARKER = "sproutboat P8: shared dispatch functions belong to the asking unit";
export async function patchSharedDispatchUnit(root: string): Promise<void> {
  await editOnce(resolve(root, "compiler/codegen.js"), "shared dispatch functions per unit (P8)", P8_MARKER, [
    [
      "let sharedFuncs;\nconst sharedFunc = src => {\n  if (sharedFuncs.has(src)) return sharedFuncs.get(src);\n  const fn = semantic(parse(src)).body[0].expression;\n  fn.body._sharedDispatch = true;\n  fn.strict = true;\n  fn._noClosureEnv = true;\n  const [ func ] = generateFunc({}, fn, true);\n  func.generate();\n  sharedFuncs.set(src, func);\n  return func;\n};\n",
      "let sharedFuncs;\n// " +
        P8_MARKER +
        ", named by method and arity\n" +
        "const sharedFunc = (src, scope, label) => {\n" +
        "  const unit = scope?.internal ? 'builtins' : scope?.unit ?? classUnit ?? 'main';\n" +
        "  const key = unit + '\\0' + src;\n" +
        "  if (sharedFuncs.has(key)) return sharedFuncs.get(key);\n" +
        "  const fn = semantic(parse(src)).body[0].expression;\n" +
        "  fn.body._sharedDispatch = true;\n  fn.strict = true;\n  fn._noClosureEnv = true;\n" +
        "  fn.id = { type: 'Identifier', name: '#shared_' + label.replace(/[^A-Za-z0-9_]/g, c => '_' + c.charCodeAt(0).toString(16)) };\n" +
        "  if (unit !== 'main') fn._unit = unit;\n" +
        "  const [ func ] = generateFunc({}, fn, true);\n  func.generate();\n  sharedFuncs.set(key, func);\n  return func;\n};\n",
    ],
    [
      "        const func = sharedFunc(`((${[ 'r', ...params ].join(', ')}) => r.${protoName}(${params.join(', ')}))`);\n",
      "        const func = sharedFunc(`((${[ 'r', ...params ].join(', ')}) => r.${protoName}(${params.join(', ')}))`, scope, protoName + '_' + params.length);\n",
    ],
    [
      "      const func = sharedFunc('((o, k) => o[k])');\n",
      "      const func = sharedFunc('((o, k) => o[k])', scope, 'get');\n",
    ],
  ]);
}

/**
 * sproutd's collector hooks (sproutd #32, #287 on alpha 19). `porf_gc_quiet` is alpha 21's idle
 * collection on demand (the built-in `porf_gc_idle` only runs after an allocation-triggered cycle,
 * and the worker bridge collects on its own cadence). `porf_gc_seal_heap` closes every open
 * allocation window, drops the partial-page lists and seals every page the template filled
 * before it forks, so a child allocates into fresh pages instead of copy-on-write copies of the
 * template's.
 *
 * A sealed page is immortal in the worker (M6 fix, 2026-11-05): the seal copies the allocation
 * bits into the mark bits of every sealed page and records the template's heap top, and a
 * worker's full collection neither clears nor sets a sealed page's bits nor sweeps it (an object
 * there is "already marked", so marking stops at it). What a template object comes to reference in
 * the worker is found through the card table instead: the write barrier marks the card of an old
 * block it stores into, cards below the template top are never cleared, and every collection scans
 * them (a full one too). Without this every worker's first full collection rewrote the metadata of
 * the whole template heap (56 KiB per worker on a 1.5 MiB template, M6 cause 4), and before the
 * sealed flag the first full collection reopened template pages for allocation (cause 1).
 */
const GC_HOOKS_MARKER = "sproutboat: collector hooks for the fork template";
export async function patchGcHooks(root: string): Promise<void> {
  await editOnce(
    resolve(root, "compiler/render.js"),
    "the collector hooks (quiet, seal, immortal template)",
    GC_HOOKS_MARKER,
    [
      [
        "${st}void porf_gc_idle(void) {\n  if (!porf_gc_busy) return;\n  porf_gc_busy = 0;\n  porf_gc_nursery_bytes = 1048576u;\n  porf_gc_collect(0);\n  porf_gc_discard_free_runs(1u);\n}\n",
        "${st}void porf_gc_idle(void) {\n  if (!porf_gc_busy) return;\n  porf_gc_busy = 0;\n  porf_gc_nursery_bytes = 1048576u;\n  porf_gc_collect(0);\n  porf_gc_discard_free_runs(1u);\n}\n" +
          "// " +
          GC_HOOKS_MARKER +
          "\n" +
          "${st}void porf_gc_quiet(void) {\n  porf_gc_busy = 0;\n  porf_gc_nursery_bytes = 1048576u;\n  porf_gc_collect(0);\n  porf_gc_discard_free_runs(1u);\n}\n" +
          "${st}void porf_gc_seal_heap(void) {\n" +
          "  if (porf_heap_base == 0) return;\n" +
          "  porf_gc_quiet();\n" +
          "  for (i32 ci = 0; ci < PORF_GC_NCLASSES; ci++) {\n" +
          "    struct porf_gc_window* w = &porf_gc_active[ci];\n" +
          "    if (w->end != 0) porf_gc_publish_window(ci);\n" +
          "    w->cur = w->end = w->lo = 0;\n" +
          "    while (porf_gc_partial[ci] != 0) {\n" +
          "      struct porf_gc_page* m = &porf_gc_pages[porf_gc_partial[ci] - 1u];\n" +
          "      porf_gc_partial[ci] = m->aux;\n" +
          "      m->aux = 0;\n" +
          "      m->flags &= (u8)~PORF_GC_PF_PARTIAL;\n" +
          "    }\n" +
          "  }\n" +
          "  // every page in use is sealed (tails too) and its live objects stay marked for the life of every worker\n" +
          "  const u32 top = porf_heap_top >> PORF_GC_SPAGE_SHIFT;\n" +
          "  for (u32 pg = porf_heap_base >> PORF_GC_SPAGE_SHIFT; pg < top; pg++) {\n" +
          "    const u8 k = porf_gc_page_kind[pg];\n" +
          "    if (k == 0u) continue;\n" +
          "    porf_gc_pages[pg].flags |= PORF_GC_PF_SEALED;\n" +
          "    if (k == PORF_GC_PK_SMALL) {\n" +
          "      if ((porf_gc_pages[pg].flags & PORF_GC_PF_TAIL) != 0u) continue;\n" +
          "      u64* blk = porf_gc_meta + ((size_t)pg << 5);\n" +
          "      const u32 npg = porf_gc_cls_pages[porf_gc_pages[pg].cidx];\n" +
          "      for (u32 w = 0; w < npg * 8u; w++) blk[((size_t)w << 2) + PORF_GC_B_MARK] = blk[((size_t)w << 2) + PORF_GC_B_ALLOC];\n" +
          "    } else if (k == PORF_GC_PK_SPAN) porf_gc_bit_set(PORF_GC_B_MARK, porf_gc_gran(pg << PORF_GC_SPAGE_SHIFT));\n" +
          "  }\n" +
          "  porf_gc_template_top = porf_heap_top;\n" +
          "  porf_gc_template_live = porf_gc_last_live_bytes;\n" +
          "}\n" +
          "// cards below the template top are sticky (never cleared): every collection scans them\n" +
          "static void porf_gc_scan_template_cards(void) {\n" +
          "  const u32 c_lo = porf_heap_base >> 9;\n" +
          "  const u32 c_hi = porf_gc_template_top >> 9;\n" +
          "  for (u32 cw = c_lo & ~7u; cw < c_hi; cw += 8u) {\n" +
          "    u64 w8;\n" +
          "    memcpy(&w8, porf_gc_cards + cw, 8);\n" +
          "    if (w8 == 0) continue;\n" +
          "    for (u32 j = 0; j < 8u; j++) {\n" +
          "      const u32 c = cw + j;\n" +
          "      if (c < c_lo || c >= c_hi || porf_gc_cards[c] == 0) continue;\n" +
          "      porf_gc_scan_card(c);\n" +
          "      porf_gc_drain_mark_queue();\n" +
          "    }\n" +
          "  }\n" +
          "}\n",
      ],
      // A sealed page (every page the template filled) is never reopened for allocation: a worker's
      // objects go to fresh pages instead of copy-on-write copies of template pages that hold a few
      // free slots (alpha 19's PORF_GC_PF_SEALED, sproutd #32). Without it the worker's first full
      // collection rebuilt the partial lists from the template's pages and every request after that
      // copied one template page per size class (measured 2026-11-05 on romeo: 140 KiB of a worker's
      // 332 KiB private arena after 21 requests). A page a worker claims resets its flags
      // (refill_window, span_alloc), so a sealed page whose objects all die is released like any other.
      ["#define PORF_GC_PF_TAIL 8u\n", "#define PORF_GC_PF_TAIL 8u\n#define PORF_GC_PF_SEALED 16u\n"],
      [
        "static u32 porf_gc_partial[PORF_GC_NCLASSES];\n",
        "static u32 porf_gc_partial[PORF_GC_NCLASSES];\n// the fork template's heap top and live bytes at the seal (0: no template)\nstatic u32 porf_gc_template_top = 0;\nstatic u64 porf_gc_template_live = 0;\n",
      ],
      [
        "static int porf_gc_install_run(i32 ci, u32 pg) {\n",
        "static int porf_gc_install_run(i32 ci, u32 pg) {\n  if ((porf_gc_pages[pg].flags & PORF_GC_PF_SEALED) != 0u) return 0;\n",
      ],
      [
        "static void porf_gc_partial_push(u32 pg) {\n  struct porf_gc_page* m = &porf_gc_pages[pg];\n  if ((m->flags & PORF_GC_PF_PARTIAL) != 0u) return;",
        "static void porf_gc_partial_push(u32 pg) {\n  struct porf_gc_page* m = &porf_gc_pages[pg];\n  if ((m->flags & (PORF_GC_PF_PARTIAL | PORF_GC_PF_SEALED)) != 0u) return;",
      ],
      // a raw mark of an already-marked (template) block must not write its metadata page
      [
        "  if (porf_gc_minor_mode && porf_gc_bit(PORF_GC_B_YOUNG, g) == 0u) return;\n  porf_gc_bit_set(PORF_GC_B_MARK, g);\n}\n",
        "  if (porf_gc_minor_mode && porf_gc_bit(PORF_GC_B_YOUNG, g) == 0u) return;\n  if (porf_gc_bit(PORF_GC_B_MARK, g) == 0u) porf_gc_bit_set(PORF_GC_B_MARK, g);\n}\n",
      ],
      // marking stops at a sealed template block: it is immortal and its references into the worker come
      // through its cards, so neither its kind nor its mark bit is rewritten (an object referenced under
      // another type than its recorded kind would otherwise be reclassified, and its metadata page copied)
      [
        "  if (porf_gc_is_block_start(body)) {\n    // skip header reads for old or already-marked blocks\n    const u32 g = porf_gc_gran(body);\n",
        "  if (porf_gc_is_block_start(body)) {\n    if (porf_gc_template_top != 0 && (u32)body < porf_gc_template_top && (porf_gc_pages[(u32)body >> PORF_GC_SPAGE_SHIFT].flags & PORF_GC_PF_SEALED) != 0u) return;\n    // skip header reads for old or already-marked blocks\n    const u32 g = porf_gc_gran(body);\n",
      ],
      // a kind or mark already in place is not stored again: a same-value store still copies a template
      // metadata page into the worker (the template's cards are rescanned by every collection)
      [
        "  } else return;\n  porf_gc_kinds[porf_gc_gran(body)] = (u8)kind;\n}\n",
        "  } else return;\n  if (porf_gc_kinds[porf_gc_gran(body)] != (u8)kind) porf_gc_kinds[porf_gc_gran(body)] = (u8)kind;\n}\n",
      ],
      [
        "static inline void porf_gc_set_marked_type(i32 body, i32 type) {\n  porf_gc_bit_set(PORF_GC_B_MARK, porf_gc_gran(body));\n  porf_gc_kinds[porf_gc_gran(body)] = (u8)type;\n}\n",
        "static inline void porf_gc_set_marked_type(i32 body, i32 type) {\n  if (porf_gc_bit(PORF_GC_B_MARK, porf_gc_gran(body)) == 0u) porf_gc_bit_set(PORF_GC_B_MARK, porf_gc_gran(body));\n  if (porf_gc_kinds[porf_gc_gran(body)] != (u8)type) porf_gc_kinds[porf_gc_gran(body)] = (u8)type;\n}\n",
      ],
      [
        "  } else return;\n  porf_gc_kinds[p >> 4] = (u8)type;\n}\n",
        "  } else return;\n  if (porf_gc_kinds[p >> 4] != (u8)type) porf_gc_kinds[p >> 4] = (u8)type;\n}\n",
      ],
      // minor collections keep the template's cards
      [
        "      porf_gc_cards[c] = porf_gc_scan_young_seen;\n",
        "      porf_gc_cards[c] = c < (porf_gc_template_top >> 9) ? 1u : porf_gc_scan_young_seen;\n",
      ],
      // a full collection: sealed pages keep their marks; the rest of the heap clears page by page below the template top and by range above it
      [
        "    if (porf_gc_alias_lo < porf_heap_top && porf_gc_alias_hi > porf_heap_base) {\n      porf_gc_clear_marks(porf_heap_base, porf_gc_alias_lo);\n      porf_gc_clear_marks(porf_gc_alias_hi, porf_heap_top);\n    } else porf_gc_clear_marks(porf_heap_base, porf_heap_top);\n",
        "    const u32 clear_lo = porf_gc_template_top != 0 && porf_gc_template_top < porf_heap_top ? porf_gc_template_top : porf_gc_template_top != 0 ? porf_heap_top : porf_heap_base;\n" +
          "    for (u32 pg = porf_heap_base >> PORF_GC_SPAGE_SHIFT; pg < (clear_lo >> PORF_GC_SPAGE_SHIFT); pg++)\n" +
          "      if (porf_gc_page_kind[pg] != 0u && (porf_gc_pages[pg].flags & PORF_GC_PF_SEALED) == 0u) porf_gc_clear_marks(pg << PORF_GC_SPAGE_SHIFT, (pg + 1u) << PORF_GC_SPAGE_SHIFT);\n" +
          "    if (porf_gc_alias_lo < porf_heap_top && porf_gc_alias_hi > clear_lo) {\n      if (porf_gc_alias_lo > clear_lo) porf_gc_clear_marks(clear_lo, porf_gc_alias_lo);\n      porf_gc_clear_marks(porf_gc_alias_hi, porf_heap_top);\n    } else porf_gc_clear_marks(clear_lo, porf_heap_top);\n",
      ],
      [
        "  porf_gc_mark_global_roots();\n  porf_gc_drain_mark_queue();\n  if (minor) porf_gc_scan_cards();\n",
        "  porf_gc_mark_global_roots();\n  porf_gc_drain_mark_queue();\n  if (minor) porf_gc_scan_cards();\n  else if (porf_gc_template_top != 0) porf_gc_scan_template_cards();\n",
      ],
      // the full sweep skips sealed pages (all live, never reopened) and counts the template's live bytes once
      [
        "      if (k == PORF_GC_PK_SMALL) {\n        if ((porf_gc_pages[pg].flags & PORF_GC_PF_TAIL) != 0u) continue;\n        porf_gc_sweep_page_small(pg, 0, &promoted, &live_bytes);\n      } else if (k == PORF_GC_PK_SPAN) porf_gc_sweep_span(pg, 0, &promoted, &live_bytes);\n    }\n    porf_gc_last_live_bytes = live_bytes;\n",
        "      if ((porf_gc_pages[pg].flags & PORF_GC_PF_SEALED) != 0u) continue;\n      if (k == PORF_GC_PK_SMALL) {\n        if ((porf_gc_pages[pg].flags & PORF_GC_PF_TAIL) != 0u) continue;\n        porf_gc_sweep_page_small(pg, 0, &promoted, &live_bytes);\n      } else if (k == PORF_GC_PK_SPAN) porf_gc_sweep_span(pg, 0, &promoted, &live_bytes);\n    }\n    live_bytes += porf_gc_template_live;\n    porf_gc_last_live_bytes = live_bytes;\n",
      ],
      // the template's cards stay
      [
        "    memset(porf_gc_cards + (porf_heap_base >> 9), 0, (size_t)((porf_heap_top - porf_heap_base) >> 9) + 1);\n",
        "    if (porf_gc_template_top < porf_heap_top) memset(porf_gc_cards + ((porf_gc_template_top > porf_heap_base ? porf_gc_template_top : porf_heap_base) >> 9), 0, (size_t)((porf_heap_top - (porf_gc_template_top > porf_heap_base ? porf_gc_template_top : porf_heap_base)) >> 9) + 1);\n",
      ],
      [
        "${st}i64 porf_gc_idle_due(void) { return -1; }\n${st}void porf_gc_idle(void) {}\n",
        "${st}i64 porf_gc_idle_due(void) { return -1; }\n${st}void porf_gc_idle(void) {}\n${st}void porf_gc_quiet(void) {}\n${st}void porf_gc_seal_heap(void) {}\n",
      ],
    ],
  );
}

/**
 * The shared megamorphic inline cache (`icMega`, 4,096 entries of 20 bytes, hashed by shape and
 * key) is a zero-filled 80 KiB block the template allocates; a worker's misses write entries all
 * over it, so the first request copied most of its 20 pages per worker (M6 cause 3). The template
 * freezes it after its warm-up (build/a21/prelude-dispatch.js `__sbTemplateWarm`): workers read
 * the template's entries and never write one. A frozen miss costs what alpha 19 paid at every
 * site: the hash lookup.
 */
const IC_MEGA_MARKER = "sproutboat: frozen megamorphic cache";
export async function patchIcMegaFreeze(root: string): Promise<void> {
  await editOnce(
    resolve(root, "compiler/builtins/_internal_object.ts"),
    "the megamorphic cache freeze",
    IC_MEGA_MARKER,
    [
      [
        "let icMega: i32 = 0;\n",
        "let icMega: i32 = 0;\n// " +
          IC_MEGA_MARKER +
          "\nlet icMegaFrozen: i32 = 0;\nexport const __Porffor_object_icFreezeMega = (): void => {\n  icMegaFrozen = 1;\n};\n",
      ],
      [
        "export const __Porffor_object_icStoreMega = (shape: i32, hash: i32, holder: i32, i: i32, epoch: i32): void => {\n  if (icMega == 0) {\n",
        "export const __Porffor_object_icStoreMega = (shape: i32, hash: i32, holder: i32, i: i32, epoch: i32): void => {\n  if (icMegaFrozen != 0) return;\n  if (icMega == 0) {\n",
      ],
    ],
  );
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

/**
 * P9: `JSON.parse` of a string with a character past Latin-1 (or a `\u` escape past it) allocates
 * its UTF-16 output as `(len - start) * 2` bytes, where `len` is the length of the whole document, not
 * of the string: every wide string in a 400 KB document asks for 800 KB, and a document with a few
 * thousand of them dies (signal 138/139 on alpha 22, pristine and patched; `naïve 中文` in 6,000
 * objects of a 316 KB document reproduces it, Latin-1-only documents of any size do not). The string
 * is scanned to its closing quote first and the output sized by that. Found by the standalone port
 * (sproutd-alpha22-standalone-port.md); upstream proposal (g) drafted there.
 */
const JSON_WIDE_MARKER = "sproutboat P9: a wide JSON string is sized by its own length";
export async function patchJsonWideStringBound(root: string): Promise<void> {
  await editOnce(resolve(root, "compiler/builtins/json.ts"), "JSON.parse wide string bound", JSON_WIDE_MARKER, [
    [
      "export const __Porffor_json_parseWideString = (text: bytestring, start: i32, posPtr: i32, len: i32): string => {\n  const out: string = Porffor.malloc(6 + (len - start) * 2);\n",
      "export const __Porffor_json_parseWideString = (text: bytestring, start: i32, posPtr: i32, len: i32): string => {\n" +
        "  // " +
        JSON_WIDE_MARKER +
        "\n" +
        "  let end: i32 = start;\n" +
        "  while (end < len) {\n" +
        "    const c: i32 = text.charCodeAt(end);\n" +
        "    if (c == 34) break;\n" +
        "    end += c == 92 ? 2 : 1;\n" +
        "  }\n" +
        "  const out: string = Porffor.malloc(6 + (end - start) * 2);\n",
    ],
  ]);
}

/**
 * `node:process` reads `porf_argv[i]` and `environ[i]` at its init with no null check: a host that
 * starts the runtime with no argv, or that cleared its environment (sproutd's fork template runs
 * after clearenv(), so `environ` is NULL), crashes before the first module runs.
 */
const PROCESS_TABLES_MARKER = "sproutboat: null argv and environ";
export async function patchProcessNullTables(root: string): Promise<void> {
  await editOnce(
    resolve(root, "runtime/node/process.js"),
    "null argv and environ in node:process",
    PROCESS_TABLES_MARKER,
    [
      [
        "  Porffor.c`out = porf_argv[(i32)porf_jv_val(i)] ? porf_node_cstr(porf_argv[(i32)porf_jv_val(i)]) : JV_UNDEFINED;`;\n",
        "  Porffor.c`out = porf_argv && porf_argv[(i32)porf_jv_val(i)] ? porf_node_cstr(porf_argv[(i32)porf_jv_val(i)]) : JV_UNDEFINED;`; // " +
          PROCESS_TABLES_MARKER +
          "\n",
      ],
      [
        "  Porffor.c`out = environ[(i32)porf_jv_val(i)] ? porf_node_cstr(environ[(i32)porf_jv_val(i)]) : JV_UNDEFINED;`;\n",
        "  Porffor.c`out = environ && environ[(i32)porf_jv_val(i)] ? porf_node_cstr(environ[(i32)porf_jv_val(i)]) : JV_UNDEFINED;`;\n",
      ],
    ],
  );
}

/**
 * Per-request CPU (sproutd design 02, the alpha 19 toolchain's async-context.ts): the thread CPU
 * time each request has used, summed over the slices in which it ran. The current request is a
 * small id (slot and generation) that rides with the async context alpha 21 already keeps: a
 * promise reaction records it when it is made (a new u32 at offset 48, so a reaction is 56
 * bytes) and it becomes current when the reaction runs; the queue running dry resets it. The
 * prelude's timers record and restore it themselves (build/a21/prelude-preamble.js). The clock
 * is read only when the request changes.
 */
const CPU_MARKER = "sproutboat: per-request cpu";
const CPU_DEFS =
  "#define PORF_CPU_SLOTS 256\n" +
  "static u32 porf_cpu_cur = 0;\n" +
  "static double porf_cpu_last_ns = 0;\n" +
  "static double porf_cpu_acc[PORF_CPU_SLOTS];\n" +
  "static u16 porf_cpu_gen[PORF_CPU_SLOTS];\n" +
  "static u8 porf_cpu_used[PORF_CPU_SLOTS];\n" +
  "static u16 porf_cpu_next_gen = 0;\n" +
  "static u32 porf_cpu_next_slot = 0;\n" +
  "static inline double porf_cpu_now_ns(void) { struct timespec ts; clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts); return (double)ts.tv_sec * 1e9 + (double)ts.tv_nsec; }\n" +
  "static inline int porf_cpu_live(u32 id) { const u32 i = id & 255u; return id != 0 && porf_cpu_used[i] && porf_cpu_gen[i] == (u16)(id >> 8); }\n" +
  "static void porf_cpu_switch(u32 next) {\n" +
  "  if (next == porf_cpu_cur) return;\n" +
  "  const double t = porf_cpu_now_ns();\n" +
  "  if (porf_cpu_live(porf_cpu_cur)) porf_cpu_acc[porf_cpu_cur & 255u] += t - porf_cpu_last_ns;\n" +
  "  porf_cpu_last_ns = t;\n" +
  "  porf_cpu_cur = next;\n" +
  "}\n" +
  "static u32 porf_cpu_begin(void) {\n" +
  "  for (u32 k = 0; k < PORF_CPU_SLOTS; k++) {\n" +
  "    const u32 i = (porf_cpu_next_slot + k) & 255u;\n" +
  "    if (porf_cpu_used[i]) continue;\n" +
  "    porf_cpu_next_slot = i + 1u;\n" +
  "    if (++porf_cpu_next_gen == 0) porf_cpu_next_gen = 1;\n" +
  "    porf_cpu_used[i] = 1; porf_cpu_gen[i] = porf_cpu_next_gen; porf_cpu_acc[i] = 0;\n" +
  "    const u32 id = i | ((u32)porf_cpu_next_gen << 8);\n" +
  "    porf_cpu_switch(id);\n" +
  "    return id;\n" +
  "  }\n" +
  "  return 0;\n" +
  "}\n" +
  "static double porf_cpu_read_ms(u32 id) {\n" +
  "  if (!porf_cpu_live(id)) return -1.0;\n" +
  "  if (porf_cpu_cur == id) { const double t = porf_cpu_now_ns(); porf_cpu_acc[id & 255u] += t - porf_cpu_last_ns; porf_cpu_last_ns = t; }\n" +
  "  return porf_cpu_acc[id & 255u] / 1e6;\n" +
  "}\n" +
  "static void porf_cpu_end(u32 id) {\n" +
  "  if (!porf_cpu_live(id)) return;\n" +
  "  if (porf_cpu_cur == id) porf_cpu_switch(0);\n" +
  "  porf_cpu_used[id & 255u] = 0;\n" +
  "}\n" +
  "static inline u32 porf_cpu_current(void) { return porf_cpu_cur; }\n";
export async function patchCpuStamp(root: string): Promise<void> {
  await editOnce(resolve(root, "compiler/render.js"), "the per-request cpu stamp (render)", CPU_MARKER, [
    [
      "#define PORF_REACTION_CONTEXT 40\n#define PORF_REACTION_SIZE 48\n",
      "#define PORF_REACTION_CONTEXT 40\n#define PORF_REACTION_CPU 48\n#define PORF_REACTION_SIZE 56\n",
    ],
    [
      "static jsbits porf_async_context = JV_UNDEFINED_BITS;\n",
      "static jsbits porf_async_context = JV_UNDEFINED_BITS;\n// " + CPU_MARKER + "\n" + CPU_DEFS,
    ],
    // the coroutine reaction constructor in C
    [
      "  *(jsbits*)(MEM + reaction + PORF_REACTION_CONTEXT) = porf_async_context;\n  porf_gc_barrier(reaction, PORF_GC_KIND_PROMISE_REACTION);\n  return reaction;\n",
      "  *(jsbits*)(MEM + reaction + PORF_REACTION_CONTEXT) = porf_async_context;\n  *(u32*)(MEM + reaction + PORF_REACTION_CPU) = porf_cpu_cur;\n  porf_gc_barrier(reaction, PORF_GC_KIND_PROMISE_REACTION);\n  return reaction;\n",
    ],
    // dequeue: the job's request becomes current; an empty queue resets it
    [
      "static u32 porf_promise_dequeue_job(void) {\n  if (porf_promise_job_len == 0) return 0;\n  const u32 reaction = porf_promise_job_queue[porf_promise_job_head];\n",
      "static u32 porf_promise_dequeue_job(void) {\n  if (porf_promise_job_len == 0) { porf_cpu_switch(0); return 0; }\n  const u32 reaction = porf_promise_job_queue[porf_promise_job_head];\n  porf_cpu_switch(*(u32*)(MEM + reaction + PORF_REACTION_CPU));\n",
    ],
  ]);
  await editOnce(resolve(root, "compiler/builtins/promise.ts"), "the per-request cpu stamp (promise)", CPU_MARKER, [
    ["  const out: i32 = Porffor.malloc(48);\n", "  const out: i32 = Porffor.malloc(56); // " + CPU_MARKER + "\n"],
    [
      "  Porffor.c`*(jsbits*)(MEM + (u32)out + PORF_REACTION_CONTEXT) = porf_async_context;\n",
      "  Porffor.c`*(jsbits*)(MEM + (u32)out + PORF_REACTION_CONTEXT) = porf_async_context;\n*(u32*)(MEM + (u32)out + PORF_REACTION_CPU) = porf_cpu_cur;\n",
    ],
  ]);
}

/**
 * P10: a method call on a receiver of unknown type goes through a dispatch function shared per method
 * and argument count (alpha 22), and the call site hands the argument expressions straight to the C
 * call, where their order is unspecified. `x.toString("utf8", index, index += length)` (postgres.js
 * decodes every DataRow value this way) read `index` after the increment on arm64 and returned "". The
 * direct-call paths already evaluate each argument into a local first; this one now does too.
 */
const ARG_ORDER_MARKER = "sproutboat P10: shared dispatch arguments are evaluated in order";
export async function patchDispatchArgOrder(root: string): Promise<void> {
  await editOnce(resolve(root, "compiler/codegen.js"), "shared dispatch argument order (P10)", ARG_ORDER_MARKER, [
    [
      "        return Call(func.index, [ targetTmp, ...args.map(x => coerceValue(generate(scope, x), T.jsval)) ], func.retType);\n",
      "        // " +
        ARG_ORDER_MARKER +
        "\n        return Call(func.index, [ targetTmp, ...args.map(x => reuse(scope, coerceValue(generate(scope, x), T.jsval))) ], func.retType);\n",
    ],
  ]);
}

/**
 * P11: a class declaration that is assigned to (`class SQL {}; (SQL || (SQL = {}))`, TypeScript's
 * namespace merge, which drizzle-orm's sql.js uses) reads its own binding to build the class, but
 * unlike a function declaration never stored the class in it first: the binding stayed null and the
 * program died with "Cannot get property of null" (or read back undefined). A written class is now
 * stored in its binding before the class body runs, as `case 'FunctionDeclaration'` does.
 */
const CLASS_WRITE_MARKER = "sproutboat P11: a written class declaration initialises its binding";
export async function patchClassBindingWrite(root: string): Promise<void> {
  await editOnce(resolve(root, "compiler/codegen.js"), "a reassigned class declaration (P11)", CLASS_WRITE_MARKER, [
    [
      "  const classRoot = reuseNamed(scope, decl._writes ? generate(scope, root) : materializeFunctionValue(scope, func));\n",
      "  // " +
        CLASS_WRITE_MARKER +
        "\n  if (!expr && decl._writes) {\n" +
        "    const global = scope.topLevel;\n" +
        "    allocVar(scope, name, global);\n" +
        "    func.referenced = true;\n" +
        "    setLocalWithType(scope, name, global, materializeFunctionValue(scope, func, false), false, TYPES.function);\n" +
        "    const capture = scope.closureOwnLocals?.[name];\n" +
        "    if (capture && closureBindingNeedsSlot(capture)) mirrorToClosureEnv(scope, name, closureLocalReadNode(name, false));\n" +
        "  }\n" +
        "  const classRoot = reuseNamed(scope, decl._writes ? generate(scope, root) : materializeFunctionValue(scope, func));\n",
    ],
  ]);
}

/**
 * P12: `Date.parse` / `new Date(s)` take only `+HH:mm` offsets in the date-time form. Postgres sends
 * timestamptz text as `2026-11-08 14:48:19.097+00` and drivers send `+0000`; V8 and Bun accept both
 * (and `+HH`), Porffor returned NaN, which breaks drizzle-orm's timestamp mapping. The offset is now
 * `[+-]HH`, `[+-]HHmm` or `[+-]HH:mm`; anything else is still NaN.
 */
const DATE_OFFSET_MARKER = "sproutboat P12: UTC offsets without a colon";
export async function patchDateOffsets(root: string): Promise<void> {
  await editOnce(resolve(root, "compiler/builtins/date.ts"), "colonless Date offsets (P12)", DATE_OFFSET_MARKER, [
    [
      "      if (Porffor.IR.loadU8(ptr + 3, 4) != 58) return NaN; // :\n" +
        "      const offsetH: number = __Porffor_date_digits(ptr + 1, 2, endPtr);\n" +
        "      const offsetM: number = __Porffor_date_digits(ptr + 4, 2, endPtr);\n" +
        "      if (Porffor.fastOr(offsetH > 23, offsetM > 59)) return NaN;\n" +
        "      const offset: number = offsetH * 60 + offsetM;\n" +
        "      if (chr == 43) min -= offset;\n" +
        "        else min += offset;\n" +
        "      local = false;\n" +
        "      ptr += 6;\n",
      "      // " +
        DATE_OFFSET_MARKER +
        ": +HH, +HHmm and +HH:mm\n" +
        "      const offsetH: number = __Porffor_date_digits(ptr + 1, 2, endPtr);\n" +
        "      let offsetM: number = 0;\n" +
        "      ptr += 3;\n" +
        "      if (Porffor.fastAnd(ptr < endPtr, Porffor.IR.loadU8(ptr, 4) == 58)) { // :\n" +
        "        offsetM = __Porffor_date_digits(ptr + 1, 2, endPtr);\n" +
        "        ptr += 3;\n" +
        "      } else if (ptr < endPtr) {\n" +
        "        const next: i32 = Porffor.IR.loadU8(ptr, 4);\n" +
        "        if (Porffor.fastAnd(next >= 48, next <= 57)) {\n" +
        "          offsetM = __Porffor_date_digits(ptr, 2, endPtr);\n" +
        "          ptr += 2;\n" +
        "        }\n" +
        "      }\n" +
        "      if (Porffor.fastOr(offsetH > 23, offsetM > 59)) return NaN;\n" +
        "      const offset: number = offsetH * 60 + offsetM;\n" +
        "      if (chr == 43) min -= offset;\n" +
        "        else min += offset;\n" +
        "      local = false;\n",
    ],
  ]);
}

/**
 * P13: the right operand of `||`, `&&` and `??` runs conditionally, but its assignments updated the
 * compile-time type of a local as if it always ran (the `if` and ternary paths scope them as a branch).
 * In a function, `let o = 1; o || (o = {}); typeof o` answered "object", and the namespace-merge
 * pattern `class SQL {}; (SQL || (SQL = {}))` inside any function (every bundled app body is one)
 * left SQL typed as an object while it held the class: "Cannot get property of null" at startup.
 * The right operand is now generated as a branch.
 */
const LOGIC_BRANCH_MARKER = "sproutboat P13: the right operand of a logical expression is a branch";
export async function patchLogicalBranchInference(root: string): Promise<void> {
  await editOnce(
    resolve(root, "compiler/codegen.js"),
    "logical expression branch inference (P13)",
    LOGIC_BRANCH_MARKER,
    [
      [
        "  emitIf(scope, check(scope, res, getNodeType(scope, decl.left)), () => {\n    if (valueUnused) exprStmt(scope, generate(scope, decl.right, undefined, true));\n      else assign(scope, res, coerceValue(generate(scope, decl.right), T.jsval));\n  });\n",
        "  emitIf(scope, check(scope, res, getNodeType(scope, decl.left)), () => {\n    // " +
          LOGIC_BRANCH_MARKER +
          "\n    inferBranchStart(scope);\n    if (valueUnused) exprStmt(scope, generate(scope, decl.right, undefined, true));\n      else assign(scope, res, coerceValue(generate(scope, decl.right), T.jsval));\n    inferBranchEnd(scope);\n  });\n",
      ],
    ],
  );
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
      manifest.commit === pinOfTree(root).commitFull &&
      manifest.toolchainVersion === TOOLCHAIN_VERSION &&
      manifest.patchFingerprint === A21_PATCH_FINGERPRINT
    );
  } catch {
    return false;
  }
}

/** Every pass, in order, on a pristine alpha 21 or alpha 22 tree at `root` (pin.ts channelOfTree). Idempotent. */
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
  await patchGlobalsPin(root);
  await patchClassUnit(root);
  if (channelOfTree(root) === "alpha-22") await patchSharedDispatchUnit(root); // after P1: it reads classUnit
  await patchStableNames(root);
  await patchUnitLayout(root);
  await patchStableEntryPath(root);
  await patchGcHooks(root);
  await patchCpuStamp(root);
  await patchIcMegaFreeze(root);
  // Group 3: runtime gaps.
  await patchReservedSelect(root);
  await patchResponseStatics(root);
  await patchProcessNullTables(root);
  await patchJsonWideStringBound(root);
  if (channelOfTree(root) === "alpha-22") await patchDispatchArgOrder(root); // alpha 21 has no shared dispatch
  await patchClassBindingWrite(root);
  await patchLogicalBranchInference(root);
  await patchDateOffsets(root);
  // Last: the precompile picks up the builtin edits above.
  await precompileBuiltinsA21(root);
  done.add(root);
}
