/**
 * The standalone binary's source shape on the alpha 21 line (alpha 22): sproutd's worker shape
 * applied to the CLI's generated module.
 *
 * On alpha 19 the CLI compiles one generated module (prelude, transport, app) that ends with
 * `export default { port, fetch }`, which selects Porffor's native-fetch server. On alpha 22 that
 * default export would link the node server runtime (serve.js, uws, libuv, streams: +1 MB and a JS
 * request path per request). Instead the module is compiled as `shared-prelude.js` (so the chain's
 * P4 makes every name it declares or assigns on `globalThis` prelude-owned and no runtime module is
 * pulled in by a free `fetch`, `crypto`, `Buffer` or `process`), preceded by the preamble (the alpha
 * 19 helper names over alpha 22's layouts, host-driven timers, the rejection hook) and the alpha 19
 * web classes, and followed by the dispatch shim; `export default` becomes `globalThis.__forkHandler`.
 * The entry (`sprout.generated.js`) just imports it. The server is the alpha 19 uWebSockets shim over
 * the alpha 22 native-fetch bridge (native-fetch-a22.c), both compiled by the CLI beside the units.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error Bun's text loader supplies a string.
import preambleSource from "./standalone-preamble.js" with { type: "text" };
// @ts-expect-error Bun's text loader supplies a string.
import dispatchSource from "./standalone-dispatch.js" with { type: "text" };

/** The name the composed module must have: the chain's P4 and P6 key on it. */
export const SHARED_PRELUDE_FILE = "shared-prelude.js";
/** Every standalone compile on the alpha 21 line passes these (P7: a stable entry path for derived names). */
export const STANDALONE_A21_COMPILE_FLAGS = ["--sb-entry-file=/sproutboat/sprout.generated.js"];

const ENTRY_TAIL =
  /\nexport default \{\n  port: (\d+),\n  fetch\(request\) \{ return __sbEntry\(__sbUserHandlers, request\); \}\n\};\n$/;

/**
 * The alpha 19 web classes as the live generation compiles them: the patched alpha 19 tree's
 * `runtime/fetch-globals.js` (the toolchain's seven class patches already applied there) minus its
 * four C-timer functions (the preamble's table replaces alpha 19's C timer records), each class then
 * assigned on `globalThis`, which on alpha 22 binds every free reference program-wide (P4).
 */
export function alpha19WebClasses(alpha19Root: string): string {
  let src = readFileSync(join(alpha19Root, "runtime/fetch-globals.js"), "utf8");
  const timers = src.indexOf("\nfunction setTimeout(");
  const blob = src.indexOf("\nclass Blob {");
  if (timers < 0 || blob < timers) throw new Error("alpha 19 fetch-globals.js: the timer functions moved");
  src = src.slice(0, timers) + "\n" + src.slice(blob);
  const names = [...src.matchAll(/^class ([A-Za-z]+)/gm)].map((m) => m[1]);
  const expected = ["Headers", "Blob", "File", "TextEncoder", "TextDecoder", "URL", "Request", "Response"];
  if (names.join(",") !== expected.join(","))
    throw new Error(`alpha 19 fetch-globals.js: classes are ${names.join(",")}`);
  return (
    "// Alpha 19 web classes: Porffor alpha 19's runtime/fetch-globals.js with the toolchain's patches, so the\n" +
    "// live generation's Headers, Request, Response, Blob, File, URL, TextEncoder and TextDecoder are the\n" +
    "// prelude's own on alpha 22 (@sproutboat/toolchain/a21 standalone.ts).\n" +
    src +
    names.map((n) => `globalThis.${n} = ${n};\n`).join("")
  );
}

/**
 * Compose the alpha 22 standalone sources from the CLI's generated module (the exact text alpha 19
 * compiles). Returns the two files to write beside each other: the entry and the shared prelude.
 */
export function composeStandaloneA21(generated: string, alpha19Root: string) {
  const tail = generated.match(ENTRY_TAIL);
  if (!tail) throw new Error("generated module: the `export default { port, fetch }` tail is not the wrapper's");
  const port = Number(tail[1]);
  const body = generated.slice(0, generated.length - tail[0].length + 1);
  const sharedPrelude =
    preambleSource +
    alpha19WebClasses(alpha19Root) +
    body +
    `globalThis.__forkHandler = { fetch(request) { return __sbEntry(__sbUserHandlers, request); } };\n` +
    // the baked port, read by the bridge's porf_native_fetch_get_port ($PORT first)
    `Porffor.c\`double sb_standalone_port = ${port};\`;\n` +
    dispatchSource;
  return { entry: `import "./${SHARED_PRELUDE_FILE}";\n`, sharedPrelude, port };
}

/**
 * porf__main.c as a server's unit: no `main` (the shim has it) and `porf_data_init` reachable from
 * the bridge (it is static). Idempotent; the CLI applies it to the compiler's output before building.
 */
export function prepareMainUnit(file: string): void {
  const text = readFileSync(file, "utf8");
  if (text.includes("sb_data_init")) return;
  const from = "\nint main(int argc, char** argv) {\n";
  if (text.split(from).length !== 2) throw new Error(`${file}: the main function anchor changed`);
  writeFileSync(
    file,
    text.replace(from, "\nint porf_gen_main(int argc, char** argv) {\n") +
      "\n// sproutboat alpha 22 standalone: the bridge initializes the data image (porf_data_init is static)\nvoid sb_data_init(void) { porf_data_init(); }\n",
  );
}
