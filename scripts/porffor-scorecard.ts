import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { ensurePorffor } from "../packages/toolchain/src/acquire";
import {
  PORFFOR_CHANNEL,
  PORFFOR_COMMIT_FULL,
  porfforVersion,
} from "../packages/toolchain/src/pin";

type FileResult = {
  file: string;
  compiles: boolean;
  matches: boolean;
  sizeBytes: number | null;
  compileMs: number;
  error: string | null;
};
type Report = { generatedAt: string; porfforVersion: string; files: FileResult[] };
type Scorecard = {
  pin: string;
  reportGeneratedAt: string;
  fixtures: number;
  compiled: number;
  matched: number;
  medianCompileMs: number | null;
  p95CompileMs: number | null;
  medianBinaryBytes: number | null;
  p95BinaryBytes: number | null;
  patchSourceSha256: string;
  patchMarkerCount: number;
  patchTargets: Record<string, string[]>;
  patchApplication: "pass" | "fail";
  patchError?: string;
  mismatches: string[];
};

const root = resolve(import.meta.dir, "..");
const reportPath = resolve(process.argv[2] ?? "../sproutboat/report.json");
// SAFETY: report.json is produced by the compatibility harness; its pinned
// version is checked before these results are recorded.
const report = JSON.parse(await readFile(reportPath, "utf8")) as Report;
if (report.porfforVersion !== porfforVersion()) {
  throw new Error(
    `report ${report.porfforVersion} does not match pinned ${porfforVersion()}; regenerate the compatibility report first`,
  );
}
const patchSource = await readFile(resolve(root, "packages/toolchain/src/patch.ts"), "utf8");
const markers = [...patchSource.matchAll(/const ([A-Z0-9_]+_MARKER)\s*=/g)].map(
  (match) => match[1],
);
const targets = {
  "compiler/render.js": ["PORT", "CONSOLE", "BYTESTRING", "READ_RAW"],
  "compiler/index.js": ["LINK", "CFLAGS"],
  "compiler/builtins/typedarray.js": ["TYPED_ARRAY_FROM"],
  "compiler/uwebsockets.js": [
    "BODY",
    "STATUS_SIG",
    "STATUS_303",
    "STATUS_DEFAULT",
    "HDR_SIG",
    "HDR_CALL",
    "HDR_CAP",
    "HDR_SKIP",
    "HDR_APPEND",
    "READ_RAW_DECL",
    "FORBIDDEN_HDR",
    "WRITE_RESPONSE",
    "R2_TRANSFER",
    "R2_TRANSFER_CALL",
    "R2_DOWNLOAD_CACHE",
    "R2_RANGE_CACHE",
    "R2_CONDITIONAL_CACHE",
    "R2_STREAMING_CACHE",
    "R2_RANGE_HEADER_CACHE",
  ],
  "compiler/builtins_precompiled.js": [],
} satisfies Record<string, string[]>;
const grouped = Object.values(targets)
  .flat()
  .map((name) => `${name}_MARKER`);
if (markers.slice().sort().join(",") !== grouped.slice().sort().join(",")) {
  throw new Error(
    "the Porffor patch marker inventory changed; update this scorecard's target mapping",
  );
}
for (const path of Object.keys(targets)) {
  if (!patchSource.includes(`resolve(root, "${path}")`))
    throw new Error(`patch target ${path} is no longer referenced`);
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

const compiled = report.files.filter((file) => file.compiles);
const temp = await mkdtemp(resolve(tmpdir(), "sb-porffor-scorecard-"));
let patchApplication: Scorecard["patchApplication"] = "pass";
let patchError: string | undefined;
try {
  await ensurePorffor({ cacheRoot: temp });
} catch (error) {
  patchApplication = "fail";
  patchError = error instanceof Error ? error.message : String(error);
} finally {
  await rm(temp, { recursive: true, force: true });
}
const scorecard: Scorecard = {
  pin: `${PORFFOR_CHANNEL} (${PORFFOR_COMMIT_FULL})`,
  reportGeneratedAt: report.generatedAt,
  fixtures: report.files.length,
  compiled: compiled.length,
  matched: report.files.filter((file) => file.matches).length,
  medianCompileMs: percentile(
    compiled.map((file) => file.compileMs),
    0.5,
  ),
  p95CompileMs: percentile(
    compiled.map((file) => file.compileMs),
    0.95,
  ),
  medianBinaryBytes: percentile(
    compiled.flatMap((file) => (file.sizeBytes === null ? [] : [file.sizeBytes])),
    0.5,
  ),
  p95BinaryBytes: percentile(
    compiled.flatMap((file) => (file.sizeBytes === null ? [] : [file.sizeBytes])),
    0.95,
  ),
  patchSourceSha256: createHash("sha256").update(patchSource).digest("hex"),
  patchMarkerCount: markers.length,
  patchTargets: Object.fromEntries(
    Object.entries(targets).map(([path, names]) => [path, names.map((name) => `${name}_MARKER`)]),
  ),
  patchApplication,
  mismatches: report.files
    .filter((file) => !file.matches)
    .map((file) => `${file.file}: ${file.error ?? "behavior mismatch"}`),
};
if (patchError) scorecard.patchError = patchError;

const snapshots = resolve(root, "packages/toolchain/scorecards");
await mkdir(snapshots, { recursive: true });
const filename = `${PORFFOR_CHANNEL}-${PORFFOR_COMMIT_FULL.slice(0, 7)}.json`;
// SAFETY: snapshot files are written below with the Scorecard shape.
const previousSnapshots = await Promise.all(
  (await readdir(snapshots))
    .filter((name) => name.endsWith(".json") && name !== filename)
    .map(async (name) => ({
      name,
      value: JSON.parse(await readFile(resolve(snapshots, name), "utf8")) as Scorecard,
    })),
);
const prior = previousSnapshots
  .filter((item) => item.value.reportGeneratedAt < scorecard.reportGeneratedAt)
  .sort((left, right) => left.value.reportGeneratedAt.localeCompare(right.value.reportGeneratedAt))
  .at(-1);
const previousPath = prior ? resolve(snapshots, prior.name) : null;
const previous = prior?.value;
const delta = previous
  ? `Previous snapshot: ${basename(previousPath!)}. Matches ${previous.matched}/${previous.fixtures} to ${scorecard.matched}/${scorecard.fixtures}; patch markers ${previous.patchMarkerCount} to ${scorecard.patchMarkerCount}.\n\n`
  : "This is the first recorded pin. Compare the next pin against this snapshot.\n\n";
const markdown =
  `# Porffor pin scorecard\n\n` +
  `Pin: ${scorecard.pin}. Compatibility report: ${scorecard.reportGeneratedAt}.\n\n` +
  `| Measure | Result |\n| --- | ---: |\n` +
  `| Fixtures compiled | ${scorecard.compiled}/${scorecard.fixtures} |\n` +
  `| Behavior matches | ${scorecard.matched}/${scorecard.fixtures} |\n` +
  `| Median / p95 compile, ms | ${scorecard.medianCompileMs} / ${scorecard.p95CompileMs} |\n` +
  `| Median / p95 binary, bytes | ${scorecard.medianBinaryBytes} / ${scorecard.p95BinaryBytes} |\n` +
  `| Patch markers | ${scorecard.patchMarkerCount} |\n` +
  `| Upstream files written | ${Object.keys(scorecard.patchTargets).length} |\n` +
  `| Fresh patch application | ${scorecard.patchApplication} |\n\n` +
  delta +
  `## Patch inventory\n\n` +
  Object.entries(scorecard.patchTargets)
    .map(
      ([path, names]) =>
        `- \`${path}\`: ${names.length ? names.join(", ") : "regenerated builtin table"}`,
    )
    .join("\n") +
  `\n\nPatch source SHA-256: \`${scorecard.patchSourceSha256}\`.\n\n` +
  `## Known behavior gaps\n\n` +
  (scorecard.mismatches.length
    ? scorecard.mismatches.map((item) => `- ${item}`).join("\n")
    : "No mismatches in this fixture set.") +
  `\n\n## Review\n\n` +
  `Use this scorecard with the full compatibility report and issue #35's build telemetry. ` +
  `If behavior regresses or patch work grows, review the individual patches and measure an alternate backend with the same fixtures.\n`;
await writeFile(resolve(snapshots, filename), `${JSON.stringify(scorecard, null, 2)}\n`);
await writeFile(resolve(root, "packages/toolchain/PORFFOR_SCORECARD.md"), markdown);
console.log(markdown);
if (patchApplication === "fail") process.exitCode = 1;
