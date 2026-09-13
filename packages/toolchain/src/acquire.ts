import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
// @ts-expect-error Bun's file loader supplies a path; see the pinned-commit
// check below for why this is safe to trust unconditionally.
import vendoredPorfforArchive from "../vendor/porffor-1f4ae4a.tar.gz" with { type: "file" };
import { ensurePorfforPatched } from "./patch";
import { PORFFOR_ARCHIVE_SHA256, PORFFOR_ARCHIVE_URL, PORFFOR_COMMIT_FULL } from "./pin";

export class PorfforToolchainError extends Error {
  constructor(
    readonly kind: "download" | "integrity" | "archive" | "cache" | "unsupported",
    message: string,
  ) {
    super(message);
  }
}

type AcquireOptions = {
  cacheRoot?: string;
  url?: string;
  expectedSha256?: string;
  fetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
};

const required = ["runtime/index.js", "compiler/render.js", "compiler/index.js", "compiler/uwebsockets.js"];
async function digest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function complete(dir: string, expectedArchive = PORFFOR_ARCHIVE_SHA256): Promise<boolean> {
  try {
    // SAFETY: the cache manifest is private data written below; every consumed
    // field is still checked before it can make the cache valid.
    const manifest = JSON.parse(await readFile(resolve(dir, ".sproutboat-complete"), "utf8")) as {
      commit?: string;
      archiveSha256?: string;
      files?: Record<string, string>;
    };
    if (manifest.commit !== PORFFOR_COMMIT_FULL || manifest.archiveSha256 !== expectedArchive) return false;
    for (const file of required)
      if (!manifest.files?.[file] || (await digest(resolve(dir, file))) !== manifest.files[file]) return false;
    return true;
  } catch {
    return false;
  }
}

async function download(
  url: string,
  path: string,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  timeoutMs: number,
): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await writeFile(path, new Uint8Array(await response.arrayBuffer()));
      return;
    } catch (error) {
      last = error;
    }
  }
  throw new PorfforToolchainError(
    "download",
    `could not download pinned Porffor from ${url}: ${last instanceof Error ? last.message : String(last)}`,
  );
}

async function extract(archive: string, stage: string): Promise<void> {
  const child = Bun.spawn(["tar", "-xzf", archive, "-C", stage, "--strip-components=1"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0)
    throw new PorfforToolchainError("archive", `could not extract pinned Porffor archive: ${stderr.trim()}`);
  for (const file of required)
    if (!existsSync(resolve(stage, file)))
      throw new PorfforToolchainError("archive", `Porffor archive is missing required file ${file}`);
}

async function waitForPublisher(dir: string, lock: string): Promise<string | null> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await complete(dir)) return dir;
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

/** Acquire the immutable compiler source into a verified, atomically published cache entry. */
export async function ensurePorffor(options: AcquireOptions = {}): Promise<string> {
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
  const dir = resolve(root, `porffor-${PORFFOR_COMMIT_FULL}`);
  const expected = options.expectedSha256 ?? PORFFOR_ARCHIVE_SHA256;
  if (await complete(dir, expected)) return dir;
  await mkdir(root, { recursive: true });
  const lock = `${dir}.lock`;
  try {
    await mkdir(lock);
  } catch {
    const published = await waitForPublisher(dir, lock);
    if (published) return published;
    return ensurePorffor(options);
  }
  const stage = resolve(root, `.porffor-${PORFFOR_COMMIT_FULL}-${process.pid}-${crypto.randomUUID()}`);
  try {
    if (await complete(dir, expected)) return dir;
    await rm(dir, { recursive: true, force: true });
    await mkdir(stage);
    const archive = resolve(stage, "source.tar.gz");
    // The commit tarball ships in the package (`vendor/`), same pattern as
    // sproutboat-cli's vendored uWebSockets archive: no network needed on the
    // happy path. Falls back to downloading it if the file is missing or was
    // left stale by a pin bump (checksum below still catches a wrong file
    // rather than silently accepting it).
    const noOverride = options.url === undefined && options.expectedSha256 === undefined;
    const vendored = noOverride && existsSync(vendoredPorfforArchive) && (await digest(vendoredPorfforArchive)) === expected;
    if (vendored) await writeFile(archive, await readFile(vendoredPorfforArchive));
    else await download(options.url ?? PORFFOR_ARCHIVE_URL, archive, options.fetcher ?? fetch, options.timeoutMs ?? 30_000);
    const actual = await digest(archive);
    if (actual !== expected)
      throw new PorfforToolchainError(
        "integrity",
        `Porffor archive sha256 mismatch\n  expected ${expected}\n  got      ${actual}`,
      );
    await extract(archive, stage);
    await rm(archive, { force: true });
    await ensurePorfforPatched(stage);
    const files = Object.fromEntries(
      await Promise.all(required.map(async (file) => [file, await digest(resolve(stage, file))] as const)),
    );
    await writeFile(
      resolve(stage, ".sproutboat-complete"),
      JSON.stringify({ commit: PORFFOR_COMMIT_FULL, archiveSha256: actual, files }),
      { mode: 0o444 },
    );
    await rename(stage, dir);
    return dir;
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

export function cachedPorfforRoot(
  root = process.env.SPROUTBOAT_TOOLCHAIN_CACHE ?? resolve(homedir(), ".cache/sproutboat"),
): string {
  return resolve(root, `porffor-${PORFFOR_COMMIT_FULL}`);
}
