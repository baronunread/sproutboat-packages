import { neutraliseExports } from "./wrap";

export type SourceValidation = { ok: true } | { ok: false; errors: string[] };

// Checked against the *bundled* module (#89), not the entry file: after
// bundling there are no imports left to reject, and a dependency reaching for a
// Node API has to fail exactly as hand-written code would. A bare specifier
// that resolves to nothing never gets this far — the bundler fails first.
const alwaysForbidden: Array<[RegExp, string]> = [
  [/^\s*import\s/m, "an import survived bundling — only static imports can be resolved at build time"],
  [/\bimport\s*\(/, "dynamic import() is not supported: nothing can resolve it at build time"],
  [/\brequire\s*\(/, "CommonJS require is not supported"],
  [/\b(WebSocket|XMLHttpRequest)\s*\(/, "WebSocket / XMLHttpRequest are not supported"],
  [/\b(process|Bun|Deno|Buffer|node:)\b/, "Node, Bun, and Deno APIs are not supported"],
  // Porffor alpha-4 compiles `new Proxy(...)` and then ignores the handler: a
  // trapped property reads back as `undefined`, with no throw. Rejecting it
  // here is the difference between a build error and a 502 nobody can explain.
  // It is why itty-router and other Proxy-based routers do not work yet.
  [
    /\bnew\s+Proxy\s*\(|\bProxy\s*\.\s*revocable\s*\(/,
    "Proxy is not supported by the compiler: its traps are silently ignored and the property reads back as undefined",
  ],
];

const fetchWithoutAllowlist: [RegExp, string] = [
  /(?:\breturn\s+|\bawait\s+|=\s*)fetch\s*\(/,
  "outbound networking needs an `outbound` host allowlist in sproutboat.jsonc",
];

export function validateHttpSyncSource(source: string, outboundAllowed = false): SourceValidation {
  const errors: string[] = [];
  // The default export must be an object literal with a `fetch` method. A module
  // may also declare Durable Object classes / helpers before it, so this is not
  // anchored to the start of the file.
  // A hand-written file exports inline; a bundled one re-exports at the end.
  // `neutraliseExports` is the same reader the compiler uses, so `check` cannot
  // accept a module the build would then reject.
  if (neutraliseExports(source) === null || !/\bfetch\s*\(/.test(source)) {
    errors.push("handler must default-export an object with fetch(request)");
  }
  for (const [pattern, message] of alwaysForbidden) if (pattern.test(source)) errors.push(message);
  if (!outboundAllowed && fetchWithoutAllowlist[0].test(source)) errors.push(fetchWithoutAllowlist[1]);
  return errors.length ? { ok: false, errors } : { ok: true };
}
