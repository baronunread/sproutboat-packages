/**
 * The build-independent half of sprout compilation: the binding/trigger wrapper
 * that turns a user's `export default { fetch }` into a native-fetch module, plus
 * the `Bindings` shape and the `SPROUTBOAT_*_JSON` env readers.
 *
 * This module has no imports on purpose — the monorepo consumes it via the
 * `sproutboat/runtime/wrap` export to drive its own (host-native, non-musl)
 * compile path without pulling in `toolchain.ts` / `patch-porffor.ts`.
 */

/** The prelude file (Web API shims + broker binding shim + trigger dispatcher).
 *  It is read as text and string-prepended before Porffor sees it, never
 *  imported — callers do `readFile(preludePath, "utf8")`. */
export const preludePath = new URL("./native-fetch-prelude.js", import.meta.url);

/**
 * #15 — the two transports the prelude can be built with.
 *
 * Both define `__sbCall(reqJson) -> replyJson` and nothing else; every binding
 * shim above that line is identical, which is what lets one conformance suite
 * hold both honest. `broker` talks to the per-deployment broker over loopback
 * (deployed, dev, phase-0 standalone); `embedded` compiles SQLite into the
 * sprout and needs no second process at all.
 */
export type Transport = "broker" | "embedded";
export const transportPath = (transport: Transport): URL =>
  new URL(transport === "embedded" ? "./transport-embedded.js" : "./transport-broker.js", import.meta.url);

/** Where the prelude expects its transport spliced in. */
export const TRANSPORT_MARKER =
  "// TRANSPORT: wrap.ts splices one of transport-broker.js / transport-embedded.js here.";

// The server honours $PORT at runtime (patches/porffor-render.patch); this baked
// value is only a fallback for a directly-run binary.
const DEFAULT_PORT = 8080;

/**
 * What an artifact with no `compatibilityDate` means. Artifacts built before
 * the field existed keep the semantics of that day forever, because the binary
 * is immutable and `rollback` can reactivate it at any time.
 *
 * How to use it: when a runtime behaviour has to change in a way that would
 * break a deployed handler, don't change it unconditionally — gate it in the
 * prelude on `__sbCompat >= "YYYY-MM-DD"` (ISO dates compare correctly as
 * strings) and document the flip date. Old binaries carry their old date and
 * keep the old behaviour; a project opts in by moving `compatibility_date` in
 * its `sproutboat.jsonc` and rebuilding.
 */
export const BASELINE_COMPATIBILITY_DATE = "2026-08-26";

/**
 * Binding names a project declares. `do` maps a binding name to a Durable Object
 * class name; `crons` are schedule expressions with no name.
 */
export type Bindings = {
  kv: string[];
  secrets: string[];
  outbound: string[];
  d1: string[];
  r2: string[];
  queues: string[];
  analytics: string[];
  do: Array<{ binding: string; className: string }>;
  /** #48 — worker-to-worker: binding name -> the project it calls. The hostname
   *  it resolves to is a runtime input, not part of the artifact. */
  services: Array<{ binding: string; service: string }>;
  crons: string[];
  /** Static-asset binding name for `env.<NAME>.fetch(request)`; `""` when assets are edge-only. */
  assets: string;
};

export const EMPTY_BINDINGS: Bindings = {
  kv: [],
  secrets: [],
  outbound: [],
  d1: [],
  r2: [],
  queues: [],
  analytics: [],
  do: [],
  services: [],
  crons: [],
  assets: "",
};

function hasBindings(b: Bindings): boolean {
  return (
    b.kv.length > 0 ||
    b.secrets.length > 0 ||
    b.outbound.length > 0 ||
    b.d1.length > 0 ||
    b.r2.length > 0 ||
    b.queues.length > 0 ||
    b.analytics.length > 0 ||
    b.do.length > 0 ||
    b.services.length > 0 ||
    b.assets !== ""
  );
}

/**
 * Turn the module's exports into plain top-level declarations, so the handler
 * object is reachable as `__sbHandlers` and Durable Object classes stay
 * addressable by name.
 *
 * Two shapes reach us. A hand-written file exports inline
 * (`export default { fetch }`), while a bundled one declares everything first
 * and re-exports at the end (`export { src_default as default, Counter }`) —
 * #89 made the second shape the normal case. Returns null when neither matches.
 */
export function neutraliseExports(source: string): string | null {
  if (/\bexport\s+default\s*\{/.test(source)) {
    return source
      .replace(/^(\s*)export\s+default\s*/m, "$1const __sbHandlers = ")
      .replace(/^export\s+(async\s+function|function|class|const|let|var)\b/gm, "$1");
  }
  // Not anchored to a line: a minified bundle puts the whole module on one
  // line. Bundlers emit exactly one such block, at the end.
  const blocks = [...source.matchAll(/export\s*\{([^}]*)\}\s*;?/g)];
  const block = blocks[blocks.length - 1];
  if (block === undefined) return null;
  let handler: string | null = null;
  const aliases: string[] = [];
  for (const entry of block[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const parts = entry.match(/^(\S+)(?:\s+as\s+(\S+))?$/);
    if (parts === null) continue;
    const local = parts[1];
    const exported = parts[2] ?? local;
    if (exported === "default") handler = local;
    // `export { Counter as Counter }` needs no alias; a renamed one does, so
    // `durable_objects` in the config can still name the class it expects.
    else if (exported !== local) aliases.push(`const ${exported} = ${local};`);
  }
  if (handler === null) return null;
  return source.replace(block[0], [`const __sbHandlers = ${handler};`, ...aliases].join("\n"));
}

/**
 * Build the final native-fetch module: the prelude (Web API shims + the broker
 * binding shim + the trigger dispatcher), then `const env = {…}` with the baked
 * `vars`, then — if any binding is declared — one `__sbInstallBindings(env, …)`
 * line, then the user's source with its `export` keywords neutralised (so its
 * `export default {…}` becomes a plain object we can hand to the dispatcher),
 * then our single `export default { fetch }` that routes every request through
 * `__sbEntry` (HTTP → `handlers.fetch`; `x-sb-trigger` → scheduled / queue / DO).
 *
 * With no bindings and no `scheduled`/`queue`/DO the output behaves exactly like
 * a plain `export default { fetch }` sprout.
 *
 * `port` is only the baked fallback in `export default { port }`; the runtime
 * reads `$PORT` first. The monorepo's bench path overrides it.
 *
 * ponytail: the sprout process is long-lived, so a handler that mutates `env`
 * leaks that change to later requests. Freeze upstream once Porffor supports
 * Object.freeze in native mode.
 */
export function wrapNativeFetchHandler(
  source: string,
  prelude: string,
  vars: Record<string, string> = {},
  bindings: Bindings = EMPTY_BINDINGS,
  port: number = DEFAULT_PORT,
  compatibilityDate: string = BASELINE_COMPATIBILITY_DATE,
  appName: string = "app",
  /** #15 — assets baked into the module for a binary that has no files beside it. */
  assets?: { manifest: unknown; files: Record<string, string> },
): string {
  const neutralised = neutraliseExports(source);
  if (neutralised === null || !/\bfetch\s*\(/.test(source)) {
    throw new Error("handler must default-export an object with a fetch(request) method");
  }

  const env = `const env = ${JSON.stringify(vars)};\nglobalThis.env = env;\n`;
  // Baked, not a binding: the date belongs to the artifact, and a handler must
  // not be able to change the semantics it was compiled against at runtime.
  const compat =
    `globalThis.__sbCompat = ${JSON.stringify(compatibilityDate)};\n` +
    // #15 — the embedded transport derives its default data directory from this.
    `globalThis.__sbAppName = ${JSON.stringify(appName)};\n` +
    // #15 — and enforces the outbound allowlist itself, with no broker to do it.
    `globalThis.__sbOutbound = ${JSON.stringify(bindings.outbound)};\n` +
    (assets ? `globalThis.__sbAssets = ${JSON.stringify(assets)};\n` : "");
  const wire = hasBindings(bindings) ? `__sbInstallBindings(env, ${JSON.stringify(bindings)});\n` : "";
  const registerDO = bindings.do.length
    ? `__sbRegisterDO({ ${bindings.do.map((d) => `${d.className}: ${d.className}`).join(", ")} });\n`
    : "";
  // Cron / queue / alarm timers, for a transport that has no broker to deliver
  // them. The broker transport defines this as a no-op, so the emitted module
  // is the same either way.
  const triggers = hasBindings(bindings) ? `__sbStartLocalTriggers(__sbHandlers, ${JSON.stringify(bindings)});\n` : "";

  return (
    `${prelude}\n${compat}${env}${wire}` +
    `${neutralised}\n` +
    `${registerDO}${triggers}` +
    `export default {\n  port: ${port},\n  fetch(request) { return __sbEntry(__sbHandlers, request); }\n};\n`
  );
}

type VarsJson = string | number | boolean | null | { readonly [key: string]: VarsJson } | VarsJson[];
function isVarsObject(value: VarsJson): value is { readonly [key: string]: VarsJson } {
  return value !== null && Object(value) === value && !Array.isArray(value);
}
function isVarsString(value: VarsJson): value is string {
  return Object(value) !== value && value === String(value);
}

/** `SPROUTBOAT_VARS_JSON` (set by the build) → a validated flat string map. */
export function readVarsFromEnv(): Record<string, string> {
  const raw = process.env.SPROUTBOAT_VARS_JSON;
  if (!raw) return {};
  const parsed: VarsJson = JSON.parse(raw);
  if (!isVarsObject(parsed)) throw new Error("SPROUTBOAT_VARS_JSON must be a JSON object");
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]): [string, string] => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key) || !isVarsString(value))
        throw new Error(`SPROUTBOAT_VARS_JSON.${key} must map an UPPER_SNAKE name to a string`);
      return [key, value];
    }),
  );
}

/**
 * `SPROUTBOAT_BINDINGS_JSON` (the artifact's `bindings.json`, passed by the
 * build) → a `Bindings` shape. Every field is re-validated here; unknown keys
 * are dropped and a missing / empty payload is `EMPTY_BINDINGS`, so an old build
 * with no bindings still compiles.
 */
export function readBindingsFromEnv(): Bindings {
  const raw = process.env.SPROUTBOAT_BINDINGS_JSON;
  if (!raw) return EMPTY_BINDINGS;
  const parsed: VarsJson = JSON.parse(raw);
  if (!isVarsObject(parsed)) throw new Error("SPROUTBOAT_BINDINGS_JSON must be a JSON object");
  const strings = (v: VarsJson): string[] => (Array.isArray(v) ? v.filter(isVarsString) : []);
  const services: Array<{ binding: string; service: string }> = [];
  if (Array.isArray(parsed.services)) {
    for (const entry of parsed.services) {
      if (isVarsObject(entry) && isVarsString(entry.binding) && isVarsString(entry.service)) {
        services.push({ binding: entry.binding, service: entry.service });
      }
    }
  }
  const dos: Array<{ binding: string; className: string }> = [];
  if (Array.isArray(parsed.do)) {
    for (const entry of parsed.do) {
      if (isVarsObject(entry) && isVarsString(entry.binding) && isVarsString(entry.className)) {
        dos.push({ binding: entry.binding, className: entry.className });
      }
    }
  }
  return {
    kv: strings(parsed.kv),
    secrets: strings(parsed.secrets),
    outbound: strings(parsed.outbound),
    d1: strings(parsed.d1),
    r2: strings(parsed.r2),
    queues: strings(parsed.queues),
    analytics: strings(parsed.analytics),
    do: dos,
    services,
    crons: strings(parsed.crons),
    assets: isVarsString(parsed.assets) ? parsed.assets : "",
  };
}
