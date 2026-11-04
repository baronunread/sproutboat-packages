import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BEARSSL_SHA256, BEARSSL_URLS, BEARSSL_VERSION } from "../../toolchain/src/deps";
import { fetchPinned } from "../../toolchain/src/fetch-pinned";

// The prelude carries crypto.subtle's native half on every transport, so a test that compiles a
// handler using crypto.subtle needs BearSSL on the include path and link line, as the CLI arranges
// for a build. Same pinned source as the CLI's src/bearssl.ts; built once into the toolchain cache.
const VERSION = BEARSSL_VERSION;

const walk = async (dir: string): Promise<string[]> =>
  (
    await Promise.all(
      (await readdir(dir, { withFileTypes: true })).map((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name))
          : Promise.resolve(entry.name.endsWith(".c") ? [join(dir, entry.name)] : []),
      ),
    )
  ).flat();

/** `SB_EXTRA_CFLAGS` and `SB_EXTRA_LINK` for a host Porffor compile that uses crypto.subtle. */
export async function bearsslEnv(): Promise<{ SB_EXTRA_CFLAGS: string; SB_EXTRA_LINK: string }> {
  const root = resolve(
    process.env.SPROUTBOAT_TOOLCHAIN_CACHE ?? join(homedir(), ".cache/sproutboat"),
    `bearssl-${VERSION}-test`,
  );
  const tree = join(root, `BearSSL-${VERSION}`);
  const objects = join(root, "obj");
  const marker = join(objects, ".complete");
  if (!existsSync(marker)) {
    await mkdir(root, { recursive: true });
    // Mirror list, bounded retry and sha256 pin: see toolchain/src/deps.ts. The verified tarball is also kept
    // in a cache that CI restores by hash, so a cold build cache does not depend on any server being up.
    const bytes = await fetchPinned({
      urls: BEARSSL_URLS,
      sha256: BEARSSL_SHA256,
      cachePath: join(dirname(root), "deps", `bearssl-src-${BEARSSL_SHA256}.tar.gz`),
    });
    await writeFile(join(root, "bearssl.tar.gz"), bytes);
    await rm(tree, { recursive: true, force: true });
    const untar = Bun.spawnSync(["tar", "xzf", join(root, "bearssl.tar.gz"), "-C", root]);
    if (untar.exitCode !== 0) throw new Error(`could not unpack BearSSL: ${untar.stderr}`);
    const stage = `${objects}.${process.pid}`;
    await rm(stage, { recursive: true, force: true });
    await mkdir(stage, { recursive: true });
    const cc = process.env.CC ?? "cc";
    const sources = await walk(join(tree, "src"));
    const queue = [...sources];
    const worker = async () => {
      for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
        const out = join(stage, `${file.split("/").pop()!.replace(/\.c$/, "")}.o`);
        const run = Bun.spawn([cc, "-Os", "-I", join(tree, "inc"), "-I", join(tree, "src"), "-c", file, "-o", out], {
          stderr: "pipe",
        });
        if ((await run.exited) !== 0)
          throw new Error(`could not compile ${file}: ${await new Response(run.stderr).text()}`);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    await writeFile(join(stage, ".complete"), "");
    await rm(objects, { recursive: true, force: true });
    await rename(stage, objects);
  }
  const names = (await readdir(objects)).filter((name) => name.endsWith(".o")).sort();
  return {
    SB_EXTRA_CFLAGS: `-I ${join(tree, "inc")}`,
    SB_EXTRA_LINK: names.map((name) => join(objects, name)).join(" "),
  };
}
