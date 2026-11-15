/**
 * `ensurePorfforA21(channel)`: acquire the Porffor compiler tree. Takes the vendored PATCHED tarball (`vendor/porffor-patched.tar.gz`: upstream's pinned commit with the
 * series in `porffor-patches/` applied, `scripts/porffor-patches.ts vendor`), verifies its sha256 against the
 * manifest, extracts it and publishes the tree atomically under the toolchain cache, keyed by commit and by
 * the series hash. Nothing is patched here: no git, no bun and no network on the user's machine.
 * Used by sproutd's standalone channel and the CLI's standalone builds, which need the same cached shape.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
// @ts-expect-error Bun's file loader supplies a path.
import vendoredPatched from "../../vendor/porffor-patched.tar.gz" with { type: "file" };
import { version as TOOLCHAIN_VERSION } from "../../package.json" with { type: "json" };
import { A21_PATCH_FINGERPRINT } from "./fingerprint";
import { PORFFOR_A21_PINS, type PorfforA21Channel, type PorfforA21Pin } from "./pin";

export class PorfforToolchainError extends Error {
  constructor(
    readonly kind: "download" | "integrity" | "archive" | "cache" | "unsupported",
    message: string,
  ) {
    super(message);
  }
}

const required = [
  "runtime/index.js",
  "compiler/render.js",
  "compiler/index.js",
  "compiler/codegen.js",
  "compiler/modules.js",
  "compiler/precompile.js",
  "compiler/builtins_precompiled.js",
];

type AcquireOptions = {
  cacheRoot?: string;
};

async function digest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function complete(dir: string, pin: PorfforA21Pin): Promise<boolean> {
  try {
    // SAFETY: the cache manifest is private data written below; every consumed field is checked.
    const manifest = JSON.parse(await readFile(resolve(dir, ".sproutboat-complete"), "utf8")) as {
      commit?: string;
      archiveSha256?: string;
      toolchainVersion?: string;
      patchFingerprint?: string;
      files?: Record<string, string>;
    };
    if (
      manifest.commit !== pin.commitFull ||
      manifest.archiveSha256 !== pin.archiveSha256 ||
      manifest.toolchainVersion !== TOOLCHAIN_VERSION ||
      manifest.patchFingerprint !== A21_PATCH_FINGERPRINT
    )
      return false;
    for (const file of required)
      if (!manifest.files?.[file] || (await digest(resolve(dir, file))) !== manifest.files[file]) return false;
    return true;
  } catch {
    return false;
  }
}

async function extract(archive: string, stage: string): Promise<void> {
  const child = Bun.spawn(["tar", "-xzf", archive, "-C", stage, "--strip-components=1"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0)
    throw new PorfforToolchainError("archive", `could not extract the vendored Porffor archive: ${stderr.trim()}`);
  for (const file of required)
    if (!existsSync(resolve(stage, file)))
      throw new PorfforToolchainError("archive", `Porffor archive is missing required file ${file}`);
}

async function waitForPublisher(dir: string, lock: string, pin: PorfforA21Pin): Promise<string | null> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await complete(dir, pin)) return dir;
    if (!existsSync(lock)) return null;
    const age = Date.now() - (await stat(lock)).mtimeMs;
    if (age > 5 * 60_000) {
      await rm(lock, { recursive: true, force: true });
      return null;
    }
    await Bun.sleep(25);
  }
  throw new PorfforToolchainError("cache", `timed out waiting for Porffor cache lock ${lock}`);
}

/** The cache directory of a channel's patched tree (whether or not it exists yet). */
export function cachedPorfforA21Root(
  channel: PorfforA21Channel,
  root = process.env.SPROUTBOAT_TOOLCHAIN_CACHE ?? resolve(homedir(), ".cache/sproutboat"),
): string {
  return resolve(root, `porffor-${PORFFOR_A21_PINS[channel].commitFull}-a21-${A21_PATCH_FINGERPRINT}`);
}

/**
 * Acquire the patched compiler into a verified, atomically published cache
 * entry and return its path. `SPROUTBOAT_PORFFOR_DIR` overrides it with a tree you point at.
 */
export async function ensurePorfforA21(channel: PorfforA21Channel, options: AcquireOptions = {}): Promise<string> {
  const pin = PORFFOR_A21_PINS[channel];
  if (!pin) throw new PorfforToolchainError("unsupported", `unknown Porffor channel ${channel}`);
  const override = process.env.SPROUTBOAT_PORFFOR_DIR;
  if (override) {
    const dir = resolve(override);
    for (const file of required)
      if (!existsSync(resolve(dir, file)))
        throw new PorfforToolchainError("unsupported", `SPROUTBOAT_PORFFOR_DIR is missing ${file}`);
    return dir;
  }
  const root = resolve(
    options.cacheRoot ?? process.env.SPROUTBOAT_TOOLCHAIN_CACHE ?? resolve(homedir(), ".cache/sproutboat"),
  );
  const dir = cachedPorfforA21Root(channel, root);
  if (await complete(dir, pin)) return dir;
  await mkdir(root, { recursive: true });
  const lock = `${dir}.lock`;
  try {
    await mkdir(lock);
  } catch {
    const published = await waitForPublisher(dir, lock, pin);
    if (published) return published;
    return ensurePorfforA21(channel, options);
  }
  const stage = resolve(
    root,
    `.porffor-${pin.commitFull}-a21-${A21_PATCH_FINGERPRINT}-${process.pid}-${crypto.randomUUID()}`,
  );
  try {
    if (await complete(dir, pin)) return dir;
    await rm(dir, { recursive: true, force: true });
    await mkdir(stage);
    const archive = resolve(stage, "source.tar.gz");
    // The vendored file is the only source: the patched tree cannot be downloaded from upstream.
    if (!existsSync(vendoredPatched))
      throw new PorfforToolchainError("archive", `the vendored Porffor archive is missing: ${vendoredPatched}`);
    await writeFile(archive, await readFile(vendoredPatched));
    const actual = await digest(archive);
    if (actual !== pin.archiveSha256)
      throw new PorfforToolchainError(
        "integrity",
        `vendored Porffor archive sha256 mismatch\n  expected ${pin.archiveSha256}\n  got      ${actual}`,
      );
    await extract(archive, stage);
    await rm(archive, { force: true });
    const files = Object.fromEntries(
      await Promise.all(required.map(async (file) => [file, await digest(resolve(stage, file))] as const)),
    );
    await writeFile(
      resolve(stage, ".sproutboat-complete"),
      JSON.stringify({
        commit: pin.commitFull,
        archiveSha256: actual,
        toolchainVersion: TOOLCHAIN_VERSION,
        patchFingerprint: A21_PATCH_FINGERPRINT,
        channel,
        files,
      }),
      { mode: 0o444 },
    );
    await rename(stage, dir);
    return dir;
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
