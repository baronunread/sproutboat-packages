#!/usr/bin/env bun
/**
 * The Porffor patch series: `packages/toolchain/porffor-patches/*.patch`, a `git format-patch` series
 * against one pinned upstream commit, and the tool that turns it into the tarball the toolchain ships.
 *
 *   apply   [--dir D] [--base REF] [--upstream URL|PATH]   upstream commit + series (git am --3way) -> a git checkout
 *   export  [--dir D]                                      the checkout's commits -> porffor-patches/
 *   vendor  [--dir D] [--tag alpha-NN] [--out DIR]         the checkout -> vendor/porffor-patched.tar.gz + .json
 *   verify  [--upstream URL|PATH]                          apply + export + vendor into a temp dir, compare byte for byte
 *   check                                                  no git, no network: series hash and tarball sha256 vs the manifest
 *
 * The last patch of a series is generated (`Class: generated`): `compiler/builtins_precompiled.js`, which
 * upstream tracks and which has to follow every edit to a builtin. `apply` skips it and regenerates it
 * with `bun compiler/precompile.js`, so an upgrade never has to resolve a conflict in a 1.5 MB generated
 * file, and `verify` fails when the committed patch is not what the precompile produces.
 *
 * Everything that shapes the output is pinned: git runs with no user or system config and a fixed
 * identity, patches are written with `--zero-commit --no-signature --full-index`, and the tarball is a
 * ustar archive of the tracked files in path order with owner 0, mtime fixed, modes 0644/0755, gzipped
 * by `Bun.gzipSync` at level 9 (the same bun as CI's, see .github/workflows/ci.yml, gives the same bytes).
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const REPO = resolve(import.meta.dir, "..");
export const SERIES_DIR = join(REPO, "packages/toolchain/porffor-patches");
export const VENDOR_DIR = join(REPO, "packages/toolchain/vendor");
export const MANIFEST_FILE = join(VENDOR_DIR, "porffor-patched.json");
export const TARBALL_FILE = join(VENDOR_DIR, "porffor-patched.tar.gz");
export const UPSTREAM_URL = "https://github.com/CanadaHonk/porffor.git";
const DEFAULT_DIR = join(REPO, ".porffor-series");
const BRANCH = "sb-patches";
const OLD_BRANCH = "sb-patches-old";
const GENERATED_SUBJECT = "builtins: regenerate compiler/builtins_precompiled.js";
/** mtime of every tar entry: 2026-11-15T00:00:00Z, the day the series was cut. */
const TAR_MTIME = 1_794_700_800;
const IDENT = { name: "sproutboat", email: "noreply@sproutboat.com" };

export interface Manifest {
  upstream: { repo: string; channel: string; tag: string; commit: string; npmVersion: string };
  series: { dir: string; files: string[]; sha256: string };
  tar: { sha256: string; bytes: number };
  tarball: { file: string; sha256: string; bytes: number; compressor: string };
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

export function readManifest(): Manifest {
  // SAFETY: written by `vendor` above from a Manifest, and compared with the committed series and tarball by `check`.
  return JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as Manifest;
}

export function listSeries(dir = SERIES_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".patch"))
    .sort();
}

/** sha256 over every patch, in order: `<name>\0<bytes>\0`. */
export function seriesSha256(dir = SERIES_DIR): string {
  const hash = createHash("sha256");
  for (const name of listSeries(dir))
    hash
      .update(`${name}\0`)
      .update(readFileSync(join(dir, name)))
      .update("\0");
  return hash.digest("hex");
}

function isGenerated(patch: string): boolean {
  const message = patch.slice(0, patch.indexOf("\n---\n"));
  return /^Class: generated$/m.test(message);
}

// --- git, hermetic ---

function gitEnv() {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: IDENT.name,
    GIT_AUTHOR_EMAIL: IDENT.email,
    GIT_COMMITTER_NAME: IDENT.name,
    GIT_COMMITTER_EMAIL: IDENT.email,
    GIT_AUTHOR_DATE: "2026-11-15T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-11-15T00:00:00Z",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

function git(cwd: string, args: string[], allowFailure = false) {
  const run = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe" });
  const out = run.stdout.toString();
  const err = run.stderr.toString();
  if (run.exitCode !== 0 && !allowFailure)
    throw new Error(`git ${args.join(" ")} (in ${cwd}) exited ${run.exitCode}:\n${(err || out).trim()}`);
  return { code: run.exitCode, out, err };
}

const gitOut = (cwd: string, args: string[]) => git(cwd, args).out.trim();

// --- apply ---

export interface ApplyOptions {
  dir: string;
  /** A tag or commit of the upstream; default: the manifest's commit. */
  base?: string;
  upstream?: string;
  series?: string;
  log?: (line: string) => void;
}

export function applySeries(options: ApplyOptions) {
  const log = options.log ?? ((line) => console.log(line));
  const series = options.series ?? SERIES_DIR;
  const dir = resolve(options.dir);
  if (existsSync(dir))
    throw new Error(`${dir} exists: remove it (or pass another --dir) so apply starts from the pristine tag`);
  const recorded = existsSync(MANIFEST_FILE) ? readManifest().upstream.commit : undefined;
  const ref = options.base ?? recorded;
  if (!ref) throw new Error("no manifest to take the upstream commit from: pass --base <tag or commit>");
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  for (const [key, value] of [
    ["user.name", IDENT.name],
    ["user.email", IDENT.email],
    ["commit.gpgsign", "false"],
    ["core.autocrlf", "false"],
    ["core.filemode", "true"],
    ["gc.auto", "0"],
  ] as const)
    git(dir, ["config", key, value]);
  git(dir, ["remote", "add", "upstream", options.upstream ?? UPSTREAM_URL]);
  const resolve1 = (want: string) => {
    log(`fetching upstream ${want}`);
    git(dir, ["fetch", "-q", "--depth", "1", "upstream", want]);
    return gitOut(dir, ["rev-parse", "FETCH_HEAD^{commit}"]);
  };
  const base = resolve1(ref);
  const patches = listSeries(series)
    .filter((name) => !isGenerated(readFileSync(join(series, name), "utf8")))
    .map((name) => join(series, name));
  if (recorded && recorded !== base) {
    // An upgrade: `git am --3way` merges against the blobs a patch was cut from, and every patch after the first
    // to touch a file was cut from the previous patch's result. Those blobs exist only once the series has been
    // applied to the commit it was made on, so do that first (branch `${OLD_BRANCH}`, kept for reference).
    const old = resolve1(recorded);
    git(dir, ["checkout", "-q", "-b", OLD_BRANCH, old]);
    log(`series on its own base ${old.slice(0, 7)} (${OLD_BRANCH}), for the 3-way merge`);
    git(dir, ["am", "-q", "--", ...patches]);
  }
  git(dir, ["checkout", "-q", "-b", BRANCH, base]);
  git(dir, ["config", "sproutboat.base", base]);
  log(`git am --3way: ${patches.length} patches onto ${base.slice(0, 7)}`);
  const am = git(dir, ["am", "-q", "--3way", "--", ...patches], true);
  if (am.code !== 0)
    throw new Error(
      `${am.err.trim() || am.out.trim()}\n\nResolve in ${dir} (edit, \`git add\`, \`git am --continue\`), then run: bun scripts/porffor-patches.ts precompile --dir ${dir}`,
    );
  precompileCommit(dir, log);
  return { dir, base };
}

/** Regenerate `builtins_precompiled.js` and commit it as the series' generated patch (amending a previous one). */
export function precompileCommit(dir: string, log: (line: string) => void = () => {}): void {
  if (gitOut(dir, ["status", "--porcelain"]) !== "") throw new Error(`${dir} has uncommitted changes`);
  const script = realpathSync(join(dir, "compiler/precompile.js"));
  // Porffor only writes the table when import.meta.url matches argv[1], hence the canonical path; alpha 20+
  // sources use `with { type: 'text' }` imports, which Node rejects, so it runs under bun.
  const run = Bun.spawnSync([process.execPath, script], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`precompile failed:\n${run.stderr.toString() || run.stdout.toString()}`);
  if (gitOut(dir, ["status", "--porcelain"]) === "") return;
  git(dir, ["add", "-A"]);
  const previous = gitOut(dir, ["log", "-1", "--format=%s"]) === GENERATED_SUBJECT;
  const message =
    `${GENERATED_SUBJECT}\n\n` +
    "The precompiled table of the builtins, which upstream tracks and which has to follow every edit to a\n" +
    "builtin above (replaceAll, repeat, case mapping, regexp, promise, json, date, the megamorphic cache).\n" +
    "Generated by `bun scripts/porffor-patches.ts precompile`; `apply` skips this patch and regenerates it.\n\n" +
    "Class: generated\nPass: bun compiler/precompile.js\n";
  git(dir, ["commit", "-q", ...(previous ? ["--amend"] : []), "-m", message]);
  log("regenerated compiler/builtins_precompiled.js");
}

// --- export ---

export function exportSeries(dir: string, out: string): string[] {
  const base = gitOut(dir, ["config", "sproutboat.base"]);
  if (!base) throw new Error(`${dir} was not made by \`apply\` (no sproutboat.base)`);
  if (gitOut(dir, ["status", "--porcelain"]) !== "")
    throw new Error(`${dir} has uncommitted changes: commit them first`);
  const stage = mkdtempSync(join(tmpdir(), "sb-series-export-"));
  try {
    git(dir, [
      "format-patch",
      "-N",
      "--no-signature",
      "--zero-commit",
      "--full-index",
      "--no-renames",
      "--no-ext-diff",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "-o",
      stage,
      `${base}..HEAD`,
    ]);
    mkdirSync(out, { recursive: true });
    for (const name of listSeries(out)) rmSync(join(out, name));
    const names = listSeries(stage);
    for (const name of names) writeFileSync(join(out, name), readFileSync(join(stage, name)));
    return names;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// --- the tarball ---

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function tarEntry(path: string, data: Uint8Array, executable: boolean): Uint8Array[] {
  const header = new Uint8Array(512);
  const put = (offset: number, text: string) => header.set(new TextEncoder().encode(text), offset);
  const name = new TextEncoder().encode(path);
  if (name.length > 100) throw new Error(`tar path too long for a plain ustar header: ${path}`);
  put(0, path);
  put(100, octal(executable ? 0o755 : 0o644, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(data.length, 12));
  put(136, octal(TAR_MTIME, 12));
  put(148, "        ");
  put(156, "0");
  put(257, "ustar\0");
  put(263, "00");
  let sum = 0;
  for (const byte of header) sum += byte;
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
  const pad = new Uint8Array((512 - (data.length % 512)) % 512);
  return [header, data, pad];
}

/** A deterministic ustar archive of the files tracked at HEAD in `dir`, under a `porffor/` root. */
export function tarOfTree(dir: string): Uint8Array<ArrayBuffer> {
  const listing = git(dir, ["ls-files", "-s", "-z"]).out.split("\0").filter(Boolean);
  const files = listing
    .map((line) => {
      const [meta = "", path = ""] = line.split("\t");
      return { mode: meta.split(" ")[0] ?? "", path };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const chunks: Uint8Array[] = [];
  for (const { mode, path } of files) {
    if (mode !== "100644" && mode !== "100755")
      throw new Error(`${path}: mode ${mode}, only regular files are archived`);
    chunks.push(...tarEntry(`porffor/${path}`, readFileSync(join(dir, path)), mode === "100755"));
  }
  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const tar = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    tar.set(chunk, at);
    at += chunk.length;
  }
  return tar;
}

export const compressorId = () => `bun ${Bun.version} gzipSync level 9`;

export interface Vendored {
  manifest: Manifest;
  tar: Uint8Array<ArrayBuffer>;
  tarball: Uint8Array<ArrayBuffer>;
}

export function vendorTree(dir: string, tag?: string): Vendored {
  const base = gitOut(dir, ["config", "sproutboat.base"]);
  if (!base) throw new Error(`${dir} was not made by \`apply\``);
  if (gitOut(dir, ["status", "--porcelain"]) !== "") throw new Error(`${dir} has uncommitted changes`);
  // The branch must be what the series says: export it to a scratch directory and compare with porffor-patches/.
  const scratch = mkdtempSync(join(tmpdir(), "sb-series-vendor-"));
  try {
    exportSeries(dir, scratch);
    if (seriesSha256(scratch) !== seriesSha256(SERIES_DIR))
      throw new Error(`${dir}'s commits differ from porffor-patches/: run \`export\` first`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const previous = existsSync(MANIFEST_FILE) ? readManifest().upstream : undefined;
  const sameBase = previous?.commit === base;
  const resolvedTag = tag ?? (sameBase ? previous?.tag : undefined);
  if (!resolvedTag)
    throw new Error("the upstream commit changed: pass --tag alpha-NN so the manifest says which release it is");
  const channel = resolvedTag;
  const tar = tarOfTree(dir);
  const tarball = Bun.gzipSync(tar, { level: 9 });
  const files = listSeries(SERIES_DIR);
  const manifest: Manifest = {
    upstream: {
      repo: "https://github.com/CanadaHonk/porffor",
      channel,
      tag: resolvedTag,
      commit: base,
      npmVersion: `0.0.0-${resolvedTag.replace("-", ".")}`,
    },
    series: { dir: "packages/toolchain/porffor-patches", files, sha256: seriesSha256(SERIES_DIR) },
    tar: { sha256: sha256(tar), bytes: tar.length },
    tarball: {
      file: "porffor-patched.tar.gz",
      sha256: sha256(tarball),
      bytes: tarball.length,
      compressor: compressorId(),
    },
  };
  return { manifest, tar, tarball };
}

export const manifestText = (manifest: Manifest) => `${JSON.stringify(manifest, null, 2)}\n`;

// --- check and verify ---

/** No git, no network: the committed series and tarball agree with the manifest. Returns the problems. */
export function check(): string[] {
  const problems: string[] = [];
  const manifest = readManifest();
  const names = listSeries();
  if (JSON.stringify(names) !== JSON.stringify(manifest.series.files))
    problems.push(`series files differ from the manifest: ${names.join(", ")}`);
  if (seriesSha256() !== manifest.series.sha256) problems.push("series sha256 differs from the manifest: run `vendor`");
  const tarball = readFileSync(TARBALL_FILE);
  if (sha256(tarball) !== manifest.tarball.sha256)
    problems.push("vendored tarball sha256 differs from the manifest: run `vendor`");
  else if (sha256(Bun.gunzipSync(tarball)) !== manifest.tar.sha256)
    problems.push("vendored tarball does not unpack to the manifest's tar: run `vendor`");
  return problems;
}

/** apply + export + vendor into a scratch directory and compare with what is committed, byte for byte. */
export function verify(upstream?: string, log: (line: string) => void = (line) => console.log(line)): string[] {
  const problems: string[] = [];
  const manifest = readManifest();
  const work = mkdtempSync(join(tmpdir(), "sb-series-verify-"));
  try {
    const dir = join(work, "tree");
    applySeries({ dir, upstream, log });
    const regenerated = join(work, "series");
    const names = exportSeries(dir, regenerated);
    if (JSON.stringify(names) !== JSON.stringify(manifest.series.files))
      problems.push(`re-exported series has other files: ${names.join(", ")}`);
    for (const name of names) {
      const committed = join(SERIES_DIR, name);
      if (!existsSync(committed)) problems.push(`${name}: not committed`);
      else if (!readFileSync(committed).equals(readFileSync(join(regenerated, name))))
        problems.push(`${name}: differs from the committed patch`);
    }
    if (problems.length === 0) {
      const { manifest: rebuilt, tar, tarball } = vendorTree(dir);
      if (rebuilt.tar.sha256 !== manifest.tar.sha256)
        problems.push(`tar (uncompressed) differs: ${rebuilt.tar.sha256} vs committed ${manifest.tar.sha256}`);
      // The tar is the reproducible artifact. gzip output depends on the zlib Bun links (macOS and Linux differ at
      // the same level), so the committed .tar.gz is checked by what it unpacks to, and its own sha256 by `check`.
      const committedTar = Bun.gunzipSync(readFileSync(TARBALL_FILE));
      if (sha256(committedTar) !== manifest.tar.sha256)
        problems.push("committed tarball does not unpack to the manifest's tar");
      if (sha256(tarball) !== manifest.tarball.sha256)
        log(
          `note: gzip bytes differ from the committed tarball (${compressorId()} here, ${manifest.tarball.compressor} committed); the tar is identical`,
        );
      log(`tar ${sha256(tar).slice(0, 12)} tarball ${sha256(tarball).slice(0, 12)}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return problems;
}

// --- command line ---

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const dir = resolve(option(args, "--dir") ?? DEFAULT_DIR);
  try {
    if (command === "apply") {
      const result = applySeries({ dir, base: option(args, "--base"), upstream: option(args, "--upstream") });
      console.log(`applied onto ${result.base} in ${result.dir}`);
    } else if (command === "precompile") {
      precompileCommit(dir, console.log);
    } else if (command === "export") {
      const names = exportSeries(dir, SERIES_DIR);
      console.log(`wrote ${names.length} patches to ${SERIES_DIR}`);
    } else if (command === "vendor") {
      const { manifest, tarball } = vendorTree(dir, option(args, "--tag"));
      const out = option(args, "--out");
      const target = out ? resolve(out) : VENDOR_DIR;
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "porffor-patched.tar.gz"), tarball);
      writeFileSync(join(target, "porffor-patched.json"), manifestText(manifest));
      console.log(
        `wrote ${join(target, "porffor-patched.tar.gz")} ${manifest.tarball.sha256} (${manifest.tarball.bytes} bytes)`,
      );
    } else if (command === "verify") {
      const problems = verify(option(args, "--upstream"));
      if (problems.length > 0) {
        console.error(problems.map((p) => `FAIL ${p}`).join("\n"));
        process.exit(1);
      }
      console.log(
        "ok: apply + export + vendor reproduce the committed series and tar byte for byte; the committed tarball unpacks to that tar",
      );
    } else if (command === "check") {
      const problems = check();
      if (problems.length > 0) {
        console.error(problems.map((p) => `FAIL ${p}`).join("\n"));
        process.exit(1);
      }
      console.log("ok: series and tarball match the manifest");
    } else {
      console.error(
        "usage: bun scripts/porffor-patches.ts apply|precompile|export|vendor|verify|check [--dir D] [--base REF] [--upstream URL|PATH] [--tag alpha-NN] [--out DIR]",
      );
      process.exit(2);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
