/**
 * The standalone binary's source shape: sproutd's worker shape applied to the CLI's generated module.
 *
 * The CLI generates one module (prelude, transport, app) that ends with `export default { port, fetch }`.
 * Compiled as it is, that default export would link the node server runtime (serve.js, uws, libuv, streams:
 * +1 MB and a JS request path per request). Instead the module is compiled as `shared-prelude.js` (so the
 * chain's P4 makes every name it declares or assigns on `globalThis` prelude-owned and no runtime module is
 * pulled in by a free `fetch`, `crypto`, `Buffer` or `process`), preceded by the preamble (the helper names
 * the generated module uses, over the current layouts, host-driven timers, the rejection hook) and the web
 * classes (vendored in `standalone-server/`), and followed by the dispatch shim; `export default` becomes
 * `globalThis.__forkHandler`. The entry (`sprout.generated.js`) just imports it. The server is the vendored
 * uWebSockets shim over the native-fetch bridge (native-fetch-a22.c), both compiled by the CLI beside the units.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { webClassesSource } from "./standalone-server";
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
 * The web classes of the standalone prelude: the vendored `standalone-server/web-classes.js` (Porffor
 * alpha 19's runtime/fetch-globals.js with the toolchain's seven class patches, minus its four C-timer
 * functions, each class assigned on `globalThis`, which on alpha 22+ binds every free reference
 * program-wide (P4)). Its provenance header says where it came from; the content is checked in.
 */
export function standaloneWebClasses(): string {
  const src = webClassesSource();
  const names = [...src.matchAll(/^class ([A-Za-z]+)/gm)].map((m) => m[1]);
  const expected = ["Headers", "Blob", "File", "TextEncoder", "TextDecoder", "URL", "Request", "Response"];
  if (names.join(",") !== expected.join(","))
    throw new Error(`standalone-server/web-classes.js: classes are ${names.join(",")}`);
  return src;
}

/**
 * Compose the alpha 22 standalone sources from the CLI's generated module (the exact text alpha 19
 * compiles). Returns the two files to write beside each other: the entry and the shared prelude.
 */
export function composeStandaloneA21(generated: string) {
  const tail = generated.match(ENTRY_TAIL);
  if (!tail) throw new Error("generated module: the `export default { port, fetch }` tail is not the wrapper's");
  const port = Number(tail[1]);
  const body = generated.slice(0, generated.length - tail[0].length + 1);
  const sharedPrelude =
    preambleSource +
    standaloneWebClasses() +
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
