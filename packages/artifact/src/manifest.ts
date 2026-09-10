export const ARTIFACT_SCHEMA_VERSION = 2;
export const RUNTIME = "native-fetch";
export const CAPABILITY_PROFILE = "http-sync-v0";

/** The only target a deployed artifact may carry. Every box runs linux-x86_64. */
export const DEPLOY_TARGET = "linux-x86_64";

/**
 * `<arch>-<platform>` of the machine doing the build, e.g. `arm64-darwin`.
 * Only `sproutboat build --target host` produces one (#62): it runs on this
 * machine for local dev and is deliberately not portable, so `validateManifest`
 * rejects it and neither `deploy` nor the control plane will accept it.
 */
export type HostTarget = `${string}-${string}`;
export const hostTarget = (): HostTarget => `${process.arch}-${process.platform}`;

export type ArtifactManifest = {
  schemaVersion: 2;
  project: string;
  target: typeof DEPLOY_TARGET | HostTarget;
  runtime: "native-fetch";
  capabilityProfile: "http-sync-v0";
  porfforVersion: string;
  esbuildVersion: string;
  /** Build provenance, e.g. `zig-musl/0.16.0+porffor/a415d19+uws/360c276d`. */
  buildImage: string;
  /**
   * The project's `compatibility_date`, as `YYYY-MM-DD`. Optional: artifacts
   * built before this field existed have none, and every reader must treat that
   * as the baseline (see `BASELINE_COMPATIBILITY_DATE` in `wrap.ts`). This is
   * how a runtime behaviour change ships without breaking deployed apps — new
   * builds opt in by moving their date, old binaries keep the old semantics —
   * so it is deliberately *not* part of `schemaVersion`, which stays frozen
   * at 2.
   */
  compatibilityDate?: string;
  sourceHash: `sha256:${string}`;
  binaryHash: `sha256:${string}`;
  binarySize: number;
  builtAt: string;
};

export type ManifestValidation = { ok: true; value: ArtifactManifest } | { ok: false; errors: string[] };

type JsonValue = string | number | boolean | null | ManifestJsonObject | JsonValue[];

interface ManifestJsonObject {
  readonly [key: string]: JsonValue;
}

type ManifestInput = JsonValue | undefined;

function isRecord(value: ManifestInput): value is ManifestJsonObject {
  return value !== null && Object(value) === value && !Array.isArray(value) && !(value instanceof Function);
}

function isString(value: ManifestInput): value is string {
  return Object(value) !== value && value === String(value);
}

function sha256(value: ManifestInput): value is `sha256:${string}` {
  return isString(value) && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isPositiveInteger(value: ManifestInput): value is number {
  return Number.isSafeInteger(value) && value === Number(value) && Number(value) > 0;
}

export function validateManifest(value: ManifestInput): ManifestValidation {
  if (!isRecord(value)) return { ok: false, errors: ["manifest must be an object"] };
  const errors: string[] = [];
  const required = [
    "schemaVersion",
    "project",
    "target",
    "runtime",
    "capabilityProfile",
    "porfforVersion",
    "esbuildVersion",
    "buildImage",
    "sourceHash",
    "binaryHash",
    "binarySize",
    "builtAt",
  ];
  for (const field of required) if (!(field in value)) errors.push(`missing manifest field: ${field}`);
  const schemaVersion = value.schemaVersion === ARTIFACT_SCHEMA_VERSION ? ARTIFACT_SCHEMA_VERSION : null;
  if (schemaVersion === null) errors.push("schemaVersion must be 2");
  const project =
    isString(value.project) && /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/.test(value.project) ? value.project : null;
  if (project === null) errors.push("project must be a valid slug");
  const target = value.target === DEPLOY_TARGET ? value.target : null;
  if (target === null) {
    // A `--target host` artifact lands here: runnable where it was built, not
    // on a box. Name that, so the failure reads as "wrong build" not "corrupt".
    errors.push(
      isString(value.target) && value.target !== DEPLOY_TARGET
        ? `target must be ${DEPLOY_TARGET}, got ${value.target} — \`--target host\` builds are for local dev and cannot be deployed`
        : `target must be ${DEPLOY_TARGET}`,
    );
  }
  const runtime = value.runtime === RUNTIME ? value.runtime : null;
  if (runtime === null) errors.push("runtime must be native-fetch");
  const capabilityProfile = value.capabilityProfile === CAPABILITY_PROFILE ? value.capabilityProfile : null;
  if (capabilityProfile === null) errors.push("capabilityProfile must be http-sync-v0");
  const versions = ["porfforVersion", "esbuildVersion", "buildImage"] as const;
  const [porfforVersion, esbuildVersion, buildImage] = versions.map((field) =>
    isString(value[field]) && value[field] ? value[field] : null,
  );
  for (const [field, version] of versions.map(
    (field, index) => [field, [porfforVersion, esbuildVersion, buildImage][index]] as const,
  )) {
    if (version === null) errors.push(`${field} must be a non-empty string`);
  }
  const sourceHash = sha256(value.sourceHash) ? value.sourceHash : null;
  if (sourceHash === null) errors.push("sourceHash must be a sha256 digest");
  const binaryHash = sha256(value.binaryHash) ? value.binaryHash : null;
  if (binaryHash === null) errors.push("binaryHash must be a sha256 digest");
  const binarySize = isPositiveInteger(value.binarySize) ? value.binarySize : null;
  if (binarySize === null) errors.push("binarySize must be a positive integer");
  const builtAt = isString(value.builtAt) && !Number.isNaN(Date.parse(value.builtAt)) ? value.builtAt : null;
  if (builtAt === null) errors.push("builtAt must be an ISO-8601 timestamp");
  // Optional by design: an artifact from before the field existed is valid and
  // must stay deployable, so "absent" is not an error — only "present and
  // malformed" is.
  let compatibilityDate: string | undefined;
  if (value.compatibilityDate !== undefined) {
    if (isString(value.compatibilityDate) && /^\d{4}-\d{2}-\d{2}$/.test(value.compatibilityDate))
      compatibilityDate = value.compatibilityDate;
    else errors.push("compatibilityDate must be YYYY-MM-DD");
  }
  if (
    errors.length ||
    schemaVersion === null ||
    project === null ||
    target === null ||
    runtime === null ||
    capabilityProfile === null ||
    porfforVersion === null ||
    esbuildVersion === null ||
    buildImage === null ||
    sourceHash === null ||
    binaryHash === null ||
    binarySize === null ||
    builtAt === null
  )
    return { ok: false, errors };
  return {
    ok: true,
    value: {
      ...value,
      schemaVersion,
      project,
      target,
      runtime,
      capabilityProfile,
      porfforVersion,
      esbuildVersion,
      buildImage,
      sourceHash,
      binaryHash,
      binarySize,
      builtAt,
      compatibilityDate,
    },
  };
}
