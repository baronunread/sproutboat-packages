/**
 * A host build of a standalone binary on the alpha 22 channel, for the tools that compile one on the
 * machine they run on (the runtime's native tests, the monorepo's compat suite, `sproutboat dev`):
 * compose the sources, render the units with the alpha 22 compiler, build with the bridge and the
 * server shim (`standalone-build.ts`) against the host's uWebSockets checkout. The CLI's cross builds
 * do the same with zig (`compileSproutA21` in sproutboat-cli).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ensurePorffor } from "../acquire";
import { ensurePorfforA21 } from "./acquire";
import { composeStandaloneA21, SHARED_PRELUDE_FILE, STANDALONE_A21_COMPILE_FLAGS } from "./standalone";
import { buildStandaloneA21 } from "./standalone-build";

type Alpha19Uws = {
  UWS_COMMIT: string;
  ensureUWebSockets: () => string;
  ensureUSocketsBuilt: (dir: string) => string;
};

/**
 * The host uWebSockets checkout with `uSockets/uSockets.a` built, as the alpha 19 compiler keeps it
 * (`~/.cache/porffor/deps/uWebSockets-<commit>`): the CLI seeds it from its vendored archive; failing
 * that, the alpha 19 tree's own module fetches and builds it (git and make).
 */
export async function ensureHostUws(alpha19Root: string): Promise<string> {
  // SAFETY: the alpha 19 compiler reads its flags from a plain `Prefs` object on globalThis (prefs.js).
  const g = globalThis as { Prefs?: { eventLoop?: boolean; musl?: boolean } };
  const prev = g.Prefs;
  g.Prefs = { ...prev, eventLoop: true, musl: false };
  try {
    // SAFETY: the patched alpha 19 tree's module exports these three names (the chain's
    // patchUwebsockets anchors on them); a tree without them fails here, loudly.
    const mod = (await import(resolve(alpha19Root, "compiler/uwebsockets.js"))) as Alpha19Uws;
    const dir = resolve(homedir(), ".cache/porffor/deps", `uWebSockets-${mod.UWS_COMMIT}`);
    if (!existsSync(join(dir, "src/App.h"))) mod.ensureUWebSockets();
    if (!existsSync(join(dir, "uSockets/uSockets.a"))) mod.ensureUSocketsBuilt(dir);
    return dir;
  } finally {
    if (prev === undefined) delete g.Prefs;
    else g.Prefs = prev;
  }
}

export type HostCompileInput = {
  /** The wrapped module as the alpha 19 path compiles it (`wrapNativeFetchHandler` output), on disk. */
  generatedPath: string;
  outPath: string;
  /** Objects and link flags for this build (SQLite, BearSSL, trust anchors), as `SB_EXTRA_LINK` carried them. */
  extraLink?: string[];
  /** Compile flags (the BearSSL include), as `SB_EXTRA_CFLAGS` carried them. */
  extraCflags?: string[];
  optimize?: number;
  /** The C and C++ compilers; `cc` and `c++` by default. */
  cc?: string[];
  cxx?: string[];
  /** Where to put the composed sources and units (default: beside the generated module). */
  workDir?: string;
  strip?: boolean;
  log?: (line: string) => void;
};

/** Compile `generatedPath` to a host binary at `outPath` on the alpha 22 channel. */
export async function compileStandaloneHostA21(input: HostCompileInput): Promise<void> {
  const [alpha19, alpha22] = await Promise.all([ensurePorffor(), ensurePorfforA21("alpha-22")]);
  const dir = resolve(input.workDir ?? dirname(input.generatedPath));
  await mkdir(dir, { recursive: true });
  const composed = composeStandaloneA21(await readFile(input.generatedPath, "utf8"), alpha19);
  await writeFile(join(dir, SHARED_PRELUDE_FILE), composed.sharedPrelude);
  const entry = join(dir, "sprout.a22.js");
  await writeFile(entry, composed.entry);
  const unitsDir = join(dir, "units-a22");
  await rm(unitsDir, { recursive: true, force: true });
  const render = Bun.spawn(
    ["bun", resolve(alpha22, "runtime/index.js"), "c", entry, "-o", `${unitsDir}/`, ...STANDALONE_A21_COMPILE_FLAGS],
    {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    render.exited,
    new Response(render.stdout).text(),
    new Response(render.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`Porffor (alpha 22) render failed: ${(stderr || stdout).trim() || `exit ${code}`}`);
  await buildStandaloneA21({
    unitsDir,
    alpha19Root: alpha19,
    outPath: input.outPath,
    cc: input.cc ?? ["cc"],
    cxx: input.cxx ?? ["c++"],
    uwsDir: await ensureHostUws(alpha19),
    extraLink: input.extraLink,
    extraCflags: input.extraCflags,
    optimize: input.optimize,
    flto: false,
    musl: false,
    strip: input.strip ?? true,
    log: input.log,
  });
}
