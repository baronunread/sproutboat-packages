#!/usr/bin/env bun
/**
 * The standalone server's vendored sources (`packages/toolchain/src/a21/standalone-server/`): the uWebSockets
 * server shim, the web classes, and the patches the uWebSockets checkout is compiled with.
 *
 *   check     no git, no network: the files' content hashes against sources.json
 *   verify    check, then fetch uWebSockets at the pinned commit (git, depth 1), compare the pristine tree with
 *             sources.json, apply the vendored patches, compare the patched tree with sources.json, apply them
 *             again (a no-op) and compare once more
 *
 * The files began as the output of the Porffor alpha 19 patch chain; the commit that vendored them
 * (`toolchain: vendor the standalone server's sources`) still had the chain and ran a verify that compared them with
 * it byte for byte. They are maintained by hand now: edit them, then update sources.json (`write`).
 *
 *   write     recompute the hashes in sources.json from the files (after an edit); needs git and the network
 */
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const DIR = join(REPO, "packages/toolchain/src/a21/standalone-server");
const MANIFEST = join(DIR, "sources.json");
const END = "// ---- end of provenance header ----\n";
const sha = (d: string | Uint8Array) => createHash("sha256").update(d).digest("hex");
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const body = (text: string) => text.slice(text.indexOf(END) + END.length);

interface Manifest {
  uWebSockets: {
    repo: string;
    commit: string;
    pristineSrcSha256: string;
    patches: { file: string; sha256: string }[];
    patchedSrcSha256: string;
  };
  files: Record<string, { contentSha256: string }>;
  origin: Record<string, string>;
}

function readManifest(): Manifest {
  // SAFETY: sources.json is written by `write` below (and was by the vendoring commit's generator) with this shape.
  return JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
}

async function tools() {
  return import(join(DIR, "index.ts"));
}

function fetchPristine(repo: string, commit: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-uws-"));
  for (const argv of [
    ["git", "init", "-q"],
    ["git", "remote", "add", "origin", repo],
    ["git", "fetch", "-q", "--depth", "1", "origin", commit],
    ["git", "checkout", "-q", "--detach", "FETCH_HEAD"],
  ]) {
    const r = Bun.spawnSync(argv, { cwd: dir });
    if (r.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${r.stderr.toString()}`);
  }
  return dir;
}

function check() {
  const m = readManifest();
  const bad: string[] = [];
  for (const [file, want] of Object.entries(m.files))
    if (sha(body(read(file))) !== want.contentSha256) bad.push(`${file}: content sha256 differs from sources.json`);
  for (const p of m.uWebSockets.patches)
    if (sha(read(p.file)) !== p.sha256) bad.push(`${p.file}: sha256 differs from sources.json`);
  if (bad.length) throw new Error(bad.join("\n"));
  console.log("check: vendored standalone sources match sources.json");
}

async function withPatchedTree<T>(fn: (pristine: string, patched: string) => Promise<T>): Promise<T> {
  const m = readManifest();
  const { applyUwsPatches } = await tools();
  const pristine = fetchPristine(m.uWebSockets.repo, m.uWebSockets.commit);
  const patched = mkdtempSync(join(tmpdir(), "sb-uws-patched-"));
  try {
    cpSync(join(pristine, "src"), join(patched, "src"), { recursive: true });
    await applyUwsPatches(patched);
    return await fn(join(pristine, "src"), join(patched, "src"));
  } finally {
    rmSync(pristine, { recursive: true, force: true });
    rmSync(patched, { recursive: true, force: true });
  }
}

async function verify() {
  check();
  const m = readManifest();
  const { treeSha256, applyUwsPatches } = await tools();
  const bad: string[] = [];
  await withPatchedTree(async (pristine, patched) => {
    if ((await treeSha256(pristine)) !== m.uWebSockets.pristineSrcSha256)
      bad.push("pristine uWebSockets src differs from sources.json");
    const once = await treeSha256(patched);
    if (once !== m.uWebSockets.patchedSrcSha256) bad.push("patched uWebSockets src differs from sources.json");
    const root = join(patched, "..");
    if (await applyUwsPatches(root)) bad.push("applying the patches a second time changed a file");
    if ((await treeSha256(patched)) !== once) bad.push("applying the patches twice changed the tree");
  });
  if (bad.length) throw new Error(bad.join("\n"));
  console.log(
    `verify: uWebSockets ${m.uWebSockets.commit.slice(0, 7)} + the vendored patches is the tree sources.json records`,
  );
}

async function write() {
  const m = readManifest();
  const { treeSha256 } = await tools();
  await withPatchedTree(async (pristine, patched) => {
    m.uWebSockets.pristineSrcSha256 = await treeSha256(pristine);
    m.uWebSockets.patchedSrcSha256 = await treeSha256(patched);
  });
  for (const p of m.uWebSockets.patches) p.sha256 = sha(read(p.file));
  for (const file of Object.keys(m.files)) m.files[file] = { contentSha256: sha(body(read(file))) };
  writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + "\n");
  console.log("write: sources.json updated");
}

const cmd = process.argv[2];
if (cmd === "check") check();
else if (cmd === "verify") await verify();
else if (cmd === "write") await write();
else {
  console.error("usage: bun scripts/standalone-sources.ts check|verify|write");
  process.exit(2);
}
