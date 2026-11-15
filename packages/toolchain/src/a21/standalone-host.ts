/**
 * A host build of a standalone binary, for the tools that compile one on the
 * machine they run on (the runtime's native tests, the monorepo's compat suite, `sproutboat dev`):
 * compose the sources, render the units with the patched alpha compiler, build with the bridge and the
 * server shim (`standalone-build.ts`) against the host's uWebSockets checkout. The CLI's cross builds
 * do the same with zig (`compileSproutA21` in sproutboat-cli).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ensureHostUws } from "./standalone-server";
import { ensurePorfforA21 } from "./acquire";
import { standaloneA21Channel, standaloneChannel } from "./standalone-channel";
import { composeStandaloneA21, SHARED_PRELUDE_FILE, STANDALONE_A21_COMPILE_FLAGS } from "./standalone";
import { buildStandaloneA21 } from "./standalone-build";

export type HostCompileInput = {
  /** The wrapped module (`wrapNativeFetchHandler` output), on disk. */
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

/** Compile `generatedPath` to a host binary at `outPath` on the alpha 21 line (the current alpha). */
export async function compileStandaloneHostA21(input: HostCompileInput): Promise<void> {
  const channel = standaloneA21Channel(standaloneChannel());
  const a21 = await ensurePorfforA21(channel);
  const dir = resolve(input.workDir ?? dirname(input.generatedPath));
  await mkdir(dir, { recursive: true });
  const composed = composeStandaloneA21(await readFile(input.generatedPath, "utf8"));
  await writeFile(join(dir, SHARED_PRELUDE_FILE), composed.sharedPrelude);
  const entry = join(dir, "sprout.a22.js");
  await writeFile(entry, composed.entry);
  const unitsDir = join(dir, "units-a22");
  await rm(unitsDir, { recursive: true, force: true });
  const render = Bun.spawn(
    ["bun", resolve(a21, "runtime/index.js"), "c", entry, "-o", `${unitsDir}/`, ...STANDALONE_A21_COMPILE_FLAGS],
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
  if (code !== 0) throw new Error(`Porffor (${channel}) render failed: ${(stderr || stdout).trim() || `exit ${code}`}`);
  await buildStandaloneA21({
    unitsDir,
    outPath: input.outPath,
    cc: input.cc ?? ["cc"],
    cxx: input.cxx ?? ["c++"],
    uwsDir: await ensureHostUws(),
    extraLink: input.extraLink,
    extraCflags: input.extraCflags,
    optimize: input.optimize,
    flto: false,
    musl: false,
    strip: input.strip ?? true,
    log: input.log,
  });
}
