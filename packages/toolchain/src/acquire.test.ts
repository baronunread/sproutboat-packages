import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ensurePorffor, PORFFOR_COMMIT_FULL, PorfforToolchainError } from "./index";
import { PATCH_FINGERPRINT } from "./fingerprint";
import { NATIVE_BYTES_LAYOUT, NATIVE_BYTES_MARKER, NATIVE_BYTES_RENDER_ANCHOR } from "./native-bytes";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{ archive: string; sha256: string }> {
  const root = await mkdtemp(join(tmpdir(), "sb-porffor-fixture-"));
  temporary.push(root);
  const source = join(root, `porffor-${PORFFOR_COMMIT_FULL}`);
  const files = {
    "runtime/index.js": "fixture:runtime/index.js\n",
    // patchNativeBytes' anchor.
    "compiler/render.js": NATIVE_BYTES_RENDER_ANCHOR,
    // patchCompilerArgs' anchors.
    "compiler/index.js":
      "      const compileOnlyArgs = [\n        ...darwinReleaseCompileArgs,\n      ];\n" +
      "      const args = [\n        '-lm', // link math.h\n        ...libs.ldflags,\n      ];\n",
    "compiler/precompile.js":
      "const fs = require('node:fs');\n" +
      "const path = require('node:path');\n" +
      "fs.writeFileSync(path.join(__dirname, 'builtins_precompiled.js'), fs.readFileSync(path.join(__dirname, 'builtins/typedarray.js')));\n",
    "compiler/builtins_precompiled.js": "fixture:precompiled\n",
    "compiler/builtins/date.ts": "export const __ecma262_ParseDTSF = (string: string) => {\n};\n",
    "compiler/builtins/arraybuffer.ts": "// maxByteLength -1 for fixed length, -2 for immutable\n",
    "compiler/builtins/typedarray.js": NATIVE_BYTES_LAYOUT + "\n",
    "compiler/uwebsockets.js": "fixture:uwebsockets\n",
    // patchNavigatorWritable's anchor.
    "compiler/builtins.js":
      "      writable: false,\n      enumerable: true,\n      configurable: false\n    }, {\n      userAgent: 'x'\n",
    "compiler/builtins/regexp.ts":
      "export const __RegExp_prototype_Symbol_replace = function (this: any, string: any, replaceValue: any) {\n" +
      "  if (pristine && !functional && __Porffor_regex_flagIn(replaceValue, 36) == false) return __Porffor_regex_replacePlain(rx, s, replaceValue);\n" +
      "  let acc: any = '';\n" +
      "      acc = __Porffor_strcat(__Porffor_strcat(acc, __Porffor_regex_inputSubstring(s, sType, nextPos, position)), replacement);\n" +
      "  if (nextPos >= lengthS) return acc;\n  return __Porffor_strcat(acc, __Porffor_regex_inputSubstring(s, sType, nextPos, lengthS));\n" +
      "};\nexport const __RegExp_prototype_Symbol_split = function (this: any, string: any, limit: any) {};\n",
    "compiler/builtins/string.ts":
      "export const __String_prototype_toUpperCase = function (this: string) {\n" +
      "    if (chr >= 97) if (chr <= 122) chr -= 32;\n\n    Porffor.IR.storeU16(j, 4, chr);\n" +
      "    if (chr >= 97) if (chr <= 122) chr -= 32;\n\n    Porffor.IR.storeU8(j++, 4, chr);\n" +
      "    if (chr >= 65) if (chr <= 90) chr += 32;\n\n    Porffor.IR.storeU16(j, 4, chr);\n" +
      "    if (chr >= 65) if (chr <= 90) chr += 32;\n\n    Porffor.IR.storeU8(j++, 4, chr);\n" +
      "  for (let i: i32 = 0; i < count; i++) {\n    Porffor.IR.copy(Porffor.IR.ptr(out) + 4 + i * thisLen, Porffor.IR.ptr(this) + 4, thisLen);\n  }\n" +
      "  for (let i: i32 = 0; i < count; i++) {\n    Porffor.IR.copy(Porffor.IR.ptr(out) + 4 + i * thisLen, Porffor.IR.ptr(this) + 4, thisLen);\n  }\n" +
      "export const __Porffor_string_replaceAll = (str: any, searchValue: any, replaceValue: any) => {\n" +
      "  let out: any = __Porffor_string_emptyLike(str);\n  let appendIndex: i32 = 0;\n  let searchIndex: i32 = 0;\n  let matched: boolean = false;\n" +
      "    out = __Porffor_strcat(out, __Porffor_string_substringLike(str, appendIndex, matchIndex));\n    out = __Porffor_strcat(out, __Porffor_string_applyReplacer(str, match, matchIndex, replaceValue));\n" +
      "  if (!matched) return str;\n  return __Porffor_strcat(out, __Porffor_string_substringLike(str, appendIndex, thisLen));\n};\n" +
      "export const __String_prototype_replaceAll = function (this: string, searchValue: any, replaceValue: any) {};\n",
  };
  for (const [file, contents] of Object.entries(files)) {
    const path = join(source, file);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents);
  }
  const archive = join(root, "porffor.tar.gz");
  const tar = Bun.spawn(["tar", "-czf", archive, "-C", root, basename(source)], { stderr: "pipe" });
  const [code, stderr] = await Promise.all([tar.exited, new Response(tar.stderr).text()]);
  if (code !== 0) throw new Error(`could not create fixture: ${stderr}`);
  const sha256 = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  return { archive, sha256 };
}

test("Porffor acquisition is atomic, shared concurrently, and warm-cache offline", async () => {
  const { archive, sha256 } = await fixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-porffor-cache-"));
  temporary.push(cacheRoot);
  let requests = 0;
  const fetcher = async () => {
    requests += 1;
    await Bun.sleep(5);
    return new Response(Bun.file(archive));
  };
  const options = { cacheRoot, url: "fixture", expectedSha256: sha256, fetcher };
  const roots = await Promise.all(Array.from({ length: 8 }, () => ensurePorffor(options)));
  expect(new Set(roots).size).toBe(1);
  expect(requests).toBe(1);
  expect((await readdir(cacheRoot)).filter((name) => name.startsWith(".porffor-"))).toEqual([]);
  const offline = await ensurePorffor({
    ...options,
    fetcher: async () => {
      throw new Error("offline fetch must not run");
    },
  });
  expect(offline).toBe(roots[0]);
});

test("integrity failures stop acquisition and publish no cache entry", async () => {
  const { archive } = await fixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-porffor-integrity-"));
  temporary.push(cacheRoot);
  const error = await ensurePorffor({
    cacheRoot,
    url: "fixture",
    expectedSha256: "0".repeat(64),
    fetcher: async () => new Response(Bun.file(archive)),
  }).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(PorfforToolchainError);
  if (!(error instanceof PorfforToolchainError)) throw error;
  expect(error.kind).toBe("integrity");
  expect((await readdir(cacheRoot)).some((name) => name.startsWith("porffor-"))).toBe(false);
});

test("the default call (no url/expectedSha256 override) never touches the network", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-porffor-vendored-"));
  temporary.push(cacheRoot);
  const dir = await ensurePorffor({
    cacheRoot,
    fetcher: async () => {
      throw new Error("the vendored archive must be used before any network fetch");
    },
  });
  expect(await readFile(join(dir, "runtime/index.js"), "utf8")).not.toBe("");
  const compiler = async (file: string) => readFile(join(dir, file), "utf8");
  // The surviving edits, each justified by a failing test or program on stock alpha 20.
  expect(await compiler("compiler/index.js")).toContain("process.env.SB_EXTRA_LINK");
  expect(await compiler("compiler/index.js")).toContain("process.env.SB_EXTRA_CFLAGS");
  expect(await compiler("compiler/builtins.js")).toContain("sproutboat: navigator is writable");
  expect(await compiler("compiler/builtins/string.ts")).toContain("sproutboat B16: doubling repeat");
  expect(await compiler("compiler/builtins/string.ts")).toContain("sproutboat #237: pieces joined once");
  expect(await compiler("compiler/builtins/string.ts")).toContain("sproutboat: Unicode case mapping");
  expect(await compiler("compiler/builtins/regexp.ts")).toContain("__Porffor_regex_replaceCallback");
  expect(await compiler("compiler/render.js")).toContain(NATIVE_BYTES_MARKER);
}, 120_000);

test("a corrupted warm cache is replaced from the verified archive", async () => {
  const { archive, sha256 } = await fixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-porffor-corrupt-"));
  temporary.push(cacheRoot);
  let requests = 0;
  const options = {
    cacheRoot,
    url: "fixture",
    expectedSha256: sha256,
    fetcher: async () => {
      requests += 1;
      return new Response(Bun.file(archive));
    },
  };
  const root = await ensurePorffor(options);
  await writeFile(join(root, "compiler/render.js"), "corrupt");
  await ensurePorffor(options);
  expect(requests).toBe(2);
  expect(await readFile(join(root, "compiler/index.js"), "utf8")).toContain("SB_EXTRA_LINK");
});

test("a cache built by an older toolchain version is rebuilt, not silently reused", async () => {
  const { archive, sha256 } = await fixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-porffor-stale-toolchain-"));
  temporary.push(cacheRoot);
  let requests = 0;
  const options = {
    cacheRoot,
    url: "fixture",
    expectedSha256: sha256,
    fetcher: async () => {
      requests += 1;
      return new Response(Bun.file(archive));
    },
  };
  const root = await ensurePorffor(options);
  const manifestPath = join(root, ".sproutboat-complete");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  expect(manifest.toolchainVersion).toBeTruthy();
  // Simulate a cache left behind by an older @sproutboat/toolchain publish
  // (baronunread/sproutboat#205): a patch.ts fix landing in a new version used
  // to sit unused because the cache key only tracked the upstream commit.
  await rm(manifestPath);
  await writeFile(manifestPath, JSON.stringify({ ...manifest, toolchainVersion: "0.0.0-stale" }));
  await ensurePorffor(options);
  expect(requests).toBe(2);
  const rebuilt = JSON.parse(await readFile(manifestPath, "utf8"));
  expect(rebuilt.toolchainVersion).toBe(manifest.toolchainVersion);
  // B19: an unreleased patch edit keeps the version; the patch fingerprint still rebuilds.
  expect(rebuilt.patchFingerprint).toBe(PATCH_FINGERPRINT);
  expect(root).toEndWith(`-${PATCH_FINGERPRINT}`);
  await rm(manifestPath);
  await writeFile(manifestPath, JSON.stringify({ ...rebuilt, patchFingerprint: "000000000000" }));
  await ensurePorffor(options);
  expect(requests).toBe(3);
  expect(JSON.parse(await readFile(manifestPath, "utf8")).patchFingerprint).toBe(PATCH_FINGERPRINT);
});

test("an interrupted stale lock is recovered", async () => {
  const { archive, sha256 } = await fixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-porffor-interrupted-"));
  temporary.push(cacheRoot);
  const lock = join(cacheRoot, `porffor-${PORFFOR_COMMIT_FULL}-${PATCH_FINGERPRINT}.lock`);
  await mkdir(lock);
  const stale = new Date(Date.now() - 10 * 60_000);
  await utimes(lock, stale, stale);
  const root = await ensurePorffor({
    cacheRoot,
    url: "fixture",
    expectedSha256: sha256,
    fetcher: async () => new Response(Bun.file(archive)),
  });
  expect(await readFile(join(root, "runtime/index.js"), "utf8")).toContain("fixture:");
  expect((await readdir(cacheRoot)).some((name) => name.endsWith(".lock"))).toBe(false);
});

test("download failures are classified without publishing partial state", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-porffor-download-"));
  temporary.push(cacheRoot);
  let attempts = 0;
  const error = await ensurePorffor({
    cacheRoot,
    url: "https://invalid.test/source.tar.gz",
    fetcher: async () => {
      attempts += 1;
      throw new Error("offline");
    },
  }).catch((cause: unknown) => cause);
  if (!(error instanceof PorfforToolchainError)) throw error;
  expect(error.kind).toBe("download");
  expect(attempts).toBe(2);
  expect(await readdir(cacheRoot)).toEqual([]);
});

test("the vendored archive is the one PORFFOR_ARCHIVE_URL serves: its root is porffor-<full commit>", () => {
  // codeload names the root after the ref in the URL, so an archive fetched by the short
  // commit has another root and digest than the pinned URL's, though the same files.
  const archive = join(import.meta.dir, `../vendor/porffor-${PORFFOR_COMMIT_FULL.slice(0, 7)}.tar.gz`);
  const list = Bun.spawnSync(["tar", "-tzf", archive], { stdout: "pipe" });
  expect(list.exitCode).toBe(0);
  expect(list.stdout.toString().split("\n")[0]).toBe(`porffor-${PORFFOR_COMMIT_FULL}/`);
});
