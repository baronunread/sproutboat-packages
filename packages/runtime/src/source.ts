import { hasEntryHandler, inlineWorkersImports, neutraliseExports } from "./wrap";

export type SourceValidation = { ok: true } | { ok: false; errors: string[] };

// Checked against the *bundled* module (#89), not the entry file: after
// bundling there are no imports left to reject, and a dependency reaching for a
// Node API has to fail exactly as hand-written code would. A bare specifier
// that resolves to nothing never gets this far — the bundler fails first.
const NODE_GLOBAL_USE = /\b(process|Bun|Deno|Buffer)\.[a-zA-Z_$]|\bnew\s+Buffer\s*\(/;

const alwaysForbidden: Array<[RegExp, string]> = [
  [/^\s*import\s/m, "an import survived bundling — only static imports can be resolved at build time"],
  [/\bimport\s*\(/, "dynamic import() is not supported: nothing can resolve it at build time"],
  [/\brequire\s*\(/, "CommonJS require is not supported"],
  [/\bXMLHttpRequest\s*\(/, "XMLHttpRequest is not supported"],
  // baronunread/sproutboat#132 — a bare identifier match flags a *local*
  // `function process()` as readily as the global: zod v4 declares exactly
  // that (its internal `process(schema, ctx)`), so importing zod alone used
  // to fail this check pointing at code the handler author never wrote. A
  // Node/Bun/Deno API is always reached through a member access or `new`;
  // requiring that shape lets a local binding of the same name through.
  // No whitespace is allowed around the `.`: real member access never has
  // any (`process.env`, always contiguous), while prose mentioning the word
  // does (a bundled comment ending "...unique to this process. The id...").
  [NODE_GLOBAL_USE, "Node, Bun, and Deno APIs are not supported"],
  // `node:` only means something as an import specifier; a bare substring
  // match would also flag it appearing in an ordinary string a dependency
  // happens to construct (a doc link, a log message).
  [/['"`]node:/, "Node, Bun, and Deno APIs are not supported"],
];

/**
 * From this compatibility date the Node/Bun/Deno global check skips a use that sits behind a
 * `typeof X` feature test (supabase-js, @neondatabase/serverless and many others carry a Node or
 * Deno branch next to the Web one), a global the bundle declares itself (a bundled `buffer`
 * polyfill) and one that only appears inside a string or comment. Earlier
 * dates keep the plain pattern match. Proposed value, to be chosen by a maintainer.
 */
export const GUARDED_GLOBALS_DATE = "2026-11-15";

const STRINGS_AND_COMMENTS = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/**
 * True when the module reaches for a Node/Bun/Deno global that it neither declares itself nor
 * feature-tests first. A bundled polyfill declares its own `Buffer` (`function Buffer(){}`), and a
 * Node branch sits behind `typeof X !== "undefined"` or `typeof atob === "undefined"`.
 */
function usesNodeGlobalUnguarded(module: string): boolean {
  const code = module.replace(STRINGS_AND_COMMENTS, (m) => (m[0] === "/" ? " " : m[0] + m[0]));
  const declared = (name: string) => new RegExp("(?:function|class|var|let|const)\\s+" + name + "\\b").test(code);
  const local = new Set(["process", "Bun", "Deno", "Buffer"].filter(declared));
  const re = new RegExp(NODE_GLOBAL_USE.source, "g");
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    const name = m[1] ?? "Buffer";
    if (local.has(name)) continue;
    const before = code.slice(Math.max(0, m.index - 600), m.index);
    // `typeof globalThis.Buffer.from`: the use is the feature test itself.
    if (/typeof\s+(?:(?:globalThis|self|global|window)\.)?$/.test(before)) continue;
    if (new RegExp("typeof\\s+(?:(?:globalThis|self|global|window)\\.)?" + name + "\\b").test(before)) continue;
    // `if (typeof atob === "undefined") { ... Buffer.from(...) }`: a test for something else, just before.
    if (/typeof\s+[\w$.]+\s*[!=]==?\s*""/.test(before.slice(-200))) continue;
    return true;
  }
  return false;
}

/** `new WebSocket(url)` connects out from this compatibility date (earlier, only WebSocketPair makes one). */
export const OUTBOUND_WEBSOCKET_DATE = "2026-11-01";

export function validateHttpSyncSource(module: string, compatibilityDate?: string): SourceValidation {
  // `cloudflare:workers` is the one import allowed past bundling: the compiler turns it
  // into globals the same way (see inlineWorkersImports).
  const source = inlineWorkersImports(module);
  const errors: string[] = [];
  // The default export must be an object literal with a `fetch` method. A module
  // may also declare Durable Object classes / helpers before it, so this is not
  // anchored to the start of the file.
  // A hand-written file exports inline; a bundled one re-exports at the end.
  // `neutraliseExports` is the same reader the compiler uses, so `check` cannot
  // accept a module the build would then reject.
  // A WorkerEntrypoint may serve only RPC, and a Worker only scheduled() or queue() (a cron
  // or queue consumer), with no fetch() at all, as in workerd.
  if (neutraliseExports(source) === null || !hasEntryHandler(source)) {
    errors.push(
      "handler must default-export an object with fetch(request), scheduled() or queue(), or a WorkerEntrypoint class",
    );
  }
  const guardedGlobals = compatibilityDate !== undefined && compatibilityDate >= GUARDED_GLOBALS_DATE;
  for (const [pattern, message] of alwaysForbidden) {
    if (pattern === NODE_GLOBAL_USE && guardedGlobals ? !usesNodeGlobalUnguarded(source) : !pattern.test(source))
      continue;
    errors.push(message);
  }
  if (
    /\bWebSocket\s*\(/.test(source) &&
    !(compatibilityDate !== undefined && compatibilityDate >= OUTBOUND_WEBSOCKET_DATE)
  )
    errors.push(
      `WebSocket() needs compatibility_date ${OUTBOUND_WEBSOCKET_DATE} or later (earlier dates have WebSocketPair only)`,
    );
  return errors.length ? { ok: false, errors } : { ok: true };
}
