/**
 * The standalone server's own sources, vendored as first-class files (`sources.json` is the
 * provenance): the uWebSockets server shim, the web classes, and the three patches the uWebSockets
 * checkout is compiled with. Until 2026-11-15 the standalone build on alpha 24 took all of them from
 * a patched Porffor alpha 19 tree it acquired just for that; they are maintained here now, and the
 * toolchain no longer carries alpha 19.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import manifest from "./sources.json" with { type: "json" };
import { applyFileHunks, parseUnifiedPatch } from "./unified-patch";
// @ts-expect-error Bun's text loader supplies a string.
import shimFile from "./uws-shim.cpp" with { type: "text" };
// @ts-expect-error Bun's text loader supplies a string.
import webClassesFile from "./web-classes.js" with { type: "text" };
// @ts-expect-error Bun's text loader supplies a string.
import patch0001 from "./uws-patches/0001-remove-default-404.patch" with { type: "text" };
// @ts-expect-error Bun's text loader supplies a string.
import patch0002 from "./uws-patches/0002-shorten-uws-errors.patch" with { type: "text" };
// @ts-expect-error Bun's text loader supplies a string.
import patch0003 from "./uws-patches/0003-http10.patch" with { type: "text" };

export const UWS_REPO_URL: string = manifest.uWebSockets.repo;
/** The uWebSockets commit the standalone server is compiled against. */
export const UWS_COMMIT: string = manifest.uWebSockets.commit;

/** Every vendored text file starts with a provenance header that ends with this line; the content follows it. */
export const PROVENANCE_END = "// ---- end of provenance header ----\n";

export function stripProvenance(text: string, name: string): string {
  const at = text.indexOf(PROVENANCE_END);
  if (at < 0) throw new Error(`${name}: no provenance header end marker`);
  return text.slice(at + PROVENANCE_END.length);
}

/** The patched uWebSockets server shim (C++), before `standaloneShimA22` rewrites it for the flat bridge. */
export function uwsShimSource(): string {
  return stripProvenance(shimFile, "uws-shim.cpp");
}

/** The web classes (Headers, Blob, File, TextEncoder, TextDecoder, URL, Request, Response), each assigned on globalThis. */
export function webClassesSource(): string {
  return stripProvenance(webClassesFile, "web-classes.js");
}

/** The patches applied to a fresh uWebSockets checkout, in order; the last is sproutboat #236 (HTTP/1.0). */
export const UWS_PATCHES: readonly { name: string; text: string }[] = [
  { name: "0001-remove-default-404.patch", text: patch0001 },
  { name: "0002-shorten-uws-errors.patch", text: patch0002 },
  { name: "0003-http10.patch", text: patch0003 },
];

/**
 * Apply the vendored patches to a uWebSockets checkout (`dir/src/...`); files already patched are left
 * alone, so this is safe on a freshly fetched checkout, on the CLI's seeded cache and on a reused one.
 * Returns true when it changed a file.
 */
export async function applyUwsPatches(dir: string, only?: (name: string) => boolean): Promise<boolean> {
  let changed = false;
  for (const { name, text } of UWS_PATCHES) {
    if (only && !only(name)) continue;
    for (const file of parseUnifiedPatch(text)) {
      const path = join(dir, file.path);
      const next = applyFileHunks(await readFile(path, "utf8"), file);
      if (next === null) continue;
      await writeFile(path, next);
      changed = true;
    }
  }
  return changed;
}

/** sproutboat #236, the HTTP/1.0 edit alone (the last vendored patch). */
export async function applyUwsHttp10(dir: string): Promise<boolean> {
  return applyUwsPatches(dir, (name) => name === "0003-http10.patch");
}

async function run(argv: string[], cwd?: string, env?: Record<string, string>): Promise<void> {
  const child = Bun.spawn(argv, {
    cwd,
    env: env ? { ...process.env, ...env } : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${argv.slice(0, 2).join(" ")} failed (${code}): ${(err || out).trim().slice(-600)}`);
}

/** sha256 over a tree's files (sorted `path\0sha256\n`), the form `sources.json` records. */
export async function treeSha256(dir: string): Promise<string> {
  const files: string[] = [];
  const walk = async (rel: string) => {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(next);
      else files.push(next);
    }
  };
  await walk("");
  files.sort();
  const hash = createHash("sha256");
  for (const file of files)
    hash.update(
      `${file}\0${createHash("sha256")
        .update(await readFile(join(dir, file)))
        .digest("hex")}\n`,
    );
  return hash.digest("hex");
}

/**
 * The host uWebSockets checkout with `uSockets/uSockets.a` built, kept where the alpha 19 compiler kept it
 * (`~/.cache/porffor/deps/uWebSockets-<commit>`, so existing caches are reused): the CLI seeds the
 * cross-target checkouts from its vendored archive; a host build without one fetches the pinned commit
 * (git), applies the vendored patches, and builds uSockets (make, `CC` or `cc`).
 */
export async function ensureHostUws(): Promise<string> {
  const cacheRoot = resolve(homedir(), ".cache/porffor/deps");
  const dir = join(cacheRoot, `uWebSockets-${UWS_COMMIT}`);
  if (!existsSync(join(dir, "src/App.h")) || !existsSync(join(dir, "uSockets/src"))) {
    await mkdir(cacheRoot, { recursive: true });
    const temp = join(cacheRoot, `.uWebSockets-${process.pid}-${Date.now()}`);
    await rm(temp, { recursive: true, force: true });
    await mkdir(temp, { recursive: true });
    try {
      await run(["git", "init"], temp);
      await run(["git", "remote", "add", "origin", UWS_REPO_URL], temp);
      await run(["git", "fetch", "--depth", "1", "origin", UWS_COMMIT], temp);
      await run(["git", "checkout", "--detach", "FETCH_HEAD"], temp);
      await run(["git", "submodule", "update", "--init", "--depth", "1", "uSockets"], temp);
      await applyUwsPatches(temp);
      await rm(dir, { recursive: true, force: true });
      await rename(temp, dir);
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      throw error;
    }
  }
  if (!existsSync(join(dir, "uSockets/uSockets.a"))) {
    await run(
      [
        "make",
        "-C",
        join(dir, "uSockets"),
        "WITH_OPENSSL=0",
        "WITH_BORINGSSL=0",
        "WITH_WOLFSSL=0",
        "WITH_QUIC=0",
        "WITH_IO_URING=0",
        "WITH_LIBUV=0",
        "WITH_ASIO=0",
      ],
      undefined,
      { CC: process.env.CC ?? "cc" },
    );
    if (!existsSync(join(dir, "uSockets/uSockets.a")))
      throw new Error("uSockets build completed without producing uSockets.a");
  }
  return dir;
}
