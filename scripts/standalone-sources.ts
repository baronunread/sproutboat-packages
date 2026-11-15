#!/usr/bin/env bun
/**
 * The standalone server's vendored sources (`packages/toolchain/src/a21/standalone-server/`): the uWebSockets
 * server shim, the web classes, and the patches the uWebSockets checkout is compiled with.
 *
 *   generate  [--a19-root DIR]   from the patched Porffor alpha 19 tree (the chain that used to produce them) -> files + sources.json
 *   verify    [--a19-root DIR]   regenerate from the alpha 19 chain and compare byte for byte; fetch uWebSockets at the pinned
 *                                commit, apply the vendored patches and compare with the chain's own edits
 *   check                        no git, no network: the files' content hashes against sources.json
 *
 * `generate` and `verify` need the alpha 19 chain (`ensurePorffor()` of the toolchain at the commit that introduced these
 * files); they exist to prove the vendoring changed nothing.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const DIR = join(REPO, "packages/toolchain/src/a21/standalone-server");
const SRC = join(REPO, "packages/toolchain/src");
const MANIFEST = join(DIR, "sources.json");
const END = "// ---- end of provenance header ----\n";
const sha = (d: string | Uint8Array) => createHash("sha256").update(d).digest("hex");
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const body = (text: string) => text.slice(text.indexOf(END) + END.length);
const PATCHES = ["0001-remove-default-404.patch", "0002-shorten-uws-errors.patch", "0003-http10.patch"];

const SHIM_HEADER = (
  m: Origin,
) => `// Vendored source: the uWebSockets server shim of the standalone build (a C++ translation unit).
//
// What it is: the C++ that Porffor alpha 19's compiler generates for a native-fetch server
// (compiler/uwebsockets.js, makeUWebSocketsShimSource() with Prefs.eventLoop on), taken from the alpha 19 tree
// (upstream ${m.porfforCommit.slice(0, 7)}) with sproutboat's patch chain applied (@sproutboat/toolchain ${m.toolchainVersion},
// patch fingerprint ${m.patchFingerprint}): body limit, #156 status lines, #163 x-sb-remote-addr, #176 raw bodies, #195 R2
// transfers, the #236 shim stamp. standalone-shim.ts rewrites it over the alpha 22+ flat bridge at build time.
//
// Why it is here: the standalone build on Porffor alpha 24 serves requests with this shim. It used to acquire a
// whole patched alpha 19 tree only to read it. That tree is gone; this file is maintained here, by hand.
// Equivalence: everything after the marker below is byte for byte what the alpha 19 chain produced (sha256 in
// sources.json, "origin"; the pull request that vendored it records the verify run).
${END}`;
const CLASSES_HEADER = (m: Origin) => `// Vendored source: the web classes of the standalone build.
//
// What it is: Porffor alpha 19's runtime/fetch-globals.js with sproutboat's seven class patches applied
// (@sproutboat/toolchain ${m.toolchainVersion}, patch fingerprint ${m.patchFingerprint}, upstream ${m.porfforCommit.slice(0, 7)}), minus its four
// C-timer functions (the standalone preamble's table replaces them), each class then assigned on globalThis so
// that on alpha 22+ every free reference binds program-wide (P4).
//
// Why it is here: the standalone prelude composes these classes (standalone.ts). It used to acquire a whole
// patched alpha 19 tree only to read them. That tree is gone; this file is maintained here, by hand.
// Equivalence: everything after the marker below is byte for byte what the alpha 19 chain produced (sha256 in
// sources.json, "origin").
${END}`;

interface Origin {
  porfforCommit: string;
  toolchainVersion: string;
  patchFingerprint: string;
}

async function treeHash(dir: string): Promise<string> {
  const { treeSha256 } = await import(join(DIR, "index.ts"));
  return treeSha256(dir);
}

/** The web classes as the toolchain composed them before they were vendored (standalone.ts alpha19WebClasses, verbatim). */
function alpha19WebClasses(alpha19Root: string): string {
  let src = readFileSync(join(alpha19Root, "runtime/fetch-globals.js"), "utf8");
  const timers = src.indexOf("\nfunction setTimeout(");
  const blob = src.indexOf("\nclass Blob {");
  if (timers < 0 || blob < timers) throw new Error("alpha 19 fetch-globals.js: the timer functions moved");
  src = src.slice(0, timers) + "\n" + src.slice(blob);
  const names = [...src.matchAll(/^class ([A-Za-z]+)/gm)].map((m) => m[1]);
  const expected = ["Headers", "Blob", "File", "TextEncoder", "TextDecoder", "URL", "Request", "Response"];
  if (names.join(",") !== expected.join(","))
    throw new Error(`alpha 19 fetch-globals.js: classes are ${names.join(",")}`);
  return (
    "// Alpha 19 web classes: Porffor alpha 19's runtime/fetch-globals.js with the toolchain's patches, so the\n" +
    "// live generation's Headers, Request, Response, Blob, File, URL, TextEncoder and TextDecoder are the\n" +
    "// prelude's own on alpha 22 (@sproutboat/toolchain/a21 standalone.ts).\n" +
    src +
    names.map((n) => `globalThis.${n} = ${n};\n`).join("")
  );
}

async function fromChain(a19Root?: string) {
  const { ensurePorffor } = await import(join(SRC, "acquire.ts"));
  const root = a19Root ?? (await ensurePorffor());
  // SAFETY: the alpha 19 compiler reads its flags from a plain Prefs object on globalThis; only eventLoop is read here.
  (globalThis as { Prefs?: unknown }).Prefs = { eventLoop: true };
  const uws = await import(join(root, "compiler/uwebsockets.js"));
  const { standaloneShimA22 } = await import(join(SRC, "a21/standalone-shim.ts"));
  const { PATCH_FINGERPRINT } = await import(join(SRC, "fingerprint.ts"));
  const { PORFFOR_COMMIT_FULL } = await import(join(SRC, "pin.ts"));
  const pkg = JSON.parse(readFileSync(join(REPO, "packages/toolchain/package.json"), "utf8"));
  const rawShim: string = uws.makeUWebSocketsShimSource();
  // SAFETY: ensurePorffor() returns a path; the chain modules' exports are the strings and functions named here (checked by running them).
  return {
    root: root as string,
    rawShim,
    shimA22: standaloneShimA22(rawShim) as string,
    classes: alpha19WebClasses(root),
    uwsCommit: uws.UWS_COMMIT as string,
    uwsRepo: uws.UWS_REPO_URL as string,
    origin: {
      porfforCommit: PORFFOR_COMMIT_FULL as string,
      toolchainVersion: pkg.version as string,
      // SAFETY: the toolchain's own fingerprint module exports a string.
      patchFingerprint: PATCH_FINGERPRINT as string,
    } satisfies Origin,
  };
}

/** The checkout the alpha 19 chain compiles against: upstream's fetch, its two patches, then the #236 helper. */
function chainCheckout(root: string, pristine: string, out: string) {
  cpSync(join(pristine, "src"), join(out, "src"), { recursive: true });
  for (const p of ["0001-remove-default-404.patch", "0002-shorten-uws-errors.patch"]) {
    const r = Bun.spawnSync(["git", "apply", join(root, "compiler/uwebsockets", p)], { cwd: out });
    if (r.exitCode !== 0) throw new Error(`git apply ${p}: ${r.stderr.toString()}`);
  }
}

function fetchPristine(repo: string, commit: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-uws-"));
  for (const argv of [
    ["git", "init", "-q"],
    ["git", "remote", "add", "origin", repo],
    ["git", "fetch", "-q", "--depth", "1", "origin", commit],
    ["git", "checkout", "-q", "--detach", "FETCH_HEAD"],
  ]) {
    const r = Bun.spawnSync(argv, { cwd: dir });
    if (r.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${r.stderr.toString()}`);
  }
  return dir;
}

const flag = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function generate() {
  const c = await fromChain(flag("--a19-root"));
  writeFileSync(join(DIR, "uws-shim.cpp"), SHIM_HEADER(c.origin) + c.rawShim);
  writeFileSync(join(DIR, "web-classes.js"), CLASSES_HEADER(c.origin) + c.classes);
  const pristine = fetchPristine(c.uwsRepo, c.uwsCommit);
  const patched = mkdtempSync(join(tmpdir(), "sb-uws-patched-"));
  try {
    const { applyUwsPatches } = await import(join(DIR, "index.ts"));
    cpSync(join(pristine, "src"), join(patched, "src"), { recursive: true });
    await applyUwsPatches(patched);
    const manifest = {
      note: "Provenance of the vendored standalone server sources. `check` verifies the content hashes; `verify` fetches uWebSockets and applies the patches.",
      uWebSockets: {
        repo: c.uwsRepo,
        commit: c.uwsCommit,
        pristineSrcSha256: await treeHash(join(pristine, "src")),
        patches: PATCHES.map((p) => ({ file: `uws-patches/${p}`, sha256: sha(read(`uws-patches/${p}`)) })),
        patchedSrcSha256: await treeHash(join(patched, "src")),
      },
      files: {
        "uws-shim.cpp": { contentSha256: sha(c.rawShim) },
        "web-classes.js": { contentSha256: sha(c.classes) },
      },
      origin: {
        ...c.origin,
        composedShimA22Sha256: sha(c.shimA22),
        note: "The alpha 19 patch chain's output at the commit that vendored these files; the files above are that output.",
      },
    };
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  } finally {
    rmSync(pristine, { recursive: true, force: true });
    rmSync(patched, { recursive: true, force: true });
  }
  console.log("generated");
}

async function check() {
  const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const bad: string[] = [];
  // SAFETY: sources.json is written by `generate` above with this shape.
  for (const [file, want] of Object.entries(m.files as Record<string, { contentSha256: string }>))
    if (sha(body(read(file))) !== want.contentSha256) bad.push(`${file}: content sha256 differs from sources.json`);
  // SAFETY: same file, same writer.
  for (const p of m.uWebSockets.patches as { file: string; sha256: string }[])
    if (sha(read(p.file)) !== p.sha256) bad.push(`${p.file}: sha256 differs from sources.json`);
  if (bad.length) throw new Error(bad.join("\n"));
  console.log("check: vendored standalone sources match sources.json");
}

async function verify() {
  await check();
  const c = await fromChain(flag("--a19-root"));
  const bad: string[] = [];
  if (body(read("uws-shim.cpp")) !== c.rawShim)
    bad.push("uws-shim.cpp differs from the alpha 19 chain's makeUWebSocketsShimSource()");
  if (body(read("web-classes.js")) !== c.classes)
    bad.push("web-classes.js differs from the alpha 19 chain's alpha19WebClasses()");
  const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
  if (sha(c.shimA22) !== m.origin.composedShimA22Sha256)
    bad.push("the chain's rewritten shim differs from origin.composedShimA22Sha256");
  // uWebSockets: pristine + the chain's own edits vs pristine + the vendored patches
  const pristine = fetchPristine(m.uWebSockets.repo, m.uWebSockets.commit);
  const chain = mkdtempSync(join(tmpdir(), "sb-uws-chain-"));
  const ours = mkdtempSync(join(tmpdir(), "sb-uws-ours-"));
  try {
    if ((await treeHash(join(pristine, "src"))) !== m.uWebSockets.pristineSrcSha256)
      bad.push("pristine uWebSockets src differs from sources.json");
    chainCheckout(c.root, pristine, chain);
    const helper = join(c.root, "compiler/sb-http10.js");
    if (existsSync(helper)) {
      // SAFETY: the alpha 19 chain writes compiler/sb-http10.js exporting sbPatchHttp10(uwsDir).
      const http10 = (await import(helper)) as { sbPatchHttp10: (d: string) => void };
      http10.sbPatchHttp10(chain);
    }
    cpSync(join(pristine, "src"), join(ours, "src"), { recursive: true });
    const { applyUwsPatches } = await import(join(DIR, "index.ts"));
    await applyUwsPatches(ours);
    const a = await treeHash(join(chain, "src"));
    const b = await treeHash(join(ours, "src"));
    if (a !== b) bad.push(`uWebSockets src: chain ${a.slice(0, 12)} != vendored patches ${b.slice(0, 12)}`);
    if (b !== m.uWebSockets.patchedSrcSha256) bad.push("patched uWebSockets src differs from sources.json");
    await applyUwsPatches(ours);
    if ((await treeHash(join(ours, "src"))) !== b) bad.push("applying the patches twice changed the tree");
  } finally {
    for (const d of [pristine, chain, ours]) rmSync(d, { recursive: true, force: true });
  }
  if (bad.length) throw new Error(bad.join("\n"));
  console.log(
    "verify: vendored shim, web classes and uWebSockets patches are byte for byte what the alpha 19 chain produces",
  );
}

const cmd = process.argv[2];
if (cmd === "generate") await generate();
else if (cmd === "verify") await verify();
else if (cmd === "check") await check();
else {
  console.error("usage: bun scripts/standalone-sources.ts generate|verify|check [--a19-root DIR]");
  process.exit(2);
}
