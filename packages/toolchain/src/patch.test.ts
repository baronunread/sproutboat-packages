import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchCaseMapping, patchCompilerArgs, patchNavigatorWritable, patchRepeatDoubling } from "./patch";

test("repeat patch replaces both per-repetition loops once", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-repeat-patch-"));
  try {
    await mkdir(join(root, "compiler/builtins"), { recursive: true });
    const file = join(root, "compiler/builtins/string.ts");
    const loop =
      "  for (let i: i32 = 0; i < count; i++) {\n" +
      "    Porffor.IR.copy(Porffor.IR.ptr(out) + 4 + i * thisLen, Porffor.IR.ptr(this) + 4, thisLen);\n" +
      "  }\n";
    await writeFile(file, "a\n" + loop + "b\n" + loop);
    await patchRepeatDoubling(root);
    const patched = await readFile(file, "utf8");
    expect(patched.split("sproutboat B16: doubling repeat").length).toBe(3);
    expect(patched).not.toContain("i * thisLen");
    await patchRepeatDoubling(root);
    expect(await readFile(file, "utf8")).toBe(patched);
    await writeFile(file, "a\n" + loop);
    await expect(patchRepeatDoubling(root)).rejects.toThrow("anchor not found twice");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensurePorfforPatched trusts a cache entry this toolchain version and patch chain patched, and nothing else", async () => {
  const { ensurePorfforPatched } = await import("./patch");
  const { PORFFOR_COMMIT_FULL } = await import("./pin");
  const { PATCH_FINGERPRINT } = await import("./fingerprint");
  const { version } = await import("../package.json");
  const root = await mkdtemp(join(tmpdir(), "sb-patched-stamp-"));
  try {
    // An empty tree: running the chain would throw on the first missing file.
    await writeFile(
      join(root, ".sproutboat-complete"),
      JSON.stringify({ commit: PORFFOR_COMMIT_FULL, toolchainVersion: version, patchFingerprint: PATCH_FINGERPRINT }),
    );
    await ensurePorfforPatched(root);
    const stale = await mkdtemp(join(tmpdir(), "sb-patched-stale-"));
    try {
      await writeFile(
        join(stale, ".sproutboat-complete"),
        JSON.stringify({ commit: PORFFOR_COMMIT_FULL, toolchainVersion: "0.0.0" }),
      );
      await expect(ensurePorfforPatched(stale)).rejects.toThrow();
      // Same release, older patch chain (B19): the chain runs again.
      await writeFile(
        join(stale, ".sproutboat-complete"),
        JSON.stringify({ commit: PORFFOR_COMMIT_FULL, toolchainVersion: version, patchFingerprint: "000000000000" }),
      );
      await expect(ensurePorfforPatched(stale)).rejects.toThrow();
    } finally {
      await rm(stale, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("case mapping patch adds the lookup and routes non-ASCII units through it, idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-case-map-"));
  try {
    await mkdir(join(root, "compiler/builtins"), { recursive: true });
    const file = join(root, "compiler/builtins/string.ts");
    await writeFile(
      file,
      "export const __String_prototype_toUpperCase = function (this: string) {\n" +
        "    if (chr >= 97) if (chr <= 122) chr -= 32;\n\n    Porffor.IR.storeU16(j, 4, chr);\n" +
        "    if (chr >= 97) if (chr <= 122) chr -= 32;\n\n    Porffor.IR.storeU8(j++, 4, chr);\n" +
        "    if (chr >= 65) if (chr <= 90) chr += 32;\n\n    Porffor.IR.storeU16(j, 4, chr);\n" +
        "    if (chr >= 65) if (chr <= 90) chr += 32;\n\n    Porffor.IR.storeU8(j++, 4, chr);\n",
    );
    await patchCaseMapping(root);
    const patched = await readFile(file, "utf8");
    expect(patched).toContain("export const __Porffor_caseFind = (chr: i32, runs: string): i32 => {");
    expect(patched).toContain("else chr = __Porffor_caseUpper(chr);");
    expect(patched).toContain("else chr = __Porffor_caseLower(chr);");
    expect(patched).toContain("if (chr != 247) chr -= 32;");
    await patchCaseMapping(root);
    expect(await readFile(file, "utf8")).toBe(patched);
    await writeFile(file, "export const x = 1;\n");
    await expect(patchCaseMapping(root)).rejects.toThrow("anchor not found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function expectPatch(
  patch: (root: string) => Promise<void>,
  file: string,
  anchor: string,
  expected: string,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "sb-patch-"));
  try {
    await mkdir(join(root, "compiler"));
    const path = join(root, file);
    await writeFile(path, `// before\n${anchor}// after\n`);
    await patch(root);
    const patched = await readFile(path, "utf8");
    expect(patched).toContain(expected);
    await patch(root);
    expect(await readFile(path, "utf8")).toBe(patched);
    await writeFile(path, "export const x = 1;\n");
    await expect(patch(root)).rejects.toThrow("anchor not found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("patchNavigatorWritable makes navigator.userAgent assignable", async () => {
  await expectPatch(
    patchNavigatorWritable,
    "compiler/builtins.js",
    "      writable: false,\n      enumerable: true,\n      configurable: false\n    }, {\n      userAgent: 'x'\n",
    "writable: true, // sproutboat: navigator is writable",
  );
});

test("patchCompilerArgs adds SB_EXTRA_LINK before -lm and SB_EXTRA_CFLAGS to the compile flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-compiler-args-"));
  try {
    await mkdir(join(root, "compiler"));
    const path = join(root, "compiler/index.js");
    await writeFile(
      path,
      "const compileOnlyArgs = [\n        ...darwinReleaseCompileArgs,\n      ];\n" +
        "const args = [\n        '-lm', // link math.h\n        ...libs.ldflags,\n];\n",
    );
    await patchCompilerArgs(root);
    const patched = await readFile(path, "utf8");
    expect(patched.indexOf("SB_EXTRA_LINK")).toBeLessThan(patched.indexOf("'-lm'"));
    expect(patched).toContain("process.env.SB_EXTRA_CFLAGS");
    await patchCompilerArgs(root);
    expect(await readFile(path, "utf8")).toBe(patched);
    await writeFile(path, "export const x = 1;\n");
    await expect(patchCompilerArgs(root)).rejects.toThrow("anchor not found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
