#!/usr/bin/env bun
/**
 * Runs the `test:native-*` package scripts a few at a time instead of one after
 * another. Each one compiles a handler with Porffor and drives the binary, so
 * they spend most of their time in the C compiler and parallelise well.
 *
 *   bun scripts/test-native.ts                  # every test:native-* script
 *   bun scripts/test-native.ts crypto base64    # only these (prefix optional)
 *
 * NATIVE_TEST_CONCURRENCY sets how many run at once (default 4).
 * NATIVE_TEST_TIMEOUT_MS kills a script that runs longer (default 10 minutes).
 *
 * Every script asks for a Porffor toolchain in a fresh temp directory, which
 * means unpacking, patching and precompiling it again each time. This runner
 * prepares one toolchain up front, in the normal cache, and hands it to every
 * script through SPROUTBOAT_PORFFOR_DIR. The cache entry is keyed by the patch
 * fingerprint, so an edited patch still gets a freshly patched compiler. Set
 * SPROUTBOAT_PORFFOR_DIR yourself to use a different toolchain, or
 * NATIVE_TEST_FRESH_PORFFOR=1 to let every script prepare its own.
 *
 * The first native compile on a machine also fetches uWebSockets, patches it and
 * builds uSockets.a in ~/.cache/porffor/deps, shared by every compile. Four
 * compilers doing that at once trip over each other (CI failed with uSockets
 * sources missing mid-build), so the quickest script runs alone first and the
 * rest start once it has finished. After that the compilers only read it.
 *
 * The scripts bind their ports with a port-0 probe (`freePort()`) or `port: 0`,
 * never a fixed number, so running them side by side does not make them collide.
 */
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../packages/toolchain/src/acquire";

const ROOT = resolve(import.meta.dir, "..");
const PREFIX = "test:native-";

type Outcome = { name: string; ok: boolean; seconds: number; output: string };

function positiveInteger(raw: string | undefined, fallback: number, variable: string): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`${variable} must be a positive integer, got "${raw}"`);
    process.exit(2);
  }
  return value;
}

/** Bytes of the test file a script runs: the larger ones run more cases and take longest. */
function testFileSize(command: string): number {
  const file = command.split(/\s+/).find((word) => word.endsWith(".ts"));
  try {
    return file === undefined ? 0 : statSync(join(ROOT, file)).size;
  } catch {
    return 0;
  }
}

/** The scripts to run, largest test file first so the slowest one doesn't finish alone at the end. The last is the quickest. */
function nativeScripts(filters: string[]): string[] {
  const manifest: { scripts?: Record<string, string> } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const commands = new Map(Object.entries(manifest.scripts ?? {}).filter(([name]) => name.startsWith(PREFIX)));
  const all = [...commands.keys()].sort();
  const wanted = filters.map((filter) => (filter.startsWith(PREFIX) ? filter : PREFIX + filter));
  const unknown = wanted.filter((name) => !commands.has(name));
  if (unknown.length > 0) {
    console.error(`No such script: ${unknown.join(", ")}\nAvailable: ${all.join(", ")}`);
    process.exit(2);
  }
  const size = (name: string) => testFileSize(commands.get(name) ?? "");
  return (wanted.length > 0 ? wanted : all).sort((a, b) => size(b) - size(a) || a.localeCompare(b));
}

const seconds = (since: number) => (performance.now() - since) / 1000;

const concurrency = positiveInteger(process.env.NATIVE_TEST_CONCURRENCY, 4, "NATIVE_TEST_CONCURRENCY");
const timeoutMs = positiveInteger(process.env.NATIVE_TEST_TIMEOUT_MS, 600_000, "NATIVE_TEST_TIMEOUT_MS");
const scripts = nativeScripts(process.argv.slice(2));
const env = { ...process.env };
// A standalone binary runs one worker per CPU by default, and these tests keep state in the process
// (counters, globalThis) and read it back over separate connections. native-workers sets its own.
env.SB_WORKERS ??= "1";

if (!env.SPROUTBOAT_PORFFOR_DIR && env.NATIVE_TEST_FRESH_PORFFOR !== "1") {
  const started = performance.now();
  env.SPROUTBOAT_PORFFOR_DIR = await ensurePorffor();
  console.log(`Porffor ready in ${seconds(started).toFixed(1)}s: ${env.SPROUTBOAT_PORFFOR_DIR}`);
}

const logs = mkdtempSync(join(tmpdir(), "sb-test-native-"));
const started = performance.now();
console.log(`Running ${scripts.length} native test scripts, ${concurrency} at a time`);

async function run(name: string): Promise<Outcome> {
  const log = join(logs, `${name.replace(/[^a-z0-9-]/gi, "_")}.log`);
  const fd = openSync(log, "w");
  const begun = performance.now();
  let exitCode: number | null = null;
  let signal: string | null = null;
  try {
    // stdout and stderr share one file so a failure reads in the order it happened.
    const child = Bun.spawn([process.execPath, "run", name], {
      cwd: ROOT,
      env,
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
      timeout: timeoutMs,
    });
    exitCode = await child.exited;
    signal = child.signalCode;
  } finally {
    closeSync(fd);
  }
  const ok = exitCode === 0;
  const outcome: Outcome = { name, ok, seconds: seconds(begun), output: readFileSync(log, "utf8") };
  if (signal !== null) outcome.output += `\n(stopped by ${signal}; NATIVE_TEST_TIMEOUT_MS is ${timeoutMs})`;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name.padEnd(40)} ${outcome.seconds.toFixed(1).padStart(6)}s`);
  return outcome;
}

// The quickest script warms the shared uWebSockets cache on its own (see above).
const queue = [...scripts];
const warmup = queue.pop();
const outcomes: Outcome[] = warmup === undefined ? [] : [await run(warmup)];
await Promise.all(
  Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) outcomes.push(await run(next));
  }),
);
rmSync(logs, { recursive: true, force: true });

const failed = outcomes.filter((outcome) => !outcome.ok);
for (const outcome of failed) {
  console.log(
    `\n===== ${outcome.name} failed, full output =====\n${outcome.output.trimEnd()}\n===== end of ${outcome.name} =====`,
  );
}
const total = outcomes.reduce((sum, outcome) => sum + outcome.seconds, 0);
console.log(
  `\n${outcomes.length - failed.length} passed, ${failed.length} failed in ${seconds(started).toFixed(1)}s` +
    ` (${total.toFixed(1)}s of test time, concurrency ${concurrency})`,
);
if (failed.length > 0) {
  console.log(`Failed: ${failed.map((outcome) => outcome.name).join(", ")}`);
  process.exit(1);
}
