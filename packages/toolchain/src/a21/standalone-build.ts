/**
 * The native build of a standalone binary: the compiler only renders the split C
 * units (`porffor c`); this module compiles them with the bridge (`native-fetch-a22.c`) and the server
 * shim (the vendored uWebSockets shim rewritten over flat data, `standalone-shim.ts`), and links them with the
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
import { applyUwsHttp10, uwsShimSource } from "./standalone-server";

export { bridgeSource as NATIVE_FETCH_A22_BRIDGE };

/**
 * The server shim source, rewritten for the flat bridge: the vendored `standalone-server/uws-shim.cpp`
 * (the patched alpha 19 native-fetch server, see its provenance header) through `standaloneShimA22`.
 */
export function standaloneShimSource(): string {
  return standaloneShimA22(uwsShimSource());
}

export type StandaloneBuildInput = {
  /** The compiler's split output (`porffor c ENTRY -o DIR`): porf.h, porf__main.c, the units. */
  unitsDir: string;
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

/** Apply sproutboat #236 (the HTTP/1.0 edit, `standalone-server/uws-patches/0003-http10.patch`) to a uWebSockets checkout; a no-op once it is applied. */
export async function patchUwsHttp10(uwsDir: string): Promise<void> {
  await applyUwsHttp10(uwsDir);
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
  // edited, so this build applies the vendored patch (marker-guarded, a no-op on a patched checkout) to
  // the checkout it compiles against. Objects are stamped by their own text, not by the headers they
  // include, so the shim names the edit: a shim compiled against an unedited header is not reused.
  await patchUwsHttp10(input.uwsDir);
  await writeFile(join(units, "porf_server.cpp"), `// ${HTTP10_SHIM_STAMP}\n` + standaloneShimSource());
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
