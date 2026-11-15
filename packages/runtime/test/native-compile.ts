import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ensurePorfforA21 } from "../../toolchain/src/a21/acquire";
import {
  composeStandaloneA21,
  SHARED_PRELUDE_FILE,
  STANDALONE_A21_COMPILE_FLAGS,
} from "../../toolchain/src/a21/standalone";
import { ensureHostUws } from "../../toolchain/src/a21/standalone-server";
import { buildStandaloneA21 } from "../../toolchain/src/a21/standalone-build";
import { standaloneA21Channel, standaloneChannel } from "../../toolchain/src/a21/standalone-channel";
import { bearsslEnv } from "./bearssl";

export type NativeCompileInput = {
  /** The generated module (`wrapNativeFetchHandler` output), already written to disk. */
  generated: string;
  /** Where the compiled binary goes. */
  binary: string;
  /** Working directory of the compile, and where alpha 22 puts its intermediate files. Default: the binary's directory. */
  dir?: string;
  /** Toolchain cache root for the Porffor tree (`ensurePorfforA21(channel, { cacheRoot })`). */
  cacheRoot?: string;
  /** Objects and link flags for the link line . */
  extraLink?: string[];
  /** Flags for every C compile . */
  extraCflags?: string[];
  /** Link BearSSL, as a test that uses crypto.subtle needs. */
  bearssl?: boolean;
  /** `-O` level. Default 0. */
  optimize?: number;
  /** Link-time optimisation, as the CLI's host and release builds have it (`-flto`). Default off. */
  flto?: boolean;
  /** Compilers as argv prefixes (default `cc` and `c++`). */
  cc?: string[];
  cxx?: string[];
  /** Extra environment for the compiler process (the default is `process.env`). */
  env?: Record<string, string>;
  /** Message prefix of the failure assertion. Default "Porffor native compile failed". */
  failure?: string;
};

let renderQueue: Promise<void> = Promise.resolve();

const split = (flags: string | undefined): string[] => (flags ?? "").split(" ").filter(Boolean);

/** Compile a generated module into a native binary on the standalone channel (alpha 24). */
export async function compileNative(input: NativeCompileInput): Promise<void> {
  const dir = input.dir ?? dirname(input.binary);
  const optimize = input.optimize ?? 0;
  const failure = input.failure ?? "Porffor native compile failed";
  const bearssl = input.bearssl ? await bearsslEnv() : undefined;
  const extraLink = [...(input.extraLink ?? []), ...split(bearssl?.SB_EXTRA_LINK)];
  const extraCflags = [...(input.extraCflags ?? []), ...split(bearssl?.SB_EXTRA_CFLAGS)];

  const a21Channel = standaloneA21Channel(standaloneChannel());
  const unitsDir = await renderStandaloneUnits({
    generated: input.generated,
    binary: input.binary,
    dir,
    cacheRoot: input.cacheRoot,
    env: input.env,
    failure,
  });
  await rm(input.binary, { force: true });
  await buildStandaloneA21({
    unitsDir,
    outPath: input.binary,
    cc: input.cc ?? ["cc"],
    cxx: input.cxx ?? ["c++"],
    uwsDir: await ensureHostUws(),
    extraLink,
    extraCflags,
    optimize,
    flto: input.flto ?? false,
    musl: false,
    strip: true,
  }).catch((error: Error) => {
    throw new Error(`${failure} (${a21Channel} build):\n${error.message}`);
  });
}

export type RenderUnitsInput = Pick<
  NativeCompileInput,
  "generated" | "binary" | "dir" | "cacheRoot" | "env" | "failure"
>;

/**
 * The compiler's half of a standalone build on the alpha 21 line: compose the sources, render the C units
 * with the pinned (patched) alpha 24 compiler, and return the units directory (porf.h, porf__main.c, the units).
 */
export async function renderStandaloneUnits(input: RenderUnitsInput): Promise<string> {
  const dir = input.dir ?? dirname(input.binary);
  const failure = input.failure ?? "Porffor native compile failed";
  const bun = process.execPath;
  const a21Channel = standaloneA21Channel(standaloneChannel());
  const a21 = await ensurePorfforA21(a21Channel, input.cacheRoot === undefined ? {} : { cacheRoot: input.cacheRoot });
  const work = join(dir, `a22-${(input.binary.split("/").pop() ?? "bin").replace(/[^\w.-]/g, "_")}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const composed = composeStandaloneA21(await readFile(input.generated, "utf8"));
  // Beside the generated module: its relative imports (a handler's sibling helper files) resolve from the
  // directory of the file they were written in, and the shared prelude carries the module's body. The
  // chain recognises the prelude by its file name, so a test that compiles several variants from one
  // directory at once (native-websockets) takes turns: the render is the only step that reads it.
  const source = dirname(resolve(input.generated));
  const entry = join(source, "entry.a22.js");
  const turn = renderQueue;
  let release = () => {};
  renderQueue = new Promise<void>((done) => (release = done));
  await turn;
  let rendered: Awaited<ReturnType<typeof drain>>;
  try {
    await writeFile(join(source, SHARED_PRELUDE_FILE), composed.sharedPrelude);
    await writeFile(entry, composed.entry);
    const unitsDir = join(work, "units");
    const render = Bun.spawn(
      [bun, resolve(a21, "runtime/index.js"), "c", entry, "-o", `${unitsDir}/`, ...STANDALONE_A21_COMPILE_FLAGS],
      { cwd: work, env: { ...process.env, ...input.env }, stdout: "pipe", stderr: "pipe" },
    );
    rendered = await drain(render);
  } finally {
    release();
  }
  if (rendered.exitCode !== 0)
    throw new Error(`${failure} (${a21Channel} render):\n${rendered.stderr}\n${rendered.stdout}`);
  return join(work, "units");
}
