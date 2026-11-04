import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type FetchPinnedOptions = {
  /** A vendored copy read from disk before any network source. Used only if its hash matches. */
  localPath?: string;
  /** Ordered download sources, tried after the vendored copy. Every one must serve the same bytes. */
  urls: readonly string[];
  /** Lowercase hex sha256 of the exact bytes. A source that serves anything else is rejected. */
  sha256: string;
  /** A verified copy is kept here (written atomically) and reused while its hash matches. */
  cachePath?: string;
  fetcher?: Fetcher;
  /** Attempts per source for a 5xx or a network error. 4xx and a hash mismatch are never retried. */
  attempts?: number;
  /** First backoff; doubles each retry. */
  backoffMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** A failure that will not change on retry: a 4xx, or bytes that fail the pin. */
class Permanent extends Error {}

/**
 * Return a build-time dependency's bytes, only if they hash to the pinned sha256: first the vendored
 * file (`localPath`), then the ordered download list. The pin is what makes every source safe: one
 * that has different bytes (a tampered vendored file included) is skipped, so the list can only
 * improve availability, never change what gets built. A 5xx or a network error is retried with exponential backoff (bounded); a 4xx or a
 * hash mismatch moves straight on to the next source.
 */
export async function fetchPinned(options: FetchPinnedOptions): Promise<Buffer> {
  const sha256 = options.sha256.toLowerCase();
  const fetcher: Fetcher = options.fetcher ?? fetch;
  const attempts = Math.max(1, options.attempts ?? 3);
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  if (options.localPath && existsSync(options.localPath)) {
    const vendored = await readFile(options.localPath);
    if (sha256Hex(vendored) === sha256) return vendored;
    console.warn(
      `fetchPinned: vendored ${options.localPath} does not match the pinned sha256, falling back to download`,
    );
  }
  if (options.cachePath && existsSync(options.cachePath)) {
    const cached = await readFile(options.cachePath);
    if (sha256Hex(cached) === sha256) return cached;
    await rm(options.cachePath, { force: true });
  }
  const failures: string[] = [];
  for (const url of options.urls) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep((options.backoffMs ?? 500) * 2 ** (attempt - 1));
      try {
        const response = await fetcher(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 60_000) });
        if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
        if (!response.ok) throw new Permanent(`HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        const got = sha256Hex(bytes);
        if (got !== sha256) throw new Permanent(`sha256 mismatch (expected ${sha256}, got ${got})`);
        if (options.cachePath) {
          await mkdir(dirname(options.cachePath), { recursive: true });
          const stage = `${options.cachePath}.${process.pid}.tmp`;
          await writeFile(stage, bytes);
          await rename(stage, options.cachePath);
        }
        return bytes;
      } catch (error) {
        failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof Permanent) break;
      }
    }
  }
  throw new Error(`could not download a verified copy (sha256 ${sha256}) from any source:\n  ${failures.join("\n  ")}`);
}
