import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { ensurePorfforA21 } from "../../toolchain/src/a21/acquire";
import {
  composeStandaloneA21,
  SHARED_PRELUDE_FILE,
  STANDALONE_A21_COMPILE_FLAGS,
} from "../../toolchain/src/a21/standalone";
import { buildStandaloneA21 } from "../../toolchain/src/a21/standalone-build";
import { bearsslEnv } from "./bearssl";

export type NativeCompileInput = {
  /** The generated module (`wrapNativeFetchHandler` output), already written to disk. */
  generated: string;
  /** Where the compiled binary goes. */
  binary: string;
  /** Working directory of the compile, and where alpha 22 puts its intermediate files. Default: the binary's directory. */
  dir?: string;
  /** Toolchain cache root for the alpha 19 tree (`ensurePorffor({ cacheRoot })`). */
  cacheRoot?: string;
  /** Objects and link flags for the link line (alpha 19: `SB_EXTRA_LINK`). */
  extraLink?: string[];
  /** Flags for every C compile (alpha 19: `SB_EXTRA_CFLAGS`). */
  extraCflags?: string[];
  /** Link BearSSL, as a test that uses crypto.subtle needs. */
  bearssl?: boolean;
  /** `-O` level. Default 0. */
  optimize?: number;
  /** Extra environment for the alpha 19 compiler process (the default is `process.env`). */
  env?: Record<string, string>;
  /** Message prefix of the failure assertion. Default "Porffor native compile failed". */
  failure?: string;
};

type UwsModule = {
  UWS_COMMIT: string;
  ensureUWebSockets: () => string;
  ensureUSocketsBuilt: (dir: string) => void;
};

type Channel = "alpha-19" | "alpha-22";

const channel = (): Channel => {
  const raw = process.env.SPROUTBOAT_PORFFOR_CHANNEL;
  if (!raw || raw === "alpha-19") return "alpha-19";
  if (raw === "alpha-22") return "alpha-22";
  throw new Error(`SPROUTBOAT_PORFFOR_CHANNEL=${raw}: expected alpha-19 or alpha-22`);
};

const split = (flags: string | undefined): string[] => (flags ?? "").split(" ").filter(Boolean);

async function drain(child: Bun.Subprocess<"ignore", "pipe", "pipe">) {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/** The host uWebSockets checkout with a built uSockets.a, built on first use. */
async function uwsDirectory(alpha19: string): Promise<string> {
  // SAFETY: the patched alpha 19 tree's compiler/uwebsockets.js exports these (see the toolchain's standaloneShimSource).
  const mod: UwsModule = await import(resolve(alpha19, "compiler/uwebsockets.js"));
  const dir = resolve(homedir(), ".cache/porffor/deps", `uWebSockets-${mod.UWS_COMMIT}`);
  if (!existsSync(join(dir, "uSockets/uSockets.a"))) {
    // SAFETY: the compiler's prefs.js installs `Prefs` on globalThis as a plain flag object.
    const g = globalThis as { Prefs?: { eventLoop?: boolean } };
    const prev = g.Prefs;
    g.Prefs = { ...prev, eventLoop: true };
    try {
      mod.ensureUSocketsBuilt(mod.ensureUWebSockets());
    } finally {
      if (prev === undefined) delete g.Prefs;
      else g.Prefs = prev;
    }
  }
  return dir;
}

/** Compile a generated module into a native binary on the channel `SPROUTBOAT_PORFFOR_CHANNEL` names. */
export async function compileNative(input: NativeCompileInput): Promise<void> {
  const which = channel();
  const dir = input.dir ?? dirname(input.binary);
  const optimize = input.optimize ?? 0;
  const failure = input.failure ?? "Porffor native compile failed";
  const bearssl = input.bearssl ? await bearsslEnv() : undefined;
  const extraLink = [...(input.extraLink ?? []), ...split(bearssl?.SB_EXTRA_LINK)];
  const extraCflags = [...(input.extraCflags ?? []), ...split(bearssl?.SB_EXTRA_CFLAGS)];
  const alpha19 = await ensurePorffor(input.cacheRoot === undefined ? {} : { cacheRoot: input.cacheRoot });

  if (which === "alpha-19") {
    const node = Bun.which("node");
    if (!node) throw new Error("native compile needs node on PATH");
    const env = { ...process.env, ...input.env };
    if (extraLink.length > 0) env.SB_EXTRA_LINK = extraLink.join(" ");
    if (extraCflags.length > 0) env.SB_EXTRA_CFLAGS = extraCflags.join(" ");
    const compile = Bun.spawn(
      [
        node,
        resolve(alpha19, "runtime/index.js"),
        "native",
        input.generated,
        "-o",
        input.binary,
        "-s",
        `-O${optimize}`,
      ],
      { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
    );
    const { exitCode, stdout, stderr } = await drain(compile);
    if (exitCode !== 0) throw new Error(`${failure}:\n${stderr}\n${stdout}`);
    return;
  }

  const bun = process.execPath;
  const alpha22 = await ensurePorfforA21("alpha-22");
  const work = join(dir, `a22-${(input.binary.split("/").pop() ?? "bin").replace(/[^\w.-]/g, "_")}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const composed = composeStandaloneA21(await readFile(input.generated, "utf8"), alpha19);
  await writeFile(join(work, SHARED_PRELUDE_FILE), composed.sharedPrelude);
  const entry = join(work, "entry.a22.js");
  await writeFile(entry, composed.entry);
  const unitsDir = join(work, "units");
  const render = Bun.spawn(
    [bun, resolve(alpha22, "runtime/index.js"), "c", entry, "-o", `${unitsDir}/`, ...STANDALONE_A21_COMPILE_FLAGS],
    { cwd: work, env: { ...process.env, ...input.env }, stdout: "pipe", stderr: "pipe" },
  );
  const rendered = await drain(render);
  if (rendered.exitCode !== 0) throw new Error(`${failure} (alpha 22 render):\n${rendered.stderr}\n${rendered.stdout}`);
  await rm(input.binary, { force: true });
  await buildStandaloneA21({
    unitsDir,
    alpha19Root: alpha19,
    outPath: input.binary,
    cc: ["cc"],
    cxx: ["c++"],
    uwsDir: await uwsDirectory(alpha19),
    extraLink,
    extraCflags,
    optimize,
    flto: false,
    musl: false,
    strip: true,
  }).catch((error: Error) => {
    throw new Error(`${failure} (alpha 22 build):\n${error.message}`);
  });
}
