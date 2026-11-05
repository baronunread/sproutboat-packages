/**
 * Idempotent, marker-guarded in-place edits to Porffor's compiler source. Run from the build path,
 * not a `postinstall` hook: package managers block dependency lifecycle scripts by default, so a
 * published `postinstall` would silently not run.
 *
 * Alpha 20 replaced the native-fetch server, the fetch globals, the generated-C GC and the
 * uWebSockets shim this file used to edit, and fixed most of the codegen bugs it worked around.
 * What is left is the set of edits for which a test or program fails on stock alpha 20 (see
 * porffor-alpha20-stageA.md). Each edit is independent and re-applied on every build.
 */
import { readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CASE_LOWER_RUNS, CASE_UPPER_RUNS } from "./case-map";
import {
  NATIVE_BYTES_LAYOUT,
  NATIVE_BYTES_MARKER,
  NATIVE_BYTES_RENDER_ANCHOR,
  NATIVE_BYTES_RENDER_GUARD,
  NATIVE_BYTES_SOURCE,
} from "./native-bytes";
import { patchRegexReplace } from "./strings";
import { PORFFOR_COMMIT_FULL } from "./pin";
import { PATCH_FINGERPRINT } from "./fingerprint";
import { version as TOOLCHAIN_VERSION } from "../package.json" with { type: "json" };

// Extra link inputs and compiler flags for the C the platform links in (SQLite, BearSSL, the
// broker and R2 transfer glue). Alpha 20's `Porffor.link` names libraries in the source; these
// two come from the environment of whoever builds, so they stay.
const LINK_ANCHOR = "        '-lm', // link math.h\n";
const LINK_INJECT =
  "        ...(process.env.SB_EXTRA_LINK ? process.env.SB_EXTRA_LINK.split(' ').filter(Boolean) : []),\n";
const LINK_MARKER = "SB_EXTRA_LINK";
const CFLAGS_ANCHOR = "        ...darwinReleaseCompileArgs,\n";
const CFLAGS_INJECT =
  "        ...(process.env.SB_EXTRA_CFLAGS ? process.env.SB_EXTRA_CFLAGS.split(' ').filter(Boolean) : []),\n";
const CFLAGS_MARKER = "SB_EXTRA_CFLAGS";

// baronunread/sproutboat#237: String.prototype.replaceAll grew its result with
// one __Porffor_strcat per match, and each strcat copies everything so far, so
// a 2.7 MB string with many matches took ~22 s (Node: 17 ms). Collect the
// pieces and join once: Array.prototype.join sizes the result up front and
// copies each piece a single time.
const REPLACE_ALL_EDITS = [
  [
    "  let out: any = __Porffor_string_emptyLike(str);\n  let appendIndex: i32 = 0;\n  let searchIndex: i32 = 0;\n  let matched: boolean = false;",
    "  // sproutboat #237: pieces joined once, not a strcat (full copy) per match.\n  const pieces: any[] = Porffor.array.new(0);\n  let appendIndex: i32 = 0;\n  let searchIndex: i32 = 0;\n  let matched: boolean = false;",
  ],
  [
    "    out = __Porffor_strcat(out, __Porffor_string_substringLike(str, appendIndex, matchIndex));\n    out = __Porffor_strcat(out, __Porffor_string_applyReplacer(str, match, matchIndex, replaceValue));",
    "    Porffor.array.fastPush(pieces, __Porffor_string_substringLike(str, appendIndex, matchIndex));\n    Porffor.array.fastPush(pieces, __Porffor_string_applyReplacer(str, match, matchIndex, replaceValue));",
  ],
  [
    "  if (!matched) return str;\n  return __Porffor_strcat(out, __Porffor_string_substringLike(str, appendIndex, thisLen));\n};",
    "  if (!matched) return str;\n  Porffor.array.fastPush(pieces, __Porffor_string_substringLike(str, appendIndex, thisLen));\n  return Porffor.callThis(__Array_prototype_join, pieces, '');\n};",
  ],
] as const;
const REPLACE_ALL_MARKER = "sproutboat #237: pieces joined once";

const done = new Set<string>();

export async function patchCompilerArgs(root: string): Promise<void> {
  const file = resolve(root, "compiler/index.js");
  let src = await readFile(file, "utf8");
  let changed = false;
  for (const [marker, anchor, inject, before, what] of [
    [LINK_MARKER, LINK_ANCHOR, LINK_INJECT, true, "extra link args"],
    [CFLAGS_MARKER, CFLAGS_ANCHOR, CFLAGS_INJECT, false, "extra compiler flags"],
  ] as const) {
    if (src.includes(marker)) continue;
    const at = src.indexOf(anchor);
    if (at === -1 || src.split(anchor).length !== 2)
      throw new Error(`could not patch Porffor for ${what}: anchor not found once in ${file}`);
    src = before
      ? src.slice(0, at) + inject + src.slice(at)
      : src.slice(0, at + anchor.length) + inject + src.slice(at + anchor.length);
    changed = true;
  }
  if (changed) await writeFile(file, src);
}

/** #237: linear String.prototype.replaceAll. Precompiled by precompileBuiltins. */
export async function patchReplaceAll(root: string): Promise<void> {
  const file = resolve(root, "compiler/builtins/string.ts");
  let src = await readFile(file, "utf8");
  if (src.includes(REPLACE_ALL_MARKER)) return;
  const start = src.indexOf("export const __Porffor_string_replaceAll = ");
  const end = src.indexOf("export const __String_prototype_replaceAll = ", start);
  if (start < 0 || end < 0) throw new Error(`could not find Porffor's replaceAll in ${file}`);
  let body = src.slice(start, end);
  for (const [anchor, inject] of REPLACE_ALL_EDITS) {
    if (!body.includes(anchor)) throw new Error(`could not patch Porffor's replaceAll: anchor not found in ${file}`);
    body = body.replace(anchor, inject);
  }
  src = src.slice(0, start) + body + src.slice(end);
  await writeFile(file, src);
}

export async function precompileBuiltins(root: string): Promise<void> {
  const table = resolve(root, "compiler/builtins_precompiled.js");
  // Porffor only writes the table when import.meta.url matches argv[1].
  // macOS's /var -> /private/var symlink makes a noncanonical argv[1] skip it.
  const precompile = await realpath(resolve(root, "compiler/precompile.js"));
  const child = Bun.spawn(["bun", precompile], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`could not precompile Porffor's patched builtins: ${stderr || stdout}`);
  if ((await readFile(table)).length === 0) throw new Error(`Porffor precompile produced an empty ${table}`);
}

// sproutd B16: String.prototype.repeat copied the source once per repetition, so
// "ab".repeat(300000) made 300,000 two-byte copies (about 60 MB/s; a proof fixture
// spent 64% of its load time here). Copy once, then double the filled prefix onto
// itself: log2(count) copies. Same for the UTF-16 and Latin-1 variants, which
// share the loop text.
const REPEAT_LOOP =
  "  for (let i: i32 = 0; i < count; i++) {\n" +
  "    Porffor.IR.copy(Porffor.IR.ptr(out) + 4 + i * thisLen, Porffor.IR.ptr(this) + 4, thisLen);\n" +
  "  }\n";
const REPEAT_MARKER = "sproutboat B16: doubling repeat";
const REPEAT_DOUBLING =
  "  // sproutboat B16: doubling repeat\n" +
  "  const total: i32 = thisLen * count;\n" +
  "  if (total > 0) {\n" +
  "    Porffor.IR.copy(Porffor.IR.ptr(out) + 4, Porffor.IR.ptr(this) + 4, thisLen);\n" +
  "    let filled: i32 = thisLen;\n" +
  "    while (filled * 2 <= total) {\n" +
  "      Porffor.IR.copy(Porffor.IR.ptr(out) + 4 + filled, Porffor.IR.ptr(out) + 4, filled);\n" +
  "      filled *= 2;\n" +
  "    }\n" +
  "    if (filled < total) Porffor.IR.copy(Porffor.IR.ptr(out) + 4 + filled, Porffor.IR.ptr(out) + 4, total - filled);\n" +
  "  }\n";

/** B16: doubling String.prototype.repeat. Before the precompile, which compiles it. */
export async function patchRepeatDoubling(root: string): Promise<void> {
  const file = resolve(root, "compiler/builtins/string.ts");
  const src = await readFile(file, "utf8");
  if (src.includes(REPEAT_MARKER)) return;
  if (src.split(REPEAT_LOOP).length !== 3)
    throw new Error(`could not patch Porffor's String.prototype.repeat: anchor not found twice in ${file}`);
  await writeFile(file, src.replaceAll(REPEAT_LOOP, REPEAT_DOUBLING));
}
// String.prototype.toLowerCase/toUpperCase mapped ASCII only ("todo: unicode" upstream), so
// "ÄÖÜ", Greek and Cyrillic came back unchanged, and URL hosts lowercased wrongly (W2).
// Simple one-to-one BMP mappings from case-map.ts, looked up by binary search for units
// >= 128. Latin-1 strings keep their own range (À-Þ, à-þ); one-to-many special casing
// (ß to SS) and Latin-1 µ/ÿ uppercase (which leave Latin-1) are not handled.
const CASE_MARKER = "sproutboat: Unicode case mapping";
const caseLiteral = (runs: string) =>
  "'" + Array.from(runs, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join("") + "'";
const CASE_HELPERS =
  "// sproutboat: Unicode case mapping\n" +
  "export const __Porffor_caseFind = (chr: i32, runs: string): i32 => {\n" +
  "  let lo: i32 = 0, hi: i32 = runs.length / 4 - 1, found: i32 = -1;\n" +
  "  while (lo <= hi) {\n" +
  "    const mid: i32 = (lo + hi) >> 1;\n" +
  "    if (runs.charCodeAt(mid * 4) <= chr) { found = mid; lo = mid + 1; } else hi = mid - 1;\n" +
  "  }\n" +
  "  if (found < 0) return chr;\n" +
  "  const start: i32 = runs.charCodeAt(found * 4);\n" +
  "  if (chr > runs.charCodeAt(found * 4 + 1)) return chr;\n" +
  "  if ((chr - start) % runs.charCodeAt(found * 4 + 3) != 0) return chr;\n" +
  "  return runs.charCodeAt(found * 4 + 2) + (chr - start);\n" +
  "};\n" +
  "export const __Porffor_caseLower = (chr: i32): i32 => __Porffor_caseFind(chr, " +
  caseLiteral(CASE_LOWER_RUNS) +
  ");\n" +
  "export const __Porffor_caseUpper = (chr: i32): i32 => __Porffor_caseFind(chr, " +
  caseLiteral(CASE_UPPER_RUNS) +
  ");\n\n";
const CASE_EDITS: [string, string][] = [
  [
    "    if (chr >= 97) if (chr <= 122) chr -= 32;\n\n    Porffor.IR.storeU16(j, 4, chr);",
    "    if (chr < 128) { if (chr >= 97) if (chr <= 122) chr -= 32; } else chr = __Porffor_caseUpper(chr);\n\n    Porffor.IR.storeU16(j, 4, chr);",
  ],
  [
    "    if (chr >= 65) if (chr <= 90) chr += 32;\n\n    Porffor.IR.storeU16(j, 4, chr);",
    "    if (chr < 128) { if (chr >= 65) if (chr <= 90) chr += 32; } else chr = __Porffor_caseLower(chr);\n\n    Porffor.IR.storeU16(j, 4, chr);",
  ],
  [
    "    if (chr >= 97) if (chr <= 122) chr -= 32;\n\n    Porffor.IR.storeU8(j++, 4, chr);",
    "    if (chr >= 97) { if (chr <= 122) chr -= 32; else if (chr >= 224) if (chr <= 254) if (chr != 247) chr -= 32; }\n\n    Porffor.IR.storeU8(j++, 4, chr);",
  ],
  [
    "    if (chr >= 65) if (chr <= 90) chr += 32;\n\n    Porffor.IR.storeU8(j++, 4, chr);",
    "    if (chr >= 65) { if (chr <= 90) chr += 32; else if (chr >= 192) if (chr <= 222) if (chr != 215) chr += 32; }\n\n    Porffor.IR.storeU8(j++, 4, chr);",
  ],
];

/** Unicode simple case mapping for toLowerCase/toUpperCase. Before the precompile. */
export async function patchCaseMapping(root: string): Promise<void> {
  const file = resolve(root, "compiler/builtins/string.ts");
  let src = await readFile(file, "utf8");
  if (src.includes(CASE_MARKER)) return;
  const at = src.indexOf("export const __String_prototype_toUpperCase = function (this: string) {");
  if (at < 0) throw new Error(`could not patch Porffor's case mapping: anchor not found in ${file}`);
  for (const [anchor, inject] of CASE_EDITS) {
    if (src.split(anchor).length !== 2)
      throw new Error(`could not patch Porffor's case mapping: anchor not found in ${file}`);
    src = src.replace(anchor, inject);
  }
  await writeFile(file, src.slice(0, at) + CASE_HELPERS + src.slice(at));
}

// sproutd links the shared runtime and each app's module as separate shared objects, so
// Porffor's split output declares module globals without `static`, under their JS names.
// A global named like a libc symbol then binds to libc: the structuredClone prelude's
// `clone` made the runtime write a JS value into libc's clone() and every worker crashed
// on start (SEGV_ACCERR). An app's `const hash` or `let search` would do the same.
// Porffor's reserved-name list cannot keep up with libc, so split globals get a prefix;
// Internal __ globals (Porffor's, the prelude's, sproutd's) keep their names: C refers to them.
const SPLIT_GLOBALS_MARKER = "sproutboat: split globals are prefixed";
const SPLIT_GLOBALS_EDITS: [string, string][] = [
  [
    "  const st = split ? '' : 'static ';\n",
    "  const st = split ? '' : 'static ';\n" +
      "  // " +
      SPLIT_GLOBALS_MARKER +
      ", so none binds to a libc symbol of the same name\n" +
      "  const gname = n => sanitize(split && !n.startsWith('__') ? 'pg_' + n : n);\n",
  ],
  [
    "      case K.Global:\n        cur.globals[node[N_A]] = true;\n      case K.Local:\n        return [sanitize(node[N_A]), P_PRIM];",
    "      case K.Global:\n        cur.globals[node[N_A]] = true;\n        return [gname(node[N_A]), P_PRIM];\n      case K.Local:\n        return [sanitize(node[N_A]), P_PRIM];",
  ],
  [
    "        emit(`${ind()}${sanitize(node[N_A][N_A])} = ${rx(node[N_B], P_COMMA)};\\n`);",
    "        emit(`${ind()}${node[N_A][N_KIND] === K.Global ? gname(node[N_A][N_A]) : sanitize(node[N_A][N_A])} = ${rx(node[N_B], P_COMMA)};\\n`);",
  ],
  [
    "            ? `${sanitize(update[N_A][N_A])} = ${rx(update[N_B], P_COMMA)}`",
    "            ? `${update[N_A][N_KIND] === K.Global ? gname(update[N_A][N_A]) : sanitize(update[N_A][N_A])} = ${rx(update[N_B], P_COMMA)}`",
  ],
  [
    "    const t = sanitize(target[N_A]);",
    "    const t = target[N_KIND] === K.Global ? gname(target[N_A]) : sanitize(target[N_A]);",
  ],
  ["${st}${CT[g.type]} ${sanitize(g.name)}", "${st}${CT[g.type]} ${gname(g.name)}"],
  ["      const name = sanitize(g.name);", "      const name = gname(g.name);"],
  ["const buckets = sanitize(g.name.replace(", "const buckets = gname(g.name.replace("],
  ["const bucketsCap = sanitize(g.name.replace(", "const bucketsCap = gname(g.name.replace("],
  [
    "text.push(`extern ${CT[globalTypes[x]]} ${sanitize(x)};\\n`);",
    "text.push(`extern ${CT[globalTypes[x]]} ${gname(x)};\\n`);",
  ],
];

/** Split (shared-object) output prefixes module globals, so none binds to libc. */
export async function patchSplitGlobals(root: string): Promise<void> {
  const file = resolve(root, "compiler/render.js");
  let src = await readFile(file, "utf8");
  if (src.includes(SPLIT_GLOBALS_MARKER)) return;
  for (const [anchor, inject] of SPLIT_GLOBALS_EDITS) {
    if (src.split(anchor).length !== 2)
      throw new Error(`could not patch Porffor's split globals: anchor not found in ${file}`);
    src = src.replace(anchor, inject);
  }
  await writeFile(file, src);
}
// navigator.userAgent is a frozen "Porffor/<version>". workerd's is "Cloudflare-Workers", and pg
// chooses its Workers socket code on that exact string, so the prelude sets it from the compatibility
// date that has connect() (__sbSetCompat). That needs the property to be writable.
const NAVIGATOR_MARKER = "sproutboat: navigator is writable";
const NAVIGATOR_ANCHOR =
  "      writable: false,\n      enumerable: true,\n      configurable: false\n    }, {\n      userAgent:";
const NAVIGATOR_INJECT =
  "      writable: true, // " +
  NAVIGATOR_MARKER +
  "\n      enumerable: true,\n      configurable: true\n    }, {\n      userAgent:";

export async function patchNavigatorWritable(root: string): Promise<void> {
  const file = resolve(root, "compiler/builtins.js");
  const src = await readFile(file, "utf8");
  if (src.includes(NAVIGATOR_MARKER)) return;
  if (src.split(NAVIGATOR_ANCHOR).length !== 2)
    throw new Error(`could not patch Porffor's navigator: anchor not found in ${file}`);
  await writeFile(
    file,
    src.replace(NAVIGATOR_ANCHOR, () => NAVIGATOR_INJECT),
  );
}
async function patchedByThisVersion(root: string): Promise<boolean> {
  try {
    // SAFETY: private manifest written by ensurePorffor; only three fields are read.
    const manifest = JSON.parse(await readFile(resolve(root, ".sproutboat-complete"), "utf8")) as {
      commit?: string;
      toolchainVersion?: string;
      patchFingerprint?: string;
    };
    return (
      manifest.commit === PORFFOR_COMMIT_FULL &&
      manifest.toolchainVersion === TOOLCHAIN_VERSION &&
      manifest.patchFingerprint === PATCH_FINGERPRINT
    );
  } catch {
    return false;
  }
}

/** Lazy native bytes primitives; no generated C changes without a reference. */
export async function patchNativeBytes(root: string): Promise<void> {
  const file = resolve(root, "compiler/render.js");
  const builtin = resolve(root, "compiler/builtins/sproutboat-native-bytes.ts");
  const src = await readFile(file, "utf8");
  const layout = await readFile(resolve(root, "compiler/builtins/typedarray.js"), "utf8");
  const buffers = await readFile(resolve(root, "compiler/builtins/arraybuffer.ts"), "utf8");
  if (
    !layout.includes(NATIVE_BYTES_LAYOUT) ||
    !buffers.includes("// maxByteLength -1 for fixed length, -2 for immutable")
  )
    throw new Error("could not patch Porffor native bytes v1: typed-array layout changed");
  if (src.split(NATIVE_BYTES_RENDER_ANCHOR).length !== 2)
    throw new Error(`could not patch Porffor native bytes v1: renderer anchor changed in ${file}`);
  if (src.includes(NATIVE_BYTES_MARKER) && src.split(NATIVE_BYTES_RENDER_GUARD).length !== 2)
    throw new Error(`could not patch Porffor native bytes v1: renderer guard changed in ${file}`);
  let existing: string | null = null;
  try {
    existing = await readFile(builtin, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (existing !== null && existing !== NATIVE_BYTES_SOURCE)
    throw new Error(`could not patch Porffor native bytes v1: unexpected builtin contents in ${builtin}`);
  if (!src.includes(NATIVE_BYTES_MARKER))
    await writeFile(
      file,
      src.replace(NATIVE_BYTES_RENDER_ANCHOR, NATIVE_BYTES_RENDER_GUARD + NATIVE_BYTES_RENDER_ANCHOR),
    );
  if (existing === null) await writeFile(builtin, NATIVE_BYTES_SOURCE);
}

export async function ensurePorfforPatched(root: string): Promise<void> {
  if (done.has(root)) return;
  if (await patchedByThisVersion(root)) {
    done.add(root);
    return;
  }
  await patchCompilerArgs(root);
  await patchNavigatorWritable(root);
  await patchNativeBytes(root);
  await patchReplaceAll(root);
  await patchRepeatDoubling(root);
  await patchCaseMapping(root);
  await patchRegexReplace(root);
  // Last: the precompile picks up the string edits above.
  await precompileBuiltins(root);
  done.add(root);
}
