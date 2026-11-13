import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareMainUnit } from "../../toolchain/src/a21/standalone";
import bridgeSource from "../../toolchain/src/a21/native-fetch-a22.c" with { type: "text" };
import { renderStandaloneUnits } from "./native-compile";
import { standaloneChannel } from "../../toolchain/src/a21/standalone-channel";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// The calling convention of every call between host C (the bridge) and generated code, on Porffor alpha 23.
// Alpha 23 prefixes each generated JS function with PORF_CC, which is `__attribute__((swiftcall))` on clang
// arm64 and nothing elsewhere. A host C file that declares or calls one of those functions without PORF_CC
// compiles and links, and works until link-time optimisation sees the two sides disagree and turns the call
// into `unreachable`: the macOS arm64 binary trapped at startup (SIGTRAP in main) calling p__main__23main.
// The reverse direction matters as much: functions the host defines for generated code to call (the
// timer and response entry points) are plain C, and must stay so.
//
// Every unit of a rendered standalone build, and the bridge, is compiled to LLVM IR for each arm64 and x86-64
// target a clang-based compiler here can reach, and every function the IR defines, declares or calls must carry
// swiftcc exactly when its source declaration has PORF_CC (and the target is arm64). Needs clang or zig;
// without one, the test is skipped, and on CI (CI is set) that is an error.
const handler = `export default { fetch() { return new Response("hello"); } };`;

type Target = { name: string; triple: string; arm64: boolean };
const TARGETS: Target[] = [
  { name: "darwin-arm64", triple: "arm64-apple-macos", arm64: true },
  { name: "linux-arm64", triple: "aarch64-linux-gnu", arm64: true },
  { name: "linux-arm64-musl", triple: "aarch64-linux-musl", arm64: true },
  { name: "linux-x64", triple: "x86_64-linux-gnu", arm64: false },
  { name: "linux-x64-musl", triple: "x86_64-linux-musl", arm64: false },
  { name: "darwin-x64", triple: "x86_64-apple-macos", arm64: false },
];

// Compilers to try per target, as argv prefixes: zig cc ships every libc's headers, clang only the host's
// (plus Debian's cross headers when libc6-dev-arm64-cross is installed).
const COMPILERS: string[][] = [
  ["zig", "cc"],
  ["clang"],
  ["clang", "-isystem", "/usr/aarch64-linux-gnu/include"],
  ["cc"],
];

const PROBE = `#include <stdint.h>\n#include <stdlib.h>\n#include <stdio.h>\n#include <string.h>\n#include <time.h>\n#include <signal.h>\n#include <unistd.h>\nint main(void) { return 0; }\n`;

async function spawn(argv: string[], cwd?: string) {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/** A clang-based compiler for `triple` that can include the libc headers the units need, or null. */
/** The LLVM IR of `source` for `triple`, or the compiler's error. zig cc cannot write IR to stdout, so it goes through a file. */
async function emitIr(cc: string[], triple: string, source: string, args: string[] = []) {
  const out = join(workdir, `ir-${++irCounter}.ll`);
  const run = await spawn([...cc, "-target", triple, "-S", "-emit-llvm", "-w", ...args, "-o", out, source]);
  const ir = run.exitCode === 0 && existsSync(out) ? await readFile(out, "utf8") : "";
  await rm(out, { force: true });
  return { ok: run.exitCode === 0 && ir.includes("target triple"), ir, error: run.stderr };
}

/** A clang-based compiler for `triple` that can include the libc headers the units need, or null. */
async function compilerFor(triple: string, probe: string): Promise<string[] | null> {
  for (const cc of COMPILERS) {
    if (!Bun.which(cc[0])) continue;
    try {
      // gcc named `cc` rejects -target, and only clang's IR has a `target triple` line
      if ((await emitIr(cc, triple, probe)).ok) return cc;
    } catch {
      // not runnable
    }
  }
  return null;
}

/** The names the sources declare or define with PORF_CC. */
function swiftNames(texts: string[]): Set<string> {
  const names = new Set<string>();
  for (const text of texts)
    for (const m of text.matchAll(/^[ \t]*(?:extern[ \t]+|static[ \t]+)?PORF_CC[ \t]+[^;{(\n]*?(\w+)[ \t]*\(/gm))
      names.add(m[1]);
  return names;
}

/** Every function an IR file defines, declares or calls by name, with whether that site says swiftcc. */
function irReferences(ir: string): { name: string; swift: boolean; kind: string }[] {
  const out: { name: string; swift: boolean; kind: string }[] = [];
  for (const m of ir.matchAll(/^(define|declare)\b([^@\n]*)@([\w.$]+)\(/gm))
    out.push({ kind: m[1], swift: /\bswiftcc\b/.test(m[2]), name: m[3] });
  for (const m of ir.matchAll(/\bcall\b([^@(\n]*)@([\w.$]+)\(/g))
    out.push({ kind: "call", swift: /\bswiftcc\b/.test(m[1]), name: m[2] });
  return out;
}

if (standaloneChannel() !== "alpha-23") {
  // alpha 22's porf.h has no PORF_CC and alpha 19 has no bridge: nothing to compare
  console.log(`SKIPPED: the calling-convention check is for the alpha-23 channel, not ${standaloneChannel()}`);
  process.exit(0);
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-cc-"));
let irCounter = 0;
try {
  const [core, broker] = await Promise.all([readFile(preludePath, "utf8"), readFile(transportPath("broker"), "utf8")]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const generated = join(workdir, "cc.generated.js");
  await writeFile(generated, wrapNativeFetchHandler(handler, core.replace(TRANSPORT_MARKER, broker)));
  const units = await renderStandaloneUnits({ generated, binary: join(workdir, "cc-native"), dir: workdir });
  prepareMainUnit(join(units, "porf__main.c"));
  const bridge = join(units, "porf_native_fetch_a22.c");
  await writeFile(bridge, bridgeSource);
  const sources = (await readdir(units)).filter((f) => f.endsWith(".c")).sort();
  assert(sources.includes("porf_native_fetch_a22.c") && sources.includes("porf__main.c"), "units are missing");
  const texts = await Promise.all([
    ...sources.map((f) => readFile(join(units, f), "utf8")),
    readFile(join(units, "porf.h"), "utf8"),
  ]);
  const swift = swiftNames(texts);
  const probe = join(workdir, "probe.c");
  await writeFile(probe, PROBE);

  assert(
    swift.has("p__main__23main"),
    "porf.h no longer declares p__main__23main with PORF_CC: has the compiler dropped swiftcall (alpha 24)?",
  );
  const hasMacro = texts[texts.length - 1].includes("#define PORF_CC __attribute__((swiftcall))");
  assert(hasMacro, "porf.h has no PORF_CC swiftcall definition: this test is written for Porffor alpha 23 or later");

  const checked: string[] = [];
  for (const target of TARGETS) {
    const cc = await compilerFor(target.triple, probe);
    if (!cc) continue;
    let swiftRefs = 0;
    let bridgeCallsMain = false;
    for (const file of sources) {
      const compile = await emitIr(cc, target.triple, join(units, file), ["-O0", "-I", units]);
      assert(compile.ok, `${target.name}: ${file} did not compile:\n${compile.error.slice(-2000)}`);
      for (const ref of irReferences(compile.ir)) {
        const want = target.arm64 && swift.has(ref.name);
        assert.equal(
          ref.swift,
          want,
          `${target.name}: ${file} ${ref.kind}s ${ref.name} ${ref.swift ? "with" : "without"} swiftcc, but the source ` +
            `${swift.has(ref.name) ? "declares it with PORF_CC" : "declares it without PORF_CC"}` +
            (target.arm64 ? "" : " (and this target has no swiftcall)"),
        );
        if (ref.swift) swiftRefs++;
        if (file === "porf_native_fetch_a22.c" && ref.kind === "call" && ref.name === "p__main__23main")
          bridgeCallsMain = true;
      }
    }
    assert(bridgeCallsMain, `${target.name}: the bridge no longer calls p__main__23main (or the IR scan missed it)`);
    if (target.arm64) assert(swiftRefs > 0, `${target.name}: no swiftcc anywhere: the scan is vacuous`);
    else assert.equal(swiftRefs, 0, `${target.name}: swiftcc on a target without it`);
    checked.push(target.name);
  }

  // Strict only where the job provisions an arm64 compiler (SB_NATIVE_CC_STRICT=1 in ci.yml's native job).
  // The release workflow runs test:native on a stock runner without one; failing there blocked 0.26.1.
  const strict = process.env.SB_NATIVE_CC_STRICT === "1";
  const arm64Hosted = process.platform === "darwin" ? "darwin-arm64" : "linux-arm64";
  if (checked.length === 0 || !checked.includes(arm64Hosted)) {
    const message = `no compiler for ${arm64Hosted} (needs clang with its headers, or zig): checked ${checked.join(", ") || "nothing"}`;
    assert(!strict, message);
    console.log(
      `SKIPPED: ${message}${process.env.CI ? " (set SB_NATIVE_CC_STRICT=1 in a job that installs one)" : ""}`,
    );
  } else {
    console.log(`Host C and generated code agree on the calling convention for ${checked.join(", ")}`);
  }
} finally {
  await rm(workdir, { recursive: true, force: true });
}
