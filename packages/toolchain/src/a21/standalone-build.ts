/**
 * The native build of a standalone binary on alpha 22: what alpha 19's `compiler/index.js`
 * `compileNativeFetch` did inside the compiler, done beside it. The compiler only renders the split C
 * units (`porffor c`); this module compiles them with the bridge (`native-fetch-a22.c`) and the server
 * shim (the alpha 19 shim rewritten over flat data, `standalone-shim.ts`), and links them with the
 * caller's native objects (SQLite, BearSSL, trust anchors, the restore objects) and uSockets.
 *
 * Objects are content-cached in the units directory (a unit whose C and flags did not change is not
 * recompiled), as the compiler's own build cache does; the CLI already keeps one units directory per
 * target and transport.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
// @ts-expect-error Bun's text loader supplies a string.
import bridgeSource from "./native-fetch-a22.c" with { type: "text" };
import { standaloneShimA22 } from "./standalone-shim";
import { prepareMainUnit } from "./standalone";

export { bridgeSource as NATIVE_FETCH_A22_BRIDGE };

/**
 * The alpha 19 server shim source, rewritten for alpha 22. Read from the patched alpha 19 tree's
 * `compiler/uwebsockets.js` (the module needs the compiler's `Prefs` global: the event loop is on,
 * as the CLI's native-fetch builds always had it).
 */
export async function standaloneShimSource(alpha19Root: string): Promise<string> {
  // SAFETY: the compiler's prefs.js installs `Prefs` on globalThis as a plain flag object; only the
  // event-loop flag is read by the shim source.
  const g = globalThis as { Prefs?: { eventLoop?: boolean } };
  const prev = g.Prefs;
  g.Prefs = { ...prev, eventLoop: true };
  try {
    // SAFETY: the patched alpha 19 tree's module exports `makeUWebSocketsShimSource` (the chain's
    // patchUwebsockets anchors on it); a tree without it fails here, loudly.
    const mod = (await import(resolve(alpha19Root, "compiler/uwebsockets.js"))) as {
      makeUWebSocketsShimSource: () => string;
    };
    return standaloneShimA22(mod.makeUWebSocketsShimSource());
  } finally {
    if (prev === undefined) delete g.Prefs;
    else g.Prefs = prev;
  }
}

export type StandaloneBuildInput = {
  /** The compiler's split output (`porffor c ENTRY -o DIR`): porf.h, porf__main.c, the units. */
  unitsDir: string;
  /** The patched alpha 19 tree (the shim source; `ensurePorffor()`). */
  alpha19Root: string;
  outPath: string;
  /** C and C++ compilers, as argv prefixes (`["zig", "cc", "-target", triple]` or `["cc"]`). */
  cc: string[];
  cxx: string[];
  /** The uWebSockets checkout: `src/App.h`; `uSockets/src` and `uSockets/uSockets.a` built for the target. */
  uwsDir: string;
  /** Objects and link flags appended to the link line (SQLite, BearSSL, trust anchors, restore). */
  extraLink?: string[];
  /** Flags for every compile (the BearSSL include; `-Dmain=sb_app_main` for a restore build). */
  extraCflags?: string[];
  /** `-O` level; the compiler's default is 3. */
  optimize?: number;
  /** Link-time optimisation (alpha 19's single unit had it; alpha 22 turns it off for split builds). */
  flto?: boolean;
  /** A static musl link. */
  musl?: boolean;
  /** Strip at link. */
  strip?: boolean;
  /** Parallel compiles. */
  jobs?: number;
  /** Progress lines. */
  log?: (line: string) => void;
};

export const HTTP10_SHIM_STAMP = "sproutboat #236 (alpha 22): compiled against an HttpParser.h that accepts HTTP/1.0";

/** Apply the alpha 19 tree's HTTP/1.0 edit (#236) to a uWebSockets checkout; a no-op once it is applied. */
export async function patchUwsHttp10(alpha19Root: string, uwsDir: string): Promise<void> {
  const helper = join(alpha19Root, "compiler/sb-http10.js");
  if (!existsSync(helper)) throw new Error(`no ${helper}: the alpha 19 tree is not patched for HTTP/1.0 (#236)`);
  // SAFETY: compiler/sb-http10.js is written by the toolchain's own patch chain (patch.ts HTTP10_HELPER)
  // and exports sbPatchHttp10(uwsDir); its presence was checked above.
  const mod = (await import(helper)) as { sbPatchHttp10: (dir: string) => void };
  mod.sbPatchHttp10(uwsDir);
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

async function run(argv: string[], cwd?: string): Promise<void> {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0)
    throw new Error(
      `${argv.slice(0, 2).join(" ")} failed (${code}):\n${(err || out).trim().split("\n").slice(-20).join("\n")}`,
    );
}

/** Compile, in parallel, every source whose content or flags changed; return the objects in order. */
async function compileAll(jobs: { source: string; object: string; argv: string[] }[], parallel: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const job = jobs[next++];
      if (!job) return;
      await run(job.argv);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, jobs.length)) }, worker));
}

/** Build the binary from the compiler's units. */
export async function buildStandaloneA21(input: StandaloneBuildInput): Promise<void> {
  const log = input.log ?? (() => {});
  const O = `-O${input.optimize ?? 3}`;
  const units = resolve(input.unitsDir);
  const objDir = join(units, "obj");
  await mkdir(objDir, { recursive: true });
  prepareMainUnit(join(units, "porf__main.c"));

  // -ffp-contract=off as the alpha 19 chain's patchCompilerArgs (#235): no fused multiply-add, so a
  // double computed in C matches the engine's.
  const common = [
    "-fno-exceptions",
    "-fno-unwind-tables",
    "-fno-asynchronous-unwind-tables",
    "-fno-ident",
    "-ffunction-sections",
    "-fdata-sections",
    "-ffp-contract=off",
    ...(input.flto ? ["-flto"] : []),
    O,
    "-w",
  ];
  const cflags = [...common, ...(input.extraCflags ?? []), "-I", units];
  const cxxflags = [
    "-std=c++20",
    "-fno-rtti",
    "-DUWS_NO_ZLIB",
    "-DUWS_HTTPRESPONSE_NO_WRITEMARK",
    "-DLIBUS_NO_SSL",
    "-I",
    join(input.uwsDir, "src"),
    "-I",
    join(input.uwsDir, "uSockets/src"),
    "-pthread",
    ...common,
    ...(input.extraCflags ?? []),
  ];
  const uSockets = join(input.uwsDir, "uSockets/uSockets.a");
  if (!existsSync(uSockets)) throw new Error(`no uSockets.a at ${uSockets}`);

  // sources: the compiler's units, the bridge, the shim
  const unitFiles = (await readdir(units)).filter((f) => f.endsWith(".c")).sort();
  await writeFile(join(units, "porf_native_fetch_a22.c"), bridgeSource);
  // sproutboat #236: uWebSockets answers an HTTP/1.0 request line with 505 unless HttpParser.h is
  // edited. The alpha 19 compiler makes that edit inside its own native-fetch compile, which this build
  // never runs, so it applies the same marker-guarded edit (the patched tree's compiler/sb-http10.js) to
  // the checkout it compiles against. Objects are stamped by their own text, not by the headers they
  // include, so the shim names the edit: a shim compiled against an unedited header is not reused.
  await patchUwsHttp10(input.alpha19Root, input.uwsDir);
  await writeFile(
    join(units, "porf_server.cpp"),
    `// ${HTTP10_SHIM_STAMP}\n` + (await standaloneShimSource(input.alpha19Root)),
  );
  const sources = [
    ...unitFiles.map((f) => join(units, f)),
    join(units, "porf_native_fetch_a22.c"),
    join(units, "porf_server.cpp"),
  ];
  // largest first, so the prelude unit never trails the batch
  const sized = await Promise.all(sources.map(async (s) => ({ s, n: (await readFile(s)).length })));
  sized.sort((a, b) => b.n - a.n);

  const jobs: { source: string; object: string; argv: string[] }[] = [];
  const objects: string[] = [];
  const porfH = await readFile(join(units, "porf.h"), "utf8");
  for (const { s } of sized) {
    const cpp = s.endsWith(".cpp");
    const flags = cpp ? cxxflags : cflags;
    const compiler = cpp ? input.cxx : input.cc;
    const text = await readFile(s, "utf8");
    // the stamp: source, porf.h (every unit includes it), compiler and flags
    const stamp = sha(text + "\0" + (cpp ? "" : porfH) + "\0" + [...compiler, ...flags].join(" "));
    const object = join(objDir, `${basename(s).replace(/\.(c|cpp)$/, "")}.o`);
    const stampFile = `${object}.stamp`;
    objects.push(object);
    if (existsSync(object) && existsSync(stampFile) && (await readFile(stampFile, "utf8")) === stamp) continue;
    await rm(object, { force: true });
    jobs.push({ source: s, object, argv: [...compiler, ...flags, "-c", s, "-o", object] });
    await writeFile(stampFile, stamp);
  }
  log(`compiling ${jobs.length}/${objects.length} units (${input.cc[0]})`);
  const t0 = performance.now();
  try {
    await compileAll(jobs, input.jobs ?? Math.max(2, navigator.hardwareConcurrency || 4));
  } catch (error) {
    // a failed compile must not leave a stamp that says the object is current
    for (const job of jobs) if (!existsSync(job.object)) await rm(`${job.object}.stamp`, { force: true });
    throw error;
  }
  log(`compiled ${jobs.length} units in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

  const link = [
    ...input.cxx,
    ...(input.musl ? ["-static"] : []),
    "-o",
    input.outPath,
    "-pthread",
    ...(input.flto ? ["-flto"] : []),
    O,
    ...(process.platform === "darwin" && !input.musl
      ? ["-Wl,-dead_strip", "-Wl,-dead_strip_dylibs"]
      : ["-Wl,--gc-sections"]),
    ...objects,
    ...(input.extraLink ?? []),
    uSockets,
    "-lm",
    ...(input.strip ? ["-s"] : []),
  ];
  log(`linking (${input.cxx[0]})`);
  const t1 = performance.now();
  await run(link);
  log(`linked in ${((performance.now() - t1) / 1000).toFixed(1)}s`);
}
