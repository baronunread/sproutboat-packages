/**
 * Static-asset manifest. `sproutboat build` copies the project's `assets`
 * directory next to the artifact and writes `assets.json` (this manifest); the
 * edge serves matching files directly (assets-first, like Cloudflare), and the
 * broker's `assets.get` op backs `env.<ASSETS>.fetch(request)` for the paths
 * the sprout chooses to serve itself.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

export type AssetEntry = { hash: string; size: number; type: string };
/** `/absolute/posix/path` -> entry. Serialised into `assets.json`. */
export type AssetFiles = { [path: string]: AssetEntry };
/** A `_headers` block: `set` applied in order, `unset` (`! Name`) removed. */
export type HeaderRule = { pattern: string; set: [string, string][]; unset: string[] };
/** A `_redirects` line: `from  to  [status]`, `:name` segments and a trailing `*` -> `:splat`. */
export type RedirectRule = { from: string; to: string; status: number };
export type AssetManifest = {
  /** Fallback for requests that match no file, applied by the broker. */
  notFound: "none" | "single-page-application" | "404-page";
  /** `true` = every path to the sprout first; string[] = selective (leading `!` negates). */
  runSproutFirst: boolean | string[];
  files: AssetFiles;
  /** Parsed from `_headers` at the assets root (#61). Omitted when there is none. */
  headers?: HeaderRule[];
  /** Parsed from `_redirects` at the assets root (#61). Omitted when there is none. */
  redirects?: RedirectRule[];
};

const TYPES = new Map<string, string>([
  ["html", "text/html; charset=utf-8"],
  ["css", "text/css; charset=utf-8"],
  ["js", "text/javascript; charset=utf-8"],
  ["mjs", "text/javascript; charset=utf-8"],
  ["json", "application/json; charset=utf-8"],
  ["map", "application/json; charset=utf-8"],
  ["txt", "text/plain; charset=utf-8"],
  ["xml", "application/xml; charset=utf-8"],
  ["svg", "image/svg+xml"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
  ["ico", "image/x-icon"],
  ["woff2", "font/woff2"],
  ["woff", "font/woff"],
  ["ttf", "font/ttf"],
  ["wasm", "application/wasm"],
  ["webmanifest", "application/manifest+json"],
]);

export function contentType(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot >= 0 ? TYPES.get(name.slice(dot + 1).toLowerCase()) : undefined) ?? "application/octet-stream";
}

/**
 * Resolve a request path to a manifest key the way a static host does:
 *   - an exact hit wins;
 *   - a directory path (`/docs/`) tries `/docs/index.html`;
 *   - an extensionless path (`/docs`) tries `/docs.html`, then `/docs/index.html`.
 * Returns the matched key, or `null`. This only picks which file to serve — no
 * canonical redirects, and the caller still owns not-found handling. Mirrors
 * Cloudflare's `html_handling: "auto-trailing-slash"` minus the 3xx responses.
 */
export function resolveAssetKey(path: string, has: (key: string) => boolean): string | null {
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.endsWith("/")) {
    const index = `${path}index.html`;
    return has(index) ? index : null;
  }
  if (has(path)) return path;
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (!base.includes(".")) {
    if (has(`${path}.html`)) return `${path}.html`;
    if (has(`${path}/index.html`)) return `${path}/index.html`;
  }
  return null;
}

/** Walk `dir` recursively, returning `{ "/path": {hash,size,type} }`. `_headers`/`_redirects` at the root are config, not servable files (#61) — see `readAssetRules`. */
export function walkAssets(dir: string) {
  const out: AssetFiles = {};
  const recurse = (abs: string, rel: string): void => {
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      if (ent.name.startsWith(".")) continue;
      if (rel === "" && (ent.name === "_headers" || ent.name === "_redirects")) continue;
      const childAbs = join(abs, ent.name);
      const childRel = posix.join(rel, ent.name);
      if (ent.isDirectory()) {
        recurse(childAbs, childRel);
        continue;
      }
      if (!ent.isFile()) continue;
      const body = readFileSync(childAbs);
      out[`/${childRel}`] = {
        hash: createHash("sha256").update(body).digest("hex"),
        size: body.byteLength,
        type: contentType(ent.name),
      };
    }
  };
  recurse(dir, "");
  return out;
}

/** Does `pathname` hit the sprout before assets, given a `runSproutFirst` spec? */
export function isSproutFirst(spec: boolean | string[], pathname: string): boolean {
  if (!Array.isArray(spec)) return spec;
  let matched = false;
  for (const raw of spec) {
    const negate = raw.startsWith("!");
    const pattern = negate ? raw.slice(1) : raw;
    if (globMatch(pattern, pathname)) matched = !negate;
  }
  return matched;
}

/** `*` matches within a segment, `**` across segments. Anchored both ends. */
function globMatch(pattern: string, path: string): boolean {
  const rx = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, " ")
    .replace(/\*/g, "[^/]*")
    .replace(/ /g, ".*");
  return new RegExp(`^${rx}$`).test(path);
}

const MAX_HEADER_RULES = 2000;
const MAX_REDIRECT_RULES = 2000;

/**
 * Parse a Pages/Netlify-style `_headers` file: a path pattern at column 0,
 * followed by indented `Name: value` lines (`! Name` strips a header
 * downstream). A blank line or a new pattern line ends the current block.
 */
export function parseHeaders(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let current: HeaderRule | null = null;
  for (const rawLine of text.split("\n")) {
    if (rawLine.trim() === "" || /^\s*#/.test(rawLine)) {
      current = null;
      continue;
    }
    if (!/^\s/.test(rawLine)) {
      if (rules.length >= MAX_HEADER_RULES) {
        current = null;
        continue;
      }
      current = { pattern: rawLine.trim(), set: [], unset: [] };
      rules.push(current);
      continue;
    }
    if (!current) continue;
    const line = rawLine.trim();
    if (line.startsWith("!")) {
      current.unset.push(line.slice(1).trim());
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    current.set.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return rules;
}

/**
 * `_headers` patterns follow Netlify/Pages semantics, not `globMatch`'s
 * (`run_sprout_first` deliberately keeps a bare `*` inside one segment) — a
 * trailing `*` here is greedy across `/`, so `/assets/*` catches
 * `/assets/deeply/nested.js` the way a real `_headers` file expects.
 */
function headerPatternMatches(pattern: string, pathname: string): boolean {
  const patternSegments = pattern.split("/").filter(Boolean);
  const pathSegments = pathname.split("/").filter(Boolean);
  for (let i = 0; i < patternSegments.length; i++) {
    if (patternSegments[i] === "*") return true;
    if (pathSegments[i] !== patternSegments[i]) return false;
  }
  return patternSegments.length === pathSegments.length;
}

/** Every `_headers` rule whose pattern matches `pathname`, in file order (a later rule can override or unset an earlier one when applied). */
export function matchHeaders(rules: readonly HeaderRule[], pathname: string): HeaderRule[] {
  return rules.filter((rule) => headerPatternMatches(rule.pattern, pathname));
}

/**
 * Parse a Pages/Netlify-style `_redirects` file: `from  to  [status]` per
 * line, whitespace-separated. `status` must be a 3xx (defaults to 302 when
 * omitted); anything else is dropped as malformed rather than silently
 * treated as a rewrite.
 */
export function parseRedirects(text: string): RedirectRule[] {
  const rules: RedirectRule[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const [from, to, statusText] = parts;
    const status = statusText ? Number(statusText) : 302;
    if (!Number.isInteger(status) || status < 300 || status > 399) continue;
    rules.push({ from, to, status });
    if (rules.length >= MAX_REDIRECT_RULES) break;
  }
  return rules;
}

/**
 * Match `pathname` against one `_redirects` rule's `from`, substituting
 * `:name` segments and a trailing `*` (as `:splat`) into `to`. `null` if the
 * rule doesn't match.
 *
 * The splat case matches on the literal string prefix up to `*`, not a
 * segment array — `pathname.split("/").filter(Boolean)` would collapse
 * `/blog` and `/blog/` to the same `["blog"]`, wrongly matching `/blog/*`
 * against a path that never reaches the `/` the wildcard starts after.
 */
export function matchRedirect(rule: RedirectRule, pathname: string): string | null {
  const starIndex = rule.from.indexOf("*");
  if (starIndex !== -1) {
    const prefix = rule.from.slice(0, starIndex);
    if (!pathname.startsWith(prefix)) return null;
    const splat = pathname.slice(prefix.length);
    return rule.to.split(":splat").join(splat);
  }

  const fromSegments = rule.from.split("/").filter(Boolean);
  const pathSegments = pathname.split("/").filter(Boolean);
  if (fromSegments.length !== pathSegments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < fromSegments.length; i++) {
    const segment = fromSegments[i];
    if (segment.startsWith(":")) {
      params[segment.slice(1)] = pathSegments[i];
      continue;
    }
    if (pathSegments[i] !== segment) return null;
  }

  let to = rule.to;
  for (const [name, value] of Object.entries(params)) to = to.split(`:${name}`).join(value);
  return to;
}

export type AssetRules = { headers: HeaderRule[]; redirects: RedirectRule[] };

/** Read and parse `_headers`/`_redirects` from the assets root, if present. */
export function readAssetRules(dir: string): AssetRules {
  const headersPath = join(dir, "_headers");
  const redirectsPath = join(dir, "_redirects");
  return {
    headers: existsSync(headersPath) ? parseHeaders(readFileSync(headersPath, "utf8")) : [],
    redirects: existsSync(redirectsPath) ? parseRedirects(readFileSync(redirectsPath, "utf8")) : [],
  };
}
