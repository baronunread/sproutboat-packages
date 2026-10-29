import { hasEntryHandler, inlineWorkersImports, neutraliseExports } from "./wrap";

export type SourceValidation = { ok: true } | { ok: false; errors: string[] };

// Checked against the *bundled* module (#89), not the entry file: after
// bundling there are no imports left to reject, and a dependency reaching for a
// Node API has to fail exactly as hand-written code would. A bare specifier
// that resolves to nothing never gets this far — the bundler fails first.
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
  [/\b(process|Bun|Deno|Buffer)\.[a-zA-Z_$]|\bnew\s+Buffer\s*\(/, "Node, Bun, and Deno APIs are not supported"],
  // `node:` only means something as an import specifier; a bare substring
  // match would also flag it appearing in an ordinary string a dependency
  // happens to construct (a doc link, a log message).
  [/['"`]node:/, "Node, Bun, and Deno APIs are not supported"],
];

/** `new WebSocket(url)` connects out from this compatibility date (earlier, only WebSocketPair makes one). */
export const OUTBOUND_WEBSOCKET_DATE = "2026-11-01";

/**
 * From this date `cloudflare:sockets` connect() exists, and so does the bundled Buffer and process
 * stub a database driver brings: the bundler inlines both, so `Buffer.from` and `process.nextTick`
 * in the output are the bundle's own code, not a host API.
 */
export const SOCKETS_DATE = "2026-11-02";
const driverAllowed = (message: string) => message === "Node, Bun, and Deno APIs are not supported";

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
  const sockets = compatibilityDate !== undefined && compatibilityDate >= SOCKETS_DATE;
  for (const [pattern, message] of alwaysForbidden) {
    if (sockets && driverAllowed(message) && !/['"`]node:/.test(source)) continue;
    if (pattern.test(source)) errors.push(message);
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
