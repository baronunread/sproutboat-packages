/**
 * Idempotent, marker-guarded in-place edits to Porffor's generated C
 * (`compiler/render.js`, `compiler/index.js`, `compiler/uwebsockets.js`,
 * `compiler/builtins/typedarray.js`, `compiler/builtins/date.ts`). Run
 * from the build path, not a `postinstall` hook: package managers block
 * dependency lifecycle scripts by default, so a published `postinstall` would
 * silently not run.
 *
 * Each edit is independent and re-applied on every build; a file patched by an
 * older version of this module still receives the newer edits. All of them are
 * tracked in the platform's upstream notes:
 * https://github.com/baronunread/sproutboat/tree/main/patches/upstream
 * They go away as Porffor closes the gaps.
 */
import { readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { patchUnicode } from "./unicode";

// --- compiler/render.js: the native-fetch server, rendered as C text ---

/** The `porf_native_fetch_get_port()` open brace: $PORT / --port injection site. */
const PORT_ANCHOR = "f64 porf_native_fetch_get_port(void) {\n";
/** Port from $PORT (the supervisor and `sproutboat dev` set it). */
const PORT_INJECT =
  '  const char* __sb_port = getenv("PORT");\n' +
  "  if (__sb_port && *__sb_port) { long __sb_v = strtol(__sb_port, NULL, 10); if (__sb_v > 0 && __sb_v < 65536) return (f64)__sb_v; }\n";
const PORT_MARKER = 'getenv("PORT")';

/**
 * baronunread/sproutboat#165 — a handler's `console.log` / `console.error` goes
 * to stdout via `printf`, which is fully buffered when stdout is not a TTY (a
 * pipe, a file, a service manager) and never flushed, because the native-fetch
 * server loop never returns. So the output simply vanishes.
 *
 * Point stdout at stderr — the conventional log sink, and where Porffor already
 * writes its own banner and diagnostics — and make it unbuffered so records
 * land as they happen. Applies to every native-fetch build; a deployed sprout's
 * supervisor wants the same records (#87, #146).
 */
const CONSOLE_ANCHOR = "  signal(SIGPIPE, SIG_IGN);\n";
const CONSOLE_INJECT =
  "  /* sproutboat #165: unbuffered handler console output, routed to stderr */\n" +
  "  dup2(2, 1);\n" +
  "  setvbuf(stdout, NULL, _IONBF, 0);\n";
const CONSOLE_MARKER = "sproutboat #165";

/** render.js edits: `[marker, anchor, inject, what]`, each inserted after its anchor. */
const RENDER_EDITS = [
  [PORT_MARKER, PORT_ANCHOR, PORT_INJECT, "$PORT support"],
  [CONSOLE_MARKER, CONSOLE_ANCHOR, CONSOLE_INJECT, "console output sink (#165)"],
] as const;

/**
 * baronunread/sproutboat#172 — `porf_native_fetch_read_value`'s `bytestring`
 * branch (Porffor's Latin-1-range string representation) copies the raw code
 * units straight onto the wire, as if they were already UTF-8 bytes. Any unit
 * >= 0x80 — any non-ASCII Latin-1 character — reaches the client corrupt
 * instead of UTF-8 encoded. Response bodies and header values both go through
 * this function, so both are affected; the sibling `string` (UTF-16) branch a
 * few lines down already encodes correctly, this makes the `bytestring` one
 * do the same, one byte in instead of two.
 */
const BYTESTRING_ANCHOR =
  "  if (value.type == ${TYPES.bytestring}) {\n" +
  "    const u32 ptr = (u32)value.val;\n" +
  "    *out_buf = (const char*)(MEM + ptr + 4);\n" +
  "    *out_len = (size_t)*(u32*)(MEM + ptr);\n" +
  "    return 0;\n" +
  "  }";
const BYTESTRING_INJECT =
  "  if (value.type == ${TYPES.bytestring}) {\n" +
  "    // sproutboat #172: units are Latin-1 code points, not UTF-8 bytes -- encode them\n" +
  "    const u32 ptr = (u32)value.val;\n" +
  "    const size_t len = (size_t)*(u32*)(MEM + ptr);\n" +
  "    const unsigned char* units = (const unsigned char*)(MEM + ptr + 4);\n" +
  "    char* utf8 = (char*)malloc(len * 2);\n" +
  "    if (!utf8 && len > 0) return -1;\n" +
  "    size_t out_len_local = 0;\n" +
  "    for (size_t i = 0; i < len; i++) {\n" +
  "      unsigned char c = units[i];\n" +
  "      if (c < 0x80) utf8[out_len_local++] = (char)c;\n" +
  "      else {\n" +
  "        utf8[out_len_local++] = (char)(0xc0 | (c >> 6));\n" +
  "        utf8[out_len_local++] = (char)(0x80 | (c & 0x3f));\n" +
  "      }\n" +
  "    }\n" +
  "    *out_buf = utf8;\n" +
  "    *out_len = out_len_local;\n" +
  "    *out_owned = utf8;\n" +
  "    return 0;\n" +
  "  }";
const BYTESTRING_MARKER = "sproutboat #172";

/**
 * baronunread/sproutboat#176 — #172 broke the assets binding, which reads a
 * file's bytes off disk into a `bytestring` specifically so they can pass
 * through the wire untouched (already-finished bytes: a UTF-8 text file's
 * bytes are already UTF-8, a binary file's bytes are just bytes, neither
 * should ever be "encoded" again). A `bytestring` carrying real text a
 * handler built and one carrying opaque file bytes are the same type with no
 * way to tell them apart at this point — so the caller has to say which one
 * this is.
 *
 * `porf_native_fetch_read_value` is called from ~30 places across
 * sproutboat's own inline C (crypto, SQL params, R2/D1 paths, the HTTP
 * client), every one of them genuine text, every one needing #172's
 * encoding unchanged — widening its signature would mean touching all of
 * them for zero behavior change, for one caller that needs something
 * different. Add a second, dedicated function instead:
 * `porf_native_fetch_read_raw_bytes`, zero-copy, bytestring-only, no
 * encoding, ever. Only `write_response_value`'s body read (uwebsockets.js,
 * below) calls it, gated on the reserved `x-sb-raw-body` response header the
 * assets binding sets. Every existing call site is untouched.
 */
const READ_RAW_ANCHOR =
  "int porf_native_fetch_read_value(jsval value, const char** out_buf, size_t* out_len, char** out_owned) {";
const READ_RAW_INJECT =
  "// sproutboat #176: zero-copy passthrough for a bytestring that is already-\n" +
  "// finished bytes (an asset read off disk), never a string to UTF-8 encode.\n" +
  "// Deliberately not folded into porf_native_fetch_read_value above: that one\n" +
  "// is called from ~30 places across sproutboat's own inline C, all genuine\n" +
  "// text, all needing its encoding unchanged.\n" +
  "int porf_native_fetch_read_raw_bytes(jsval value, const char** out_buf, size_t* out_len) {\n" +
  "  if (value.type != ${TYPES.bytestring}) return -1;\n" +
  "  const u32 ptr = (u32)value.val;\n" +
  "  *out_buf = (const char*)(MEM + ptr + 4);\n" +
  "  *out_len = (size_t)*(u32*)(MEM + ptr);\n" +
  "  return 0;\n" +
  "}\n" +
  "\n" +
  READ_RAW_ANCHOR;
const READ_RAW_MARKER = "porf_native_fetch_read_raw_bytes(jsval value";

/**
 * baronunread/sproutboat#178: every async function runs on its own fiber
 * stack, and Porffor (alpha-10 through alpha-13) fixes those at 256 KiB. A
 * large handler compiled at -O0 (what `sproutboat dev` builds) spends ~40 KiB
 * of stack per call into the biggest generated functions, so a few nested
 * awaits run off the end into the guard page and the sprout dies with SIGBUS
 * on its first request, no log.
 * -O3 frames are smaller, which only raises the threshold: a deep enough
 * async chain hits it in a release build too.
 *
 * Match a thread's usual 8 MiB. The reservation is MAP_NORESERVE with a guard
 * page, so only touched pages cost memory and a shallow handler pays nothing.
 */
const CORO_STACK_ANCHOR = "#define PORF_CORO_STACK_SIZE (256u * 1024u)";
const CORO_STACK_INJECT =
  "// sproutboat #178: 256 KiB overflows -O0 frames in a few nested awaits.\n" +
  "#define PORF_CORO_STACK_SIZE (8u * 1024u * 1024u)";
const CORO_STACK_MARKER = "sproutboat #178";

/**
 * render.js full-block replacements: `[marker, anchor, inject, what]`, each a
 * complete swap of the matched region (unlike `RENDER_EDITS`, which only ever
 * inserts after its anchor).
 */
const RENDER_REPLACEMENTS = [
  [BYTESTRING_MARKER, BYTESTRING_ANCHOR, BYTESTRING_INJECT, "bytestring UTF-8 encoding (#172)"],
  [READ_RAW_MARKER, READ_RAW_ANCHOR, READ_RAW_INJECT, "raw bytestring passthrough function (#176)"],
  [CORO_STACK_MARKER, CORO_STACK_ANCHOR, CORO_STACK_INJECT, "coroutine stack size (#178)"],
] as const;

// #15 — no `--port` flag: Porffor's native-fetch entry point calls
// `porf_init(0, NULL)` (see porf_native_fetch_runtime_init in render.js), so a
// native-fetch binary never sees argv at all. A standalone binary takes its
// port and data directory from the environment instead, which is what systemd
// and docker set anyway. Worth an upstream note alongside the $PORT ask.

/**
 * #15 — let the build add objects to the native-fetch link line.
 *
 * Porffor builds `linkArgs` as a fixed array, so an embedded backend that needs
 * SQLite compiled into the sprout has nowhere to put it. `CXX` is not a way in:
 * a musl (deploy) build overrides it outright. This splices one spread of
 * `SB_EXTRA_LINK` before `-lm`, inert unless the variable is set.
 */
const LINK_ANCHOR = "        uSocketsArchive,\n        '-lm'\n";
const LINK_INJECT =
  "        ...(process.env.SB_EXTRA_LINK ? process.env.SB_EXTRA_LINK.split(' ').filter(Boolean) : []),\n";
const LINK_MARKER = "SB_EXTRA_LINK";

/**
 * baronunread/sproutboat#256: inside a function, Porffor gives a named class
 * expression's own name, as seen from its methods, a fresh function object
 * instead of the class. So `var R = class l { static lex() { return new l() } }`
 * builds an object with none of the class's methods ("value is not a
 * constructor"). Top level is fine. Since #238 every handler runs inside a
 * function, and bundlers emit exactly this shape for classes whose static
 * members refer to themselves (marked's Lexer and Parser, esbuild's
 * `class _X`).
 *
 * The rewrite keeps the meaning: the name becomes an ordinary const, which
 * Porffor captures correctly, and `const l = class {}` still names it "l".
 *
 *   class l { ... }  ->  (() => { const l = class { ... }; return l; })()
 *
 * Only named class expressions inside a function whose body refers to the name.
 * Skipped when `extends` or a computed key holds await/yield, which an arrow
 * would change.
 */
const CLASS_SELF_HELPER = String.raw`// sproutboat #256: a named class expression's own name inside a function.
const isFn = (n) => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';

const mentions = (node, name) => {
  if (node == null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((x) => mentions(x, name));
  if (node.type === 'Identifier') return node.name === name;
  for (const key in node) {
    if (key[0] === '_' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    if (mentions(node[key], name)) return true;
  }
  return false;
};

const suspends = (node) => {
  if (node == null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(suspends);
  if (node.type === 'AwaitExpression' || node.type === 'YieldExpression') return true;
  if (isFn(node) || node.type === 'ClassExpression' || node.type === 'ClassDeclaration') return false;
  for (const key in node) {
    if (key[0] === '_' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    if (suspends(node[key])) return true;
  }
  return false;
};

const rewrite = (cls) => {
  const name = cls.id.name;
  const at = { start: cls.start, end: cls.end };
  const id = () => ({ type: 'Identifier', name, ...at });
  return {
    type: 'CallExpression', optional: false, arguments: [], ...at,
    callee: {
      type: 'ArrowFunctionExpression', id: null, params: [], async: false, generator: false, expression: false, ...at,
      body: {
        type: 'BlockStatement', ...at,
        body: [
          { type: 'VariableDeclaration', kind: 'const', ...at, declarations: [
            { type: 'VariableDeclarator', id: id(), init: { ...cls, id: null }, ...at },
          ] },
          { type: 'ReturnStatement', argument: id(), ...at },
        ],
      },
    },
  };
};

const walk = (node, inFn) => {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = walk(node[i], inFn);
    return node;
  }
  const childInFn = inFn || isFn(node);
  for (const key in node) {
    if (key[0] === '_' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    const value = node[key];
    if (value && typeof value === 'object') node[key] = walk(value, childInFn);
  }
  if (
    inFn && node.type === 'ClassExpression' && node.id?.name &&
    mentions(node.body, node.id.name) &&
    !suspends(node.superClass) && !node.body.body.some((m) => m.computed && suspends(m.key))
  ) return rewrite(node);
  return node;
};

export default (ast) => (globalThis.precompile ? ast : walk(ast, false));
`;

/**
 * #15 — and the same for the compile step, so the prelude's inline C can
 * `#include <bearssl.h>`. The link patch alone is not enough: Porffor's
 * module builds compile several C units with a fixed argument list, so there
 * is otherwise no way to add an include path. Add the flag before the cache
 * stamp is computed so a change invalidates compiled units.
 */
const CFLAGS_ANCHOR = "      ...darwinReleaseCompileArgs,\n";
const CFLAGS_INJECT =
  "      ...(process.env.SB_EXTRA_CFLAGS ? process.env.SB_EXTRA_CFLAGS.split(' ').filter(Boolean) : []),\n";
const CFLAGS_MARKER = "SB_EXTRA_CFLAGS";

// baronunread/sproutboat#235: clang's default -ffp-contract=on fuses `a * b + c`
// into one FMA on arm64, rounding once where JavaScript rounds twice. A seeded
// LCG (seed * 1103515245 + 12345, past 2^53) diverged from V8 at step 23.
// Every compiled unit keeps JS's separate roundings with contraction off.
const FP_CONTRACT_ANCHOR = "      '-fno-ident', '-ffunction-sections', '-fdata-sections',\n";
const FP_CONTRACT_INJECT = "      '-ffp-contract=off', // sproutboat #235: JS rounds a * b + c twice\n";
const FP_CONTRACT_MARKER = "sproutboat #235";

// baronunread/sproutboat#236: uWebSockets answers any request line that isn't
// HTTP/1.1 with 505, so a standalone sprout behind nginx's default
// `proxy_http_version 1.0` failed every request. Its HttpRequest already has
// isAncient(), which closes the connection after the response; the parser just
// never sets it. uWebSockets is header-only and lives in Porffor's deps cache,
// not in the Porffor checkout, so a helper written next to compiler/index.js
// edits HttpParser.h right before each native-fetch compile (marker-guarded).
const HTTP10_HELPER = String.raw`// sproutboat #236: accept HTTP/1.0 request lines in uWebSockets.
import fs from 'node:fs';

const MARK = 'sb_http10_request';
const edits = [
  [
    'struct HttpParser {',
    '/* sproutboat #236: set by consumeRequestLine for an HTTP/1.0 request line. */\ninline thread_local bool sb_http10_request = false;\n\nstruct HttpParser {'
  ],
  [
    '/* Scan until single SP, assume next is / (origin request) */\n        char *start = data;',
    '/* Scan until single SP, assume next is / (origin request) */\n        sb_http10_request = false;\n        char *start = data;'
  ],
  [
    'if (memcmp(" HTTP/1.1\\r\\n", data, std::min<unsigned int>(11, (unsigned int) (end - data))) == 0) {\n                            return nullptr;\n                        }',
    'if (memcmp(" HTTP/1.1\\r\\n", data, std::min<unsigned int>(11, (unsigned int) (end - data))) == 0) {\n                            return nullptr;\n                        }\n                        if (memcmp(" HTTP/1.0\\r\\n", data, std::min<unsigned int>(11, (unsigned int) (end - data))) == 0) {\n                            return nullptr;\n                        }'
  ],
  [
    'if (memcmp(" HTTP/1.1\\r\\n", data, 11) == 0) {\n                        return data + 11;\n                    }',
    'if (memcmp(" HTTP/1.1\\r\\n", data, 11) == 0) {\n                        return data + 11;\n                    }\n                    if (memcmp(" HTTP/1.0\\r\\n", data, 11) == 0) {\n                        sb_http10_request = true;\n                        return data + 11;\n                    }'
  ],
  [ 'req->ancientHttp = false;', 'req->ancientHttp = sb_http10_request;' ]
];

export const sbPatchHttp10 = uwsDir => {
  const file = uwsDir + '/src/HttpParser.h';
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes(MARK)) return;
  for (const [ from, to ] of edits) {
    if (!src.includes(from)) throw new Error('sproutboat #236: uWebSockets HttpParser.h changed, anchor not found: ' + from.slice(0, 60));
    src = src.replace(from, to);
  }
  fs.writeFileSync(file, src);
};
`;
const HTTP10_IMPORT_ANCHOR = "import { hashId } from './modules.js';\n";
const HTTP10_IMPORT_INJECT = "import { sbPatchHttp10 } from './sb-http10.js'; // sproutboat #236\n";
const HTTP10_IMPORT_MARKER = "./sb-http10.js";
const HTTP10_CALL_ANCHOR = "      const uwsDir = uwebsockets.ensureUWebSockets();\n";
const HTTP10_CALL_INJECT = "      sbPatchHttp10(uwsDir);\n";
const HTTP10_CALL_MARKER = "sbPatchHttp10(uwsDir)";
// The shim is content-cached, so a header edit alone would never recompile it.
// This line changes the shim once, which rebuilds it against the edited header.
const HTTP10_SHIM_ANCHOR = 'export const makeUWebSocketsShimSource = () => `\n#include "App.h"\n';
const HTTP10_SHIM_INJECT =
  'export const makeUWebSocketsShimSource = () => `\n#include "App.h"\n// sproutboat #236: built against an HttpParser.h that accepts HTTP/1.0\n';
const HTTP10_SHIM_MARKER = "sproutboat #236: built against";

// baronunread/sproutboat#168: Porffor represents null as an object-typed value
// with pointer 0, so __Porffor_promise_resolve's cheap `then` probe treated a
// promise resolving to null as an object and looked `then` up at memory offset
// 0. Once something (Date.prototype.toISOString's scratch writes, in practice)
// left bytes there that hash-match, the probe "found" a then, read null.then,
// and rejected with "Cannot get property of null". Every later async function
// resolving to null then failed, permanently. Only non-null objects can be
// thenables (ECMA-262 Promise Resolve Functions step 8), so exclude null.
const PROMISE_NULL_ANCHOR =
  "  if (Porffor.type(value) == Porffor.TYPES.object) {\n    // cheap prototype-chain probe for 'then'";
const PROMISE_NULL_INJECT =
  "  // sproutboat #168: null is object-typed with pointer 0, never a thenable.\n" +
  "  if (Porffor.type(value) == Porffor.TYPES.object && value != null) {\n    // cheap prototype-chain probe for 'then'";
const PROMISE_NULL_MARKER = "sproutboat #168: null is object-typed";

// baronunread/sproutboat#237: String.prototype.replaceAll grew its result with
// one __Porffor_strcat per match, and each strcat copies everything so far, so
// a 2.7 MB string with many matches took ~22 s (Node: 17 ms). Collect the
// pieces and join once: Array.prototype.join sizes the result up front and
// copies each piece a single time.
const REPLACE_ALL_EDITS = [
  [
    "  let out: any = __Porffor_string_emptyLike(str);\n  let appendIndex: i32 = 0;\n  let searchIndex: i32 = 0;\n  let matched: boolean = false;",
    "  // sproutboat #237: pieces joined once, not a strcat (full copy) per match.\n  const pieces: any[] = Porffor.array.new(0);\n  let appendIndex: i32 = 0;\n  let searchIndex: i32 = 0;\n  let matched: boolean = false;",
  ],
  [
    "    out = __Porffor_strcat(out, __Porffor_string_substringLike(str, appendIndex, matchIndex));\n    out = __Porffor_strcat(out, __Porffor_string_applyReplacer(str, match, matchIndex, replaceValue));",
    "    Porffor.array.fastPush(pieces, __Porffor_string_substringLike(str, appendIndex, matchIndex));\n    Porffor.array.fastPush(pieces, __Porffor_string_applyReplacer(str, match, matchIndex, replaceValue));",
  ],
  [
    "  if (!matched) return str;\n  return __Porffor_strcat(out, __Porffor_string_substringLike(str, appendIndex, thisLen));\n};",
    "  if (!matched) return str;\n  Porffor.array.fastPush(pieces, __Porffor_string_substringLike(str, appendIndex, thisLen));\n  return Porffor.callThis(__Array_prototype_join, pieces, '');\n};",
  ],
] as const;
const REPLACE_ALL_MARKER = "sproutboat #237: pieces joined once";

// baronunread/sproutboat#238: an integer typed-array element store converted
// its value with a saturating f64 -> int Convert, so a negative value stored
// into a Uint32Array became 0 and 4e9 into an Int32Array became 2147483647.
// ECMA-262 (IntegerIndexedElementSet -> ToUint32 / ToInt32 / ToUint16 ...) wraps
// modulo 2^n instead. noble-hashes' SHA-256 stores `x | 0` into a Uint32Array,
// so every negative schedule word was zeroed and the digest came out wrong.
// Route the store through codegen's own modular toUint32 (what bitwise ops use);
// narrower stores keep the low bits, which is exactly the modular result.
const TA_STORE_ANCHOR =
  "      stmt(scope, Store(ctype, addr, 4, ctype === 'f64' || ctype === 'f32' ? f : signed ? Convert(T.i32, f) : Convert(T.u32, f, 0)));";
const TA_STORE_INJECT =
  "      // sproutboat #238: typed-array stores wrap modulo 2^n (ToUint32), not saturate.\n" +
  "      stmt(scope, Store(ctype, addr, 4, ctype === 'f64' || ctype === 'f32' ? f : signed ? Convert(T.i32, toUint32(scope, f), CONVERT_RANGE_KNOWN | CONVERT_SIGNED) : toUint32(scope, f)));";
const TA_STORE_MARKER = "sproutboat #238: typed-array stores wrap";
// baronunread/sproutboat#238: unary `~` had the same saturating conversion, so
// ~x for x >= 2^31 (or ~~x, the common truncation idiom) clamped to
// +/-2147483648, and ~Infinity gave -2147483648 instead of -1. uuid's SHA-1
// computes `x & y ^ ~x & z` on words above 2^31, so every v5 UUID was wrong.
const BITNOT_ANCHOR =
  "      return Box(Convert(T.f64, Un('~', T.i32, Convert(T.i32, numValue(toNumeric())))), Const(T.i32, TYPES.number));";
const BITNOT_INJECT =
  "      // sproutboat #238: ~ applies ToInt32 (wrap modulo 2^32), not a saturating cast.\n" +
  "      return Box(Convert(T.f64, Un('~', T.i32, Convert(T.i32, toUint32(scope, numValue(toNumeric())), CONVERT_RANGE_KNOWN | CONVERT_SIGNED))), Const(T.i32, TYPES.number));";
const BITNOT_MARKER = "sproutboat #238: ~ applies ToInt32";
// baronunread/sproutboat#238: typed-array element reads and writes had no
// bounds check. A read past the end returned whatever sat in the next
// allocation instead of undefined (uuid's SHA-1 reads past its buffer, so v5
// UUIDs changed run to run) and a[-1] / a[1.5] broke outright. Reuse the
// plain-array index check and compare against the typed array's length.
// Builtins keep the unchecked read: they index within bounds, and the check
// broke typed-array join/toString when compiled into them. Writes need the same
// guard, but builtins such as the constructor and fill() store elements before
// they set the length, so that is left for a follow-up.
const TA_GET_ANCHOR =
  "  const taGet = (ctype, size, signed = true) => () => {\n" +
  "    const loaded = Load(ctype, taAddr(size), 4);\n" +
  "    const f = ctype === 'f32' || ctype === 'f64' ? loaded : Convert(T.f64, loaded, signed ? CONVERT_SIGNED : 0);\n" +
  "    return Box(f, Const(T.i32, TYPES.number));\n" +
  "  };";
const TA_GET_INJECT =
  "  const taGet = (ctype, size, signed = true) => () => {\n" +
  "    // sproutboat #238: only a valid in-range integer index reads; anything else is undefined.\n" +
  "    // User code only: builtins (precompiled) index within bounds themselves and\n" +
  "    // typed-array join/toString misbehave with the extra check.\n" +
  "    if (globalThis.precompile) {\n" +
  "      const raw = Load(ctype, taAddr(size), 4);\n" +
  "      return Box(ctype === 'f32' || ctype === 'f64' ? raw : Convert(T.f64, raw, signed ? CONVERT_SIGNED : 0), Const(T.i32, TYPES.number));\n" +
  "    }\n" +
  "    const { idx, valid } = denseArrayIndexKey(scope, prop);\n" +
  "    const loaded = Load(ctype, Bin('+', T.u32, Load('u32', JvPtr(obj), 4), size === 1 ? idx : Bin('*', T.u32, idx, Const(T.u32, size))), 4);\n" +
  "    const f = ctype === 'f32' || ctype === 'f64' ? loaded : Convert(T.f64, loaded, signed ? CONVERT_SIGNED : 0);\n" +
  "    return Select(Bin('&&', T.i32, valid, Bin('<', T.i32, idx, Load('u32', JvPtr(obj), 0))),\n" +
  "      Box(f, Const(T.i32, TYPES.number)), valUndefined());\n" +
  "  };";
const TA_GET_MARKER = "sproutboat #238: only a valid in-range integer index reads";
// baronunread/sproutboat#241: a typed-array write outside the array stored into
// whatever memory followed it (and a[-1] = x wrote a[0], via the saturating
// index conversion). ECMA-262 ignores the write. Same check as taGet, in user
// code only: builtins such as the constructor store elements before they set
// the length, and they only write in bounds anyway. Applies after TA_STORE,
// whose output line is the anchor.
const TA_SET_BOUNDS_ANCHOR =
  "      stmt(scope, Store(ctype, addr, 4, ctype === 'f64' || ctype === 'f32' ? f : signed ? Convert(T.i32, toUint32(scope, f), CONVERT_RANGE_KNOWN | CONVERT_SIGNED) : toUint32(scope, f)));";
const TA_SET_BOUNDS_INJECT =
  "      const store = () => stmt(scope, Store(ctype, addr, 4, ctype === 'f64' || ctype === 'f32' ? f : signed ? Convert(T.i32, toUint32(scope, f), CONVERT_RANGE_KNOWN | CONVERT_SIGNED) : toUint32(scope, f)));\n" +
  "      // sproutboat #241: a write outside the array is ignored, not stored into the next allocation.\n" +
  "      if (globalThis.precompile) store();\n" +
  "      else {\n" +
  "        const { idx: sbIdx, valid: sbValid } = denseArrayIndexKey(scope, prop);\n" +
  "        emitIf(scope, Bin('&&', T.i32, sbValid, Bin('<', T.i32, sbIdx, Load('u32', JvPtr(obj), 0))), store);\n" +
  "      }";
const TA_SET_BOUNDS_MARKER = "sproutboat #241: a write outside the array is ignored";

// baronunread/sproutboat#238: TypedArray.prototype.set(source) with no offset
// ran `offset = Math.trunc(undefined)`, which is NaN. The same-type fast path
// then copied to `base + NaN * BYTES_PER_ELEMENT`: nothing landed where it
// should (noble's HMAC lost its key in `pad.set(key)`), and the write went
// somewhere else in memory. ECMA-262 uses ToIntegerOrInfinity, which maps
// undefined and NaN to 0; subarray right below already does.
const TA_SET_OFFSET_ANCHOR = "  offset = Math.trunc(offset);\n  if (Porffor.fastOr(offset < 0, offset > len)) throw new RangeError('Offset out of bounds');";
const TA_SET_OFFSET_INJECT =
  "  offset = ecma262.ToIntegerOrInfinity(offset); // sproutboat #238: undefined offset is 0, not NaN\n  if (Porffor.fastOr(offset < 0, offset > len)) throw new RangeError('Offset out of bounds');";
const TA_SET_OFFSET_MARKER = "sproutboat #238: undefined offset is 0";

// baronunread/sproutboat#242: typedarray.js generates each TypedArray method
// from array.ts with `.replaceAll('any[]', name)`. That also retyped join's and
// toString's internal `const parts: any[]` helper as e.g. a Uint8Array, so the
// joined strings were stored into a "typed array": Uint8Array join returned
// garbage and Uint16Array join crashed. Put `parts` back to a plain array after
// the replacement; map/filter's intentionally typed `out` is untouched.
const TA_JOIN_ANCHOR = ".replaceAll('Array', name).replaceAll('any[]', name) + '\\n\\n'";
const TA_JOIN_INJECT =
  ".replaceAll('Array', name).replaceAll('any[]', name).replaceAll('const parts: ' + name + ' =', 'const parts: any[] =') /* sproutboat #242 */ + '\\n\\n'";
const TA_JOIN_MARKER = "sproutboat #242";

// Porffor's TypedArray.from only handles iterables. An array-like input such
// as { length: 16 } silently becomes an empty typed array, including HMAC
// keys made with Uint8Array.from({ length: 16 }, mapFn). The compiler uses a
// precompiled builtin table, so the edited source must be precompiled again.
const TYPED_ARRAY_FROM_ANCHOR =
  "    len = i;\n  }\n\n  arr.length = len;\n\n  return new ${name}(arr);\n};";
const TYPED_ARRAY_FROM_INJECT =
  "    len = i;\n" +
  "  } else {\n" +
  "    // sproutboat: TypedArray.from accepts array-like objects.\n" +
  "    let count = ecma262.ToIntegerOrInfinity(Porffor.object.get(arg, 'length'));\n" +
  "    if (count < 0) count = 0;\n" +
  "    if (count > 2147483643) throw new RangeError('Invalid TypedArray length (over maximum supported length)');\n" +
  "    if (Porffor.type(mapFn) != Porffor.TYPES.undefined && Porffor.type(mapFn) != Porffor.TYPES.function)\n" +
  "      throw new TypeError('Called TypedArray.from with a non-function mapFn');\n" +
  "    for (let i: i32 = 0; i < count; i++) {\n" +
  "      arr[i] = Porffor.type(mapFn) == Porffor.TYPES.undefined ? arg[i] : mapFn(arg[i], i);\n" +
  "    }\n" +
  "    len = count;\n" +
  "  }\n\n  arr.length = len;\n\n  return new ${name}(arr);\n};";
const TYPED_ARRAY_FROM_MARKER = "sproutboat: TypedArray.from accepts array-like objects";

// Porffor alpha 9 treats +02:00 as two milliseconds and adds offset hours
// instead of subtracting them. Count fields even when they contain zero, and
// apply the signed offset after parsing the local wall-clock fields.
const DATE_PARSER_MARKER = "sproutboat: ISO timezone offset";
const DATE_PARSER_ANCHOR = `  let n: number = 0;
  let nInd: number = 0;

  const len: i32 = string.length;
  const endPtr: i32 = Porffor.IR.ptr(string) + len;
  let ptr: i32 = Porffor.IR.ptr(string);

  while (ptr <= endPtr) { // <= to include extra null byte to set last n
    const chr: i32 = Porffor.IR.loadU8(ptr++, 4);
    if (Porffor.fastAnd(chr >= 48, chr <= 57)) { // 0-9
      n *= 10;
      n += chr - 48;
      continue;
    }

    if (chr == 45) { // -
      if (Porffor.fastOr(ptr == Porffor.IR.ptr(string), nInd == 7)) n = -n;
    }

    if (n > 0) {
      if (nInd == 0) y = n;
        else if (nInd == 1) m = n - 1;
        else if (nInd == 2) dt = n;
        else if (nInd == 3) h = n;
        else if (nInd == 4) min = n;
        else if (nInd == 5) s = n;
        else if (nInd == 6) milli = n;
        else if (nInd == 7) tzHour = n;
        else if (nInd == 8) tzMin = n;

      n = 0;
      nInd++;
    }
  }

  h += tzHour;
  min += tzMin;`;
const DATE_PARSER_INJECT = `  // sproutboat: ISO timezone offset
  let n: number = 0;
  let nInd: number = 0;
  let digits: i32 = 0;
  let offsetSign: i32 = 0;

  const len: i32 = string.length;
  const endPtr: i32 = Porffor.IR.ptr(string) + len;
  let ptr: i32 = Porffor.IR.ptr(string);

  while (ptr <= endPtr) {
    const chr: i32 = Porffor.IR.loadU8(ptr++, 4);
    if (Porffor.fastAnd(chr >= 48, chr <= 57)) {
      n = n * 10 + chr - 48;
      digits++;
      continue;
    }

    if (digits > 0) {
      if (nInd == 0) y = n;
        else if (nInd == 1) m = n - 1;
        else if (nInd == 2) dt = n;
        else if (nInd == 3) h = n;
        else if (nInd == 4) min = n;
        else if (nInd == 5) s = n;
        else if (nInd == 6) {
          while (digits < 3) { n *= 10; digits++; }
          while (digits > 3) { n = Math.trunc(n / 10); digits--; }
          milli = n;
        }
        else if (nInd == 7) tzHour = n;
        else if (nInd == 8) tzMin = n;
      n = 0;
      nInd++;
      digits = 0;
    }

    if (Porffor.fastOr(chr == 43, chr == 45) && nInd >= 6) {
      offsetSign = chr == 43 ? 1 : -1;
      nInd = 7;
    }
  }

  h -= offsetSign * tzHour;
  min -= offsetSign * tzMin;`;

/**
 * #56 — make the inbound request-body limit configurable.
 *
 * Porffor's uWebSockets shim hardcodes 1 MiB and answers anything larger with a
 * bare `413 request body too large` before the handler runs, so a project can
 * neither accept a bigger upload nor say anything useful about the refusal.
 *
 * The default stays 1 MiB: a larger body is held in memory whole, so raising it
 * is a decision about this deployment's memory, not something to inherit.
 */
const BODY_ANCHOR = "static const size_t REQUEST_BODY_MAX_BYTES = 1024u * 1024u;";
const BODY_INJECT = `static size_t sb_request_body_max(void) {
  static size_t cached = 0;
  if (cached == 0) {
    const char* raw = getenv("SB_REQUEST_BODY_MAX");
    long parsed = raw && *raw ? atol(raw) : 0;
    cached = parsed > 0 ? (size_t)parsed : 1024u * 1024u;
  }
  return cached;
}
#define REQUEST_BODY_MAX_BYTES sb_request_body_max()`;
const BODY_MARKER = "sb_request_body_max";

/**
 * baronunread/sproutboat#156 — `lookup_status_line()` maps a status code to a
 * reason string for `res->writeStatus()`, and any code missing from its switch
 * (303, 206, 300, 305, 402, 451, ...) falls to `default: return {}` — an empty
 * status line, which uWS emits as a malformed response and the client sees as a
 * connection reset. Only the embedded/standalone path hits this; the broker
 * serializes its own status line.
 *
 * Rather than chase the IANA registry case by case, synthesize a valid line for
 * anything unlisted from the number itself (return type widens to `std::string`;
 * the sole caller feeds it straight to `writeStatus`, which copies synchronously).
 * Known codes keep their proper reason phrase.
 */
const STATUS_SIG_ANCHOR = "static std::string_view lookup_status_line(i32 status) {";
const STATUS_SIG_INJECT = "static std::string lookup_status_line(i32 status) {";
const STATUS_SIG_MARKER = "static std::string lookup_status_line(i32 status) {";
// 303 is the one this was reported for (POST-redirect-GET); give it the real
// reason phrase. Everything else unlisted rides the synthesized fallback below.
const STATUS_303_ANCHOR = '    case 302: return "302 Found";\n';
const STATUS_303_INJECT =
  '    case 302: return "302 Found";\n    case 303: return "303 See Other";\n';
const STATUS_303_MARKER = 'case 303: return "303 See Other";';
const STATUS_DEFAULT_ANCHOR = "    default: return {};";
const STATUS_DEFAULT_INJECT = '    default: return std::to_string(status) + " Status";';
const STATUS_DEFAULT_MARKER = 'std::to_string(status) + " Status"';

/**
 * baronunread/sproutboat#163 — a native-fetch handler has no way to see the
 * connection's remote address, so standalone apps hand-roll `X-Forwarded-For`
 * parsing with a spoofable boolean flag. Nothing but C on the socket side can
 * reach the peer, so `collect_headers` (the one place request headers cross into
 * JS) grows a `res` argument and appends `x-sb-remote-addr:
 * <res->getRemoteAddressAsText()>`. Any client-sent header of that name is
 * dropped first — it is reserved, the server owns it. The prelude reads it into
 * `request.cf.clientIp` and resolves it against `SB_TRUSTED_PROXIES` if set.
 */
const HDR_SIG_ANCHOR = "static i32 collect_headers(uWS::HttpRequest* req) {\n";
const HDR_SIG_INJECT =
  "static i32 collect_headers(uWS::HttpRequest* req, uWS::HttpResponse<false>* res) {\n";
const HDR_SIG_MARKER = "collect_headers(uWS::HttpRequest* req, uWS::HttpResponse";

const HDR_CALL_ANCHOR = "const i32 headers_ptr = collect_headers(req);";
const HDR_CALL_INJECT = "const i32 headers_ptr = collect_headers(req, res);";
const HDR_CALL_MARKER = "collect_headers(req, res)";

const HDR_CAP_ANCHOR = "  const i32 header_bytes = 16 + header_capacity * 8;\n";
const HDR_CAP_INJECT =
  "  header_capacity += 2; // sproutboat #163: room for the x-sb-remote-addr entry\n" +
  "  const i32 header_bytes = 16 + header_capacity * 8;\n";
const HDR_CAP_MARKER = "sproutboat #163";

const HDR_SKIP_ANCHOR = "  i32 slot = 0;\n  for (auto [key, value] : *req) {\n";
const HDR_SKIP_INJECT =
  "  i32 slot = 0;\n  for (auto [key, value] : *req) {\n" +
  '    if (key == "x-sb-remote-addr") continue; // #163: reserved, the server sets it below\n';
const HDR_SKIP_MARKER = 'key == "x-sb-remote-addr"';

const HDR_APPEND_ANCHOR = "  *((i32*)(porf_mem + headers_ptr)) = slot;\n\n  return headers_ptr;";
const HDR_APPEND_INJECT =
  "  {\n" +
  "    const std::string_view __sb_peer = res ? res->getRemoteAddressAsText() : std::string_view();\n" +
  '    *((u64*)(porf_mem + entries_ptr + slot * 8)) = pack_bytestring((i32)porf_native_fetch_alloc_bytestring("x-sb-remote-addr", 16));\n' +
  "    slot++;\n" +
  "    *((u64*)(porf_mem + entries_ptr + slot * 8)) = pack_bytestring((i32)porf_native_fetch_alloc_bytestring(__sb_peer.data(), __sb_peer.size()));\n" +
  "    slot++;\n" +
  "  }\n" +
  "  *((i32*)(porf_mem + headers_ptr)) = slot;\n\n  return headers_ptr;";
const HDR_APPEND_MARKER = "__sb_peer";

/**
 * baronunread/sproutboat#176 — the uwebsockets.js half of the raw-bytestring
 * fix: a forward declaration for render.js's new
 * `porf_native_fetch_read_raw_bytes`, `write_response_value` scanning for a
 * reserved `x-sb-raw-body` response header before the body read and calling
 * that function instead of `porf_native_fetch_read_value` when it's present
 * (header reads are untouched — a header name or value is always real
 * text), and `is_forbidden_response_header` dropping that header from what
 * actually reaches the client — same reserved-header pattern as #163's
 * `x-sb-remote-addr`, just response-side and sproutboat-to-C instead of
 * C-to-sproutboat.
 */
const READ_RAW_DECL_ANCHOR =
  "int porf_native_fetch_read_value(struct jsval value, const char** out_buf, size_t* out_len, char** out_owned);";
const READ_RAW_DECL_INJECT =
  "int porf_native_fetch_read_value(struct jsval value, const char** out_buf, size_t* out_len, char** out_owned);\n" +
  "int porf_native_fetch_read_raw_bytes(struct jsval value, const char** out_buf, size_t* out_len);";
const READ_RAW_DECL_MARKER = "porf_native_fetch_read_raw_bytes(struct jsval value";

const FORBIDDEN_HDR_ANCHOR =
  "static bool is_forbidden_response_header(std::string_view key) {\n" +
  '  return key == "connection" ||\n' +
  '         key == "content-length" ||\n' +
  '         key == "transfer-encoding";\n' +
  "}";
const FORBIDDEN_HDR_INJECT =
  "static bool is_forbidden_response_header(std::string_view key) {\n" +
  '  return key == "connection" ||\n' +
  '         key == "content-length" ||\n' +
  '         key == "transfer-encoding" ||\n' +
  '         key == "x-sb-raw-body"; // sproutboat #176: internal signal, never sent\n' +
  "}";
const FORBIDDEN_HDR_MARKER = 'key == "x-sb-raw-body"';

const WRITE_RESPONSE_ANCHOR =
  "static void write_response_value(uWS::HttpResponse<false>* res, struct jsval response, bool* aborted) {\n" +
  "  struct NativeFetchResponseParts response_parts;\n" +
  "  porf_native_fetch_finalize_response(response.val, response.type, &response_parts);\n" +
  "  const i32 status = response_parts.status;\n" +
  "  const struct jsval body_value = response_parts.body;\n" +
  "  const i32 headers_entries_ptr = (i32)response_parts.headers.val;\n" +
  "\n" +
  "  const char* body_buf = nullptr;\n" +
  "  size_t body_len = 0;\n" +
  "  char* body_owned = nullptr;\n" +
  "  porf_native_fetch_read_value(body_value, &body_buf, &body_len, &body_owned);\n" +
  "\n" +
  "  if (!aborted || !*aborted) {\n" +
  "    res->cork([res, status, headers_entries_ptr, body_buf, body_len]() {\n" +
  "      if (status != 200) res->writeStatus(lookup_status_line(status));\n" +
  "\n" +
  "      const i32 headers_len = *((i32*)(porf_mem + headers_entries_ptr)) / 2;\n" +
  "      const i32 headers_entries = *((i32*)(porf_mem + headers_entries_ptr + 4));\n" +
  "      for (i32 i = 0; i < headers_len; i++) {\n" +
  "        const i32 name_base = headers_entries + i * 16;\n" +
  "        const i32 value_base = name_base + 8;\n" +
  "        const struct jsval name_value = unpack_jsval(*((u64*)(porf_mem + name_base)));\n" +
  "        const struct jsval value_value = unpack_jsval(*((u64*)(porf_mem + value_base)));\n" +
  "\n" +
  "        const char* name_buf = nullptr;\n" +
  "        size_t name_len = 0;\n" +
  "        char* name_owned = nullptr;\n" +
  "        const char* value_buf = nullptr;\n" +
  "        size_t value_len = 0;\n" +
  "        char* value_owned = nullptr;\n" +
  "        porf_native_fetch_read_value(name_value, &name_buf, &name_len, &name_owned);\n" +
  "        porf_native_fetch_read_value(value_value, &value_buf, &value_len, &value_owned);\n" +
  "\n" +
  "        const std::string_view key(name_buf, name_len);\n" +
  "        if (!is_forbidden_response_header(key)) {\n" +
  "          res->writeHeader(key, std::string_view(value_buf, value_len));\n" +
  "        }\n" +
  "\n" +
  "        if (name_owned) free(name_owned);\n" +
  "        if (value_owned) free(value_owned);\n" +
  "      }\n" +
  "\n" +
  "      res->end(std::string_view(body_buf, body_len));\n" +
  "    });\n" +
  "  }\n" +
  "\n" +
  "  if (body_owned) free(body_owned);\n" +
  "}";
const WRITE_RESPONSE_INJECT =
  "static void write_response_value(uWS::HttpResponse<false>* res, struct jsval response, bool* aborted) {\n" +
  "  struct NativeFetchResponseParts response_parts;\n" +
  "  porf_native_fetch_finalize_response(response.val, response.type, &response_parts);\n" +
  "  const i32 status = response_parts.status;\n" +
  "  const struct jsval body_value = response_parts.body;\n" +
  "  const i32 headers_entries_ptr = (i32)response_parts.headers.val;\n" +
  "\n" +
  "  // sproutboat #176: a reserved x-sb-raw-body header (set by the prelude's\n" +
  "  // assets binding) means the body is already-finished bytes, not a string\n" +
  "  // to UTF-8 encode -- scanned before the body read so it can steer that one\n" +
  "  // call onto porf_native_fetch_read_raw_bytes instead.\n" +
  "  bool raw_body = false;\n" +
  "  {\n" +
  "    const i32 scan_len = *((i32*)(porf_mem + headers_entries_ptr)) / 2;\n" +
  "    const i32 scan_entries = *((i32*)(porf_mem + headers_entries_ptr + 4));\n" +
  "    for (i32 i = 0; i < scan_len && !raw_body; i++) {\n" +
  "      const struct jsval scan_name = unpack_jsval(*((u64*)(porf_mem + scan_entries + i * 16)));\n" +
  "      const char* scan_buf = nullptr;\n" +
  "      size_t scan_bytes = 0;\n" +
  "      char* scan_owned = nullptr;\n" +
  "      porf_native_fetch_read_value(scan_name, &scan_buf, &scan_bytes, &scan_owned);\n" +
  '      if (std::string_view(scan_buf, scan_bytes) == "x-sb-raw-body") raw_body = true;\n' +
  "      if (scan_owned) free(scan_owned);\n" +
  "    }\n" +
  "  }\n" +
  "\n" +
  "  const char* body_buf = nullptr;\n" +
  "  size_t body_len = 0;\n" +
  "  char* body_owned = nullptr;\n" +
  "  if (raw_body) porf_native_fetch_read_raw_bytes(body_value, &body_buf, &body_len);\n" +
  "  else porf_native_fetch_read_value(body_value, &body_buf, &body_len, &body_owned);\n" +
  "\n" +
  "  if (!aborted || !*aborted) {\n" +
  "    res->cork([res, status, headers_entries_ptr, body_buf, body_len]() {\n" +
  "      if (status != 200) res->writeStatus(lookup_status_line(status));\n" +
  "\n" +
  "      const i32 headers_len = *((i32*)(porf_mem + headers_entries_ptr)) / 2;\n" +
  "      const i32 headers_entries = *((i32*)(porf_mem + headers_entries_ptr + 4));\n" +
  "      for (i32 i = 0; i < headers_len; i++) {\n" +
  "        const i32 name_base = headers_entries + i * 16;\n" +
  "        const i32 value_base = name_base + 8;\n" +
  "        const struct jsval name_value = unpack_jsval(*((u64*)(porf_mem + name_base)));\n" +
  "        const struct jsval value_value = unpack_jsval(*((u64*)(porf_mem + value_base)));\n" +
  "\n" +
  "        const char* name_buf = nullptr;\n" +
  "        size_t name_len = 0;\n" +
  "        char* name_owned = nullptr;\n" +
  "        const char* value_buf = nullptr;\n" +
  "        size_t value_len = 0;\n" +
  "        char* value_owned = nullptr;\n" +
  "        porf_native_fetch_read_value(name_value, &name_buf, &name_len, &name_owned);\n" +
  "        porf_native_fetch_read_value(value_value, &value_buf, &value_len, &value_owned);\n" +
  "\n" +
  "        const std::string_view key(name_buf, name_len);\n" +
  "        if (!is_forbidden_response_header(key)) {\n" +
  "          res->writeHeader(key, std::string_view(value_buf, value_len));\n" +
  "        }\n" +
  "\n" +
  "        if (name_owned) free(name_owned);\n" +
  "        if (value_owned) free(value_owned);\n" +
  "      }\n" +
  "\n" +
  "      res->end(std::string_view(body_buf, body_len));\n" +
  "    });\n" +
  "  }\n" +
  "\n" +
  "  if (body_owned) free(body_owned);\n" +
  "}";
const WRITE_RESPONSE_MARKER = "porf_native_fetch_read_raw_bytes(body_value";

// #195: reserve a direct-transfer ticket before native-fetch allocates the
// ordinary in-memory PendingRequest. uWS then gives each wire chunk directly
// to the runtime C ABI, which owns the temporary object file.
const R2_TRANSFER_ANCHOR = "static void on_request(uWS::HttpResponse<false>* res, uWS::HttpRequest* req) {\n";
const R2_TRANSFER_INJECT = `extern "C" {
  struct sb_r2_transfer_ctx;
  int sb_r2_transfer_open(const char*, const char*, size_t, sb_r2_transfer_ctx**);
  int sb_r2_transfer_write(sb_r2_transfer_ctx*, const char*, size_t);
  int sb_r2_transfer_finish(sb_r2_transfer_ctx*);
  void sb_r2_transfer_abort(sb_r2_transfer_ctx*);
  int sb_r2_transfer_download_open(const char*, const char*, sb_r2_transfer_ctx**);
  size_t sb_r2_transfer_download_size(sb_r2_transfer_ctx*);
  const char* sb_r2_transfer_download_etag(sb_r2_transfer_ctx*);
  size_t sb_r2_transfer_download_read(sb_r2_transfer_ctx*, size_t, char*, size_t);
  void sb_r2_transfer_download_close(sb_r2_transfer_ctx*);
}
static bool sb_r2_transfer_path(std::string_view path, std::string* bucket, std::string* token) {
  static constexpr std::string_view prefix = "/__sb/r2/transfer/";
  if (path.size() < prefix.size() || path.substr(0, prefix.size()) != prefix) return false;
  const std::string_view rest = path.substr(prefix.size());
  const size_t slash = rest.find('/');
  if (slash == std::string_view::npos || slash == 0 || slash > 255 || rest.find('/', slash + 1) != std::string_view::npos) return false;
  const std::string_view b = rest.substr(0, slash), t = rest.substr(slash + 1);
  if (t.size() != 24) return false;
  for (char c : b) if (!((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_')) return false;
  for (char c : t) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  *bucket = std::string(b); *token = std::string(t); return true;
}
static std::string sb_r2_transfer_status(int status) {
  switch (status) {
    case 201: return "201 Created"; case 404: return "404 Not Found"; case 410: return "410 Gone";
    case 413: return "413 Payload Too Large"; case 422: return "422 Unprocessable Content";
    case 503: return "503 Service Unavailable"; case 507: return "507 Insufficient Storage";
    default: return "500 Internal Server Error";
  }
}
static bool try_handle_r2_transfer(uWS::HttpResponse<false>* res, uWS::HttpRequest* req, std::string_view method) {
  std::string bucket, token;
  if (!sb_r2_transfer_path(req->getUrl(), &bucket, &token)) return false;
  // sb_r2_transfer_download_v1
  // sb_r2_transfer_range_v1
  // sb_r2_transfer_range_header_v2
  // sb_r2_transfer_conditional_v1
  // sb_r2_transfer_streaming_v2
  if (method == "GET") {
    sb_r2_transfer_ctx* download = nullptr;
    const int open_status = sb_r2_transfer_download_open(bucket.c_str(), token.c_str(), &download);
    if (open_status != 0 || !download) { respond_with_error(res, sb_r2_transfer_status(open_status), "R2 transfer unavailable", true); return true; }
    const std::string etag = sb_r2_transfer_download_etag(download);
    const std::string_view if_none_match = req->getHeader("if-none-match");
    if (if_none_match == "*" || if_none_match == etag || (if_none_match.size() == etag.size() + 2 && if_none_match.front() == '"' && if_none_match.back() == '"' && if_none_match.substr(1, etag.size()) == etag)) {
      sb_r2_transfer_download_close(download); res->writeStatus("304 Not Modified"); res->writeHeader("ETag", etag); res->end(); return true;
    }
    const uintmax_t full_size = sb_r2_transfer_download_size(download);
    uintmax_t first = 0, last = full_size ? full_size - 1 : 0;
    std::string_view range = req->getHeader("range"); if (range.empty()) range = req->getHeader("Range");
    if (!range.empty()) {
      if (range.substr(0, 6) != "bytes=") { sb_r2_transfer_download_close(download); respond_with_error(res, "416 Range Not Satisfiable", "invalid range", true); return true; }
      const std::string_view spec = range.substr(6); const size_t dash = spec.find('-');
      if (dash == std::string_view::npos || dash == 0) { sb_r2_transfer_download_close(download); respond_with_error(res, "416 Range Not Satisfiable", "invalid range", true); return true; }
      first = 0; for (char c : spec.substr(0, dash)) { if (c < '0' || c > '9') { sb_r2_transfer_download_close(download); respond_with_error(res, "416 Range Not Satisfiable", "invalid range", true); return true; } first = first * 10 + (c - '0'); }
      if (dash + 1 < spec.size()) { last = 0; for (char c : spec.substr(dash + 1)) { if (c < '0' || c > '9') { sb_r2_transfer_download_close(download); respond_with_error(res, "416 Range Not Satisfiable", "invalid range", true); return true; } last = last * 10 + (c - '0'); } }
      if (first >= full_size || last < first) { sb_r2_transfer_download_close(download); respond_with_error(res, "416 Range Not Satisfiable", "range outside object", true); return true; }
      if (last >= full_size) last = full_size - 1;
      char content_range[96]; snprintf(content_range, sizeof(content_range), "bytes %llu-%llu/%llu", (unsigned long long)first, (unsigned long long)last, (unsigned long long)full_size);
      res->writeStatus("206 Partial Content"); res->writeHeader("Content-Range", content_range);
    }
    res->writeHeader("ETag", etag); res->writeHeader("Accept-Ranges", "bytes");
    struct Download { sb_r2_transfer_ctx* ctx; uintmax_t base; uintmax_t size; uintmax_t sent = 0; bool closed = false; char chunk[65536]; };
    auto state = std::make_shared<Download>(Download{download, first, last - first + 1});
    auto pump = std::make_shared<std::function<bool()>>();
    *pump = [res, state, pump]() {
      if (state->closed) return false;
      for (;;) {
        const size_t want = state->size - state->sent < sizeof(state->chunk) ? (size_t)(state->size - state->sent) : sizeof(state->chunk);
        const size_t bytes = sb_r2_transfer_download_read(state->ctx, (size_t)(state->base + state->sent), state->chunk, want);
        const auto result = res->tryEnd(std::string_view(state->chunk, bytes), state->size);
        if (result.second || bytes == 0) { sb_r2_transfer_download_close(state->ctx); state->closed = true; return false; }
        if (!result.first) {
          res->onWritable([res, state](uintmax_t offset) {
            if (state->closed) return true;
            const size_t want = state->size - offset < sizeof(state->chunk) ? (size_t)(state->size - offset) : sizeof(state->chunk);
            const size_t bytes = sb_r2_transfer_download_read(state->ctx, (size_t)(state->base + offset), state->chunk, want);
            const auto resumed = res->tryEnd(std::string_view(state->chunk, bytes), state->size);
            if (resumed.second || bytes == 0) { sb_r2_transfer_download_close(state->ctx); state->closed = true; return true; }
            return resumed.first;
          });
          return false;
        }
        state->sent += bytes;
        if (state->sent == state->size) { sb_r2_transfer_download_close(state->ctx); state->closed = true; return false; }
      }
    };
    res->writeHeader("Content-Type", "application/octet-stream");
    res->onAborted([state]() { if (!state->closed) { sb_r2_transfer_download_close(state->ctx); state->closed = true; } });
    (*pump)();
    return true;
  }
  if (method != "PUT") { respond_with_error(res, "405 Method Not Allowed", "R2 transfer requires GET or PUT", true); return true; }
  size_t declared = 0;
  const std::string_view content_length = req->getHeader("content-length");
  if (!content_length.empty() && !parse_content_length(content_length, &declared)) { respond_with_error(res, "400 Bad Request", "invalid content-length", true); return true; }
  sb_r2_transfer_ctx* opened = nullptr;
  const int open_status = sb_r2_transfer_open(bucket.c_str(), token.c_str(), declared, &opened);
  if (open_status != 0 || !opened) { respond_with_error(res, sb_r2_transfer_status(open_status), "R2 transfer unavailable", true); return true; }
  auto ctx = std::make_shared<sb_r2_transfer_ctx*>(opened);
  res->onAborted([ctx]() { if (*ctx) { sb_r2_transfer_abort(*ctx); *ctx = nullptr; } });
  res->onData([res, ctx](std::string_view chunk, bool is_last) {
    if (!*ctx) return;
    const int write_status = sb_r2_transfer_write(*ctx, chunk.data(), chunk.size());
    if (write_status != 0) { sb_r2_transfer_abort(*ctx); *ctx = nullptr; respond_with_error(res, sb_r2_transfer_status(write_status), "R2 transfer failed", true); return; }
    if (is_last) {
      const int finish_status = sb_r2_transfer_finish(*ctx); *ctx = nullptr;
      if (finish_status == 201) { res->writeStatus("201 Created"); res->end(); }
      else respond_with_error(res, sb_r2_transfer_status(finish_status), "R2 transfer failed", true);
    }
  });
  return true;
}
static void on_request(uWS::HttpResponse<false>* res, uWS::HttpRequest* req) {
`;
const R2_TRANSFER_MARKER = "sb_r2_transfer_path(std::string_view path";
const R2_TRANSFER_CALL_ANCHOR = "  __porffor_js_enter();\n  const i32 url_ptr = alloc_request_url(req);";
const R2_TRANSFER_CALL_INJECT =
  "  if (try_handle_r2_transfer(res, req, method)) return;\n" + R2_TRANSFER_CALL_ANCHOR;
const R2_TRANSFER_CALL_MARKER = "try_handle_r2_transfer(res, req, method)";
const R2_DOWNLOAD_CACHE_MARKER = "sb_r2_transfer_download_v1";
const R2_RANGE_CACHE_MARKER = "sb_r2_transfer_range_v1";
const R2_CONDITIONAL_CACHE_MARKER = "sb_r2_transfer_conditional_v1";
const R2_STREAMING_CACHE_MARKER = "sb_r2_transfer_streaming_v2";
const R2_RANGE_HEADER_CACHE_MARKER = "sb_r2_transfer_range_header_v2";
const R2_DOWNLOAD_DECL_ANCHOR = "  void sb_r2_transfer_abort(sb_r2_transfer_ctx*);\n}";
const R2_DOWNLOAD_DECL_INJECT =
  "  void sb_r2_transfer_abort(sb_r2_transfer_ctx*);\n" +
  "  int sb_r2_transfer_download_open(const char*, const char*, sb_r2_transfer_ctx**);\n" +
  "  size_t sb_r2_transfer_download_size(sb_r2_transfer_ctx*);\n" +
  "  const char* sb_r2_transfer_download_etag(sb_r2_transfer_ctx*);\n" +
  "  size_t sb_r2_transfer_download_read(sb_r2_transfer_ctx*, size_t, char*, size_t);\n" +
  "  void sb_r2_transfer_download_close(sb_r2_transfer_ctx*);\n}";
const R2_DOWNLOAD_BRANCH_ANCHOR = '  if (method != "PUT") { respond_with_error(res, "405 Method Not Allowed", "R2 transfer requires PUT", true); return true; }';
const R2_DOWNLOAD_BRANCH_INJECT = `  // sb_r2_transfer_download_v1
  // sb_r2_transfer_range_v1
  // sb_r2_transfer_range_header_v2
  // sb_r2_transfer_conditional_v1
  // sb_r2_transfer_streaming_v2
  if (method == "GET") {
    sb_r2_transfer_ctx* download = nullptr;
    const int status = sb_r2_transfer_download_open(bucket.c_str(), token.c_str(), &download);
    if (status != 0 || !download) { respond_with_error(res, sb_r2_transfer_status(status), "R2 transfer unavailable", true); return true; }
    const std::string etag = sb_r2_transfer_download_etag(download);
    const std::string_view if_none_match = req->getHeader("if-none-match");
    if (if_none_match == "*" || if_none_match == etag || (if_none_match.size() == etag.size() + 2 && if_none_match.front() == '"' && if_none_match.back() == '"' && if_none_match.substr(1, etag.size()) == etag)) {
      sb_r2_transfer_download_close(download); res->writeStatus("304 Not Modified"); res->writeHeader("ETag", etag); res->end(); return true;
    }
    const uintmax_t full_size = sb_r2_transfer_download_size(download);
    uintmax_t first = 0, last = full_size ? full_size - 1 : 0;
    std::string_view range = req->getHeader("range"); if (range.empty()) range = req->getHeader("Range");
    if (!range.empty()) {
      if (range.substr(0, 6) != "bytes=") { sb_r2_transfer_download_close(download); respond_with_error(res, "416 Range Not Satisfiable", "invalid range", true); return true; }
      const std::string_view spec = range.substr(6); const size_t dash = spec.find('-');
      if (dash == std::string_view::npos || dash == 0) { sb_r2_transfer_download_close(download); respond_with_error(res, "416 Range Not Satisfiable", "invalid range", true); return true; }
      first = 0; for (char c : spec.substr(0, dash)) { if (c < '0' || c > '9') { sb_r2_transfer_download_close(download); respond_with_error(res, "416 Range Not Satisfiable", "invalid range", true); return true; } first = first * 10 + (c - '0'); }
      if (dash + 1 < spec.size()) { last = 0; for (char c : spec.substr(dash + 1)) { if (c < '0' || c > '9') { sb_r2_transfer_download_close(download); respond_with_error(res, "416 Range Not Satisfiable", "invalid range", true); return true; } last = last * 10 + (c - '0'); } }
      if (first >= full_size || last < first) { sb_r2_transfer_download_close(download); respond_with_error(res, "416 Range Not Satisfiable", "range outside object", true); return true; }
      if (last >= full_size) last = full_size - 1;
      char content_range[96]; snprintf(content_range, sizeof(content_range), "bytes %llu-%llu/%llu", (unsigned long long)first, (unsigned long long)last, (unsigned long long)full_size);
      res->writeStatus("206 Partial Content"); res->writeHeader("Content-Range", content_range);
    }
    res->writeHeader("ETag", etag); res->writeHeader("Accept-Ranges", "bytes");
    struct Download { sb_r2_transfer_ctx* ctx; uintmax_t base; uintmax_t size; uintmax_t sent = 0; bool closed = false; char chunk[65536]; };
    auto state = std::make_shared<Download>(Download{download, first, last - first + 1});
    auto pump = std::make_shared<std::function<bool()>>();
    *pump = [res, state, pump]() {
      if (state->closed) return false;
      for (;;) {
        const size_t want = state->size - state->sent < sizeof(state->chunk) ? (size_t)(state->size - state->sent) : sizeof(state->chunk);
        const size_t bytes = sb_r2_transfer_download_read(state->ctx, (size_t)(state->base + state->sent), state->chunk, want);
        const auto result = res->tryEnd(std::string_view(state->chunk, bytes), state->size);
        if (result.second || bytes == 0) { sb_r2_transfer_download_close(state->ctx); state->closed = true; return false; }
        if (!result.first) {
          res->onWritable([res, state](uintmax_t offset) {
            if (state->closed) return true;
            const size_t want = state->size - offset < sizeof(state->chunk) ? (size_t)(state->size - offset) : sizeof(state->chunk);
            const size_t bytes = sb_r2_transfer_download_read(state->ctx, (size_t)(state->base + offset), state->chunk, want);
            const auto resumed = res->tryEnd(std::string_view(state->chunk, bytes), state->size);
            if (resumed.second || bytes == 0) { sb_r2_transfer_download_close(state->ctx); state->closed = true; return true; }
            return resumed.first;
          });
          return false;
        }
        state->sent += bytes;
        if (state->sent == state->size) { sb_r2_transfer_download_close(state->ctx); state->closed = true; return false; }
      }
    };
    res->writeHeader("Content-Type", "application/octet-stream");
    res->onAborted([state]() { if (!state->closed) { sb_r2_transfer_download_close(state->ctx); state->closed = true; } });
    (*pump)();
    return true;
  }
  if (method != "PUT") { respond_with_error(res, "405 Method Not Allowed", "R2 transfer requires GET or PUT", true); return true; }`;

const done = new Set<string>();

/** Edits to Porffor's uWebSockets shim: `[marker, anchor, inject, what]`. */
const UWS_EDITS = [
  [HTTP10_SHIM_MARKER, HTTP10_SHIM_ANCHOR, HTTP10_SHIM_INJECT, "shim rebuild for HTTP/1.0 (#236)"],
  [BODY_MARKER, BODY_ANCHOR, BODY_INJECT, "request body limit"],
  [STATUS_SIG_MARKER, STATUS_SIG_ANCHOR, STATUS_SIG_INJECT, "status-line return type (#156)"],
  [STATUS_303_MARKER, STATUS_303_ANCHOR, STATUS_303_INJECT, "status-line 303 case (#156)"],
  [
    STATUS_DEFAULT_MARKER,
    STATUS_DEFAULT_ANCHOR,
    STATUS_DEFAULT_INJECT,
    "status-line fallback (#156)",
  ],
  [HDR_SIG_MARKER, HDR_SIG_ANCHOR, HDR_SIG_INJECT, "collect_headers res arg (#163)"],
  [HDR_CALL_MARKER, HDR_CALL_ANCHOR, HDR_CALL_INJECT, "collect_headers call site (#163)"],
  [HDR_CAP_MARKER, HDR_CAP_ANCHOR, HDR_CAP_INJECT, "remote-addr header capacity (#163)"],
  [HDR_SKIP_MARKER, HDR_SKIP_ANCHOR, HDR_SKIP_INJECT, "drop client-sent x-sb-remote-addr (#163)"],
  [HDR_APPEND_MARKER, HDR_APPEND_ANCHOR, HDR_APPEND_INJECT, "append x-sb-remote-addr (#163)"],
  [READ_RAW_DECL_MARKER, READ_RAW_DECL_ANCHOR, READ_RAW_DECL_INJECT, "read_raw_bytes decl (#176)"],
  [
    FORBIDDEN_HDR_MARKER,
    FORBIDDEN_HDR_ANCHOR,
    FORBIDDEN_HDR_INJECT,
    "drop x-sb-raw-body from the wire (#176)",
  ],
  [
    WRITE_RESPONSE_MARKER,
    WRITE_RESPONSE_ANCHOR,
    WRITE_RESPONSE_INJECT,
    "detect x-sb-raw-body, steer the body read (#176)",
  ],
  [R2_TRANSFER_MARKER, R2_TRANSFER_ANCHOR, R2_TRANSFER_INJECT, "native direct R2 transfer ingress (#195)"],
  [R2_TRANSFER_CALL_MARKER, R2_TRANSFER_CALL_ANCHOR, R2_TRANSFER_CALL_INJECT, "direct R2 transfer dispatch (#195)"],
] as const;

/** The uWebSockets shim source: body limit + the #156 status-line fix. Exported for tests. */
export async function patchUwebsockets(root: string): Promise<void> {
  const file = resolve(root, "compiler/uwebsockets.js");
  let src = await readFile(file, "utf8");
  let changed = false;
  // Upgrade already-patched caches from the initial upload-only bridge. New
  // caches receive the full bridge below; old ones need declarations plus the
  // GET dispatch grafted onto their existing transfer handler.
  if (src.includes(R2_TRANSFER_MARKER) && !src.includes(R2_DOWNLOAD_CACHE_MARKER)) {
    if (!src.includes(R2_DOWNLOAD_DECL_ANCHOR) || !src.includes(R2_DOWNLOAD_BRANCH_ANCHOR))
      throw new Error(`could not upgrade Porffor's direct R2 transfer bridge: anchor not found in ${file}.`);
    src = src.replace(R2_DOWNLOAD_DECL_ANCHOR, R2_DOWNLOAD_DECL_INJECT);
    src = src.replace(R2_DOWNLOAD_BRANCH_ANCHOR, R2_DOWNLOAD_BRANCH_INJECT);
    changed = true;
  }
  if (src.includes(R2_DOWNLOAD_CACHE_MARKER) && !src.includes(R2_RANGE_CACHE_MARKER)) {
    const stateAnchor = "    struct Download { sb_r2_transfer_ctx* ctx; uintmax_t size; bool closed = false; };\n    auto state = std::make_shared<Download>(Download{download, sb_r2_transfer_download_size(download)});";
    const range = `    const uintmax_t full_size = sb_r2_transfer_download_size(download);
    uintmax_t first = 0, last = full_size ? full_size - 1 : 0;
    const std::string_view range = req->getHeader("range");
    if (!range.empty()) {
      if (range.substr(0, 6) != "bytes=") { sb_r2_transfer_download_close(download); respond_with_error(res, "416 Range Not Satisfiable", "invalid range", true); return true; }
      const std::string_view spec = range.substr(6); const size_t dash = spec.find('-');
      if (dash == std::string_view::npos || dash == 0) { sb_r2_transfer_download_close(download); respond_with_error(res, "416 Range Not Satisfiable", "invalid range", true); return true; }
      first = 0; for (char c : spec.substr(0, dash)) { if (c < '0' || c > '9') { sb_r2_transfer_download_close(download); respond_with_error(res, "416 Range Not Satisfiable", "invalid range", true); return true; } first = first * 10 + (c - '0'); }
      if (dash + 1 < spec.size()) { last = 0; for (char c : spec.substr(dash + 1)) { if (c < '0' || c > '9') { sb_r2_transfer_download_close(download); respond_with_error(res, "416 Range Not Satisfiable", "invalid range", true); return true; } last = last * 10 + (c - '0'); } }
      if (first >= full_size || last < first) { sb_r2_transfer_download_close(download); respond_with_error(res, "416 Range Not Satisfiable", "range outside object", true); return true; }
      if (last >= full_size) last = full_size - 1;
      char content_range[96]; snprintf(content_range, sizeof(content_range), "bytes %llu-%llu/%llu", (unsigned long long)first, (unsigned long long)last, (unsigned long long)full_size);
      res->writeStatus("206 Partial Content"); res->writeHeader("Content-Range", content_range);
    }
`;
    const state = "    struct Download { sb_r2_transfer_ctx* ctx; uintmax_t base; uintmax_t size; bool closed = false; };\n    auto state = std::make_shared<Download>(Download{download, first, last - first + 1});";
    if (!src.includes(stateAnchor)) throw new Error(`could not upgrade Porffor's direct R2 range bridge: anchor not found in ${file}.`);
    src = src.replace("  // sb_r2_transfer_download_v1\n", "  // sb_r2_transfer_download_v1\n  // sb_r2_transfer_range_v1\n");
    src = src.replace(stateAnchor, range + state);
    src = src.replace("sb_r2_transfer_download_read(state->ctx, (size_t)offset, chunk, sizeof(chunk))", "sb_r2_transfer_download_read(state->ctx, (size_t)(state->base + offset), chunk, sizeof(chunk))");
    changed = true;
  }
  if (src.includes(R2_RANGE_CACHE_MARKER) && !src.includes(R2_CONDITIONAL_CACHE_MARKER)) {
    const declaration = "  size_t sb_r2_transfer_download_size(sb_r2_transfer_ctx*);\n";
    const declarationReplacement = declaration + "  const char* sb_r2_transfer_download_etag(sb_r2_transfer_ctx*);\n";
    const anchor = "    const uintmax_t full_size = sb_r2_transfer_download_size(download);\n";
    const inject = `    // sb_r2_transfer_conditional_v1
    const std::string etag = sb_r2_transfer_download_etag(download);
    res->writeHeader("ETag", etag); res->writeHeader("Accept-Ranges", "bytes");
    const std::string_view if_none_match = req->getHeader("if-none-match");
    if (if_none_match == "*" || if_none_match == etag || (if_none_match.size() == etag.size() + 2 && if_none_match.front() == '"' && if_none_match.back() == '"' && if_none_match.substr(1, etag.size()) == etag)) {
      sb_r2_transfer_download_close(download); res->writeStatus("304 Not Modified"); res->end(); return true;
    }
` + anchor;
    if (!src.includes(declaration) || !src.includes(anchor)) throw new Error(`could not upgrade Porffor's direct R2 conditional bridge: anchor not found in ${file}.`);
    src = src.replace(declaration, declarationReplacement).replace(anchor, inject);
    changed = true;
  }
  if (src.includes(R2_CONDITIONAL_CACHE_MARKER) && !src.includes(R2_STREAMING_CACHE_MARKER)) {
    const oldPump = `      const uintmax_t offset = res->getWriteOffset();
      char chunk[65536];
      const size_t bytes = sb_r2_transfer_download_read(state->ctx, (size_t)(state->base + offset), chunk, sizeof(chunk));
      const auto result = res->tryEnd(std::string_view(chunk, bytes), state->size);
      if (result.second) { sb_r2_transfer_download_close(state->ctx); state->closed = true; return false; }
      if (!result.first) res->onWritable([pump](uintmax_t) { return (*pump)(); });
      return false;`;
    const newPump = `      for (;;) {
        const uintmax_t offset = res->getWriteOffset(); char chunk[65536];
        const size_t bytes = sb_r2_transfer_download_read(state->ctx, (size_t)(state->base + offset), chunk, sizeof(chunk));
        const auto result = res->tryEnd(std::string_view(chunk, bytes), state->size);
        if (result.second) { sb_r2_transfer_download_close(state->ctx); state->closed = true; return false; }
        if (!result.first) { res->onWritable([pump](uintmax_t) { return (*pump)(); }); return false; }
      }`;
    if (!src.includes(oldPump)) throw new Error(`could not upgrade Porffor's direct R2 streaming bridge: anchor not found in ${file}.`);
    src = src.replace("  // sb_r2_transfer_conditional_v1\n", "  // sb_r2_transfer_conditional_v1\n  // sb_r2_transfer_streaming_v2\n").replace(oldPump, newPump);
    changed = true;
  }
  // A short-lived v2 cache marker was written before its pump fix. Repair
  // those caches as well as applying the current form to future upgrades.
  if (src.includes("state->base + offset") && src.includes("uintmax_t size; bool closed = false;")) {
    const oldState = "struct Download { sb_r2_transfer_ctx* ctx; uintmax_t base; uintmax_t size; bool closed = false; };";
    const newState = "struct Download { sb_r2_transfer_ctx* ctx; uintmax_t base; uintmax_t size; uintmax_t sent = 0; bool closed = false; };";
    const oldPump = `      const uintmax_t offset = res->getWriteOffset(); char chunk[65536];
        const size_t bytes = sb_r2_transfer_download_read(state->ctx, (size_t)(state->base + offset), chunk, sizeof(chunk));
        const auto result = res->tryEnd(std::string_view(chunk, bytes), state->size);
        if (result.second) { sb_r2_transfer_download_close(state->ctx); state->closed = true; return false; }
        if (!result.first) { res->onWritable([pump](uintmax_t) { return (*pump)(); }); return false; }
      }`;
    const newPump = `      char chunk[65536];
        const size_t bytes = sb_r2_transfer_download_read(state->ctx, (size_t)(state->base + state->sent), chunk, sizeof(chunk));
        const auto result = res->tryEnd(std::string_view(chunk, bytes), state->size);
        if (result.second) { sb_r2_transfer_download_close(state->ctx); state->closed = true; return false; }
        if (!result.first) { res->onWritable([pump, state](uintmax_t offset) { state->sent = offset; return (*pump)(); }); return false; }
        state->sent += bytes;
      }`;
    if (!src.includes(oldState) || !src.includes(oldPump)) throw new Error(`could not repair Porffor's direct R2 streaming bridge: anchor not found in ${file}.`);
    src = src.replace(oldState, newState).replace(oldPump, newPump);
    changed = true;
  }
  const duplicatePump = "      for (;;) {\n        char chunk[65536];\n      for (;;) {\n";
  if (src.includes(duplicatePump)) {
    src = src.replace(duplicatePump, "      for (;;) {\n        char chunk[65536];\n");
    changed = true;
  }
  const unclosedPump = "        state->sent += bytes;\n    };\n";
  if (src.includes(unclosedPump)) {
    src = src.replace(unclosedPump, "        state->sent += bytes;\n      }\n    };\n");
    changed = true;
  }
  if (src.includes(R2_STREAMING_CACHE_MARKER) && !src.includes(R2_RANGE_HEADER_CACHE_MARKER)) {
    const rangeHeader = "    const std::string_view range = req->getHeader(\"range\");\n";
    if (!src.includes(rangeHeader)) throw new Error(`could not upgrade Porffor's direct R2 range-header bridge: anchor not found in ${file}.`);
    src = src.replace("  // sb_r2_transfer_range_v1\n", "  // sb_r2_transfer_range_v1\n  // sb_r2_transfer_range_header_v2\n");
    src = src.replace(rangeHeader, "    std::string_view range = req->getHeader(\"range\"); if (range.empty()) range = req->getHeader(\"Range\");\n");
    changed = true;
  }
  const earlyConditionalHeaders = "    res->writeHeader(\"ETag\", etag); res->writeHeader(\"Accept-Ranges\", \"bytes\");\n";
  if (src.includes(earlyConditionalHeaders) && src.indexOf(earlyConditionalHeaders) < src.indexOf("    const uintmax_t full_size = sb_r2_transfer_download_size(download);")) {
    const old304 = "      sb_r2_transfer_download_close(download); res->writeStatus(\"304 Not Modified\"); res->end(); return true;";
    const new304 = "      sb_r2_transfer_download_close(download); res->writeStatus(\"304 Not Modified\"); res->writeHeader(\"ETag\", etag); res->end(); return true;";
    const rangeEnd = "      res->writeStatus(\"206 Partial Content\"); res->writeHeader(\"Content-Range\", content_range);\n    }\n";
    if (!src.includes(old304) || !src.includes(rangeEnd)) throw new Error(`could not repair Porffor's direct R2 response ordering: anchor not found in ${file}.`);
    src = src.replace(earlyConditionalHeaders, "").replace(old304, new304).replace(rangeEnd, rangeEnd + "    res->writeHeader(\"ETag\", etag); res->writeHeader(\"Accept-Ranges\", \"bytes\");\n");
    changed = true;
  }
  if (src.includes("state->sent") && src.includes(R2_DOWNLOAD_CACHE_MARKER)) {
    const stateStart = src.indexOf("    struct Download {", src.indexOf(R2_DOWNLOAD_CACHE_MARKER));
    const stateEnd = src.indexOf("    res->writeHeader(\"Content-Type\"", stateStart);
    const freshStart = R2_DOWNLOAD_BRANCH_INJECT.indexOf("    struct Download {");
    const freshEnd = R2_DOWNLOAD_BRANCH_INJECT.indexOf("    res->writeHeader(\"Content-Type\"", freshStart);
    if (stateStart < 0 || stateEnd < 0 || freshStart < 0 || freshEnd < 0) throw new Error(`could not replace Porffor's direct R2 stream pump: anchor not found in ${file}.`);
    src = src.slice(0, stateStart) + R2_DOWNLOAD_BRANCH_INJECT.slice(freshStart, freshEnd) + src.slice(stateEnd);
    changed = true;
  }
  if (src.includes("writable_offset") && src.includes(R2_DOWNLOAD_CACHE_MARKER)) {
    const stateStart = src.indexOf("    struct Download {", src.indexOf(R2_DOWNLOAD_CACHE_MARKER));
    const stateEnd = src.indexOf("    res->writeHeader(\"Content-Type\"", stateStart);
    const freshStart = R2_TRANSFER_INJECT.indexOf("    struct Download {");
    const freshEnd = R2_TRANSFER_INJECT.indexOf("    res->writeHeader(\"Content-Type\"", freshStart);
    if (stateStart < 0 || stateEnd < 0 || freshStart < 0 || freshEnd < 0) throw new Error(`could not restore Porffor's direct R2 stream pump: anchor not found in ${file}.`);
    src = src.slice(0, stateStart) + R2_TRANSFER_INJECT.slice(freshStart, freshEnd) + src.slice(stateEnd);
    changed = true;
  }
  for (const [marker, anchor, inject, what] of UWS_EDITS) {
    if (src.includes(marker)) continue;
    if (!src.includes(anchor)) {
      throw new Error(
        `could not patch Porffor's ${what}: anchor not found in ${file}. ` +
          "Porffor's uWebSockets shim changed. See https://github.com/baronunread/sproutboat/tree/main/patches/upstream.",
      );
    }
    src = src.replace(anchor, inject);
    changed = true;
  }
  if (changed) await writeFile(file, src);
}

const CLASS_SELF_IMPORT_ANCHOR = "import link from './modules.js';";
const CLASS_SELF_IMPORT_INJECT = "import link from './modules.js';\nimport sbClassSelf from './sb-class-self.js';";
const CLASS_SELF_CALL_ANCHOR = "  if (ast._ts) globalThis.typedInput = Prefs.optTypes;";
const CLASS_SELF_CALL_INJECT = "  sbClassSelf(ast); // sproutboat #256\n  if (ast._ts) globalThis.typedInput = Prefs.optTypes;";
const CLASS_SELF_MARKER = "sproutboat #256";

/** #256 — see CLASS_SELF_HELPER. */
export async function patchClassSelfName(root: string): Promise<void> {
  await writeFile(resolve(root, "compiler/sb-class-self.js"), CLASS_SELF_HELPER);
  const file = resolve(root, "compiler/parse.js");
  let src = await readFile(file, "utf8");
  if (src.includes(CLASS_SELF_MARKER)) return;
  for (const [anchor, what] of [
    [CLASS_SELF_IMPORT_ANCHOR, "import"],
    [CLASS_SELF_CALL_ANCHOR, "call"],
  ] as const) {
    if (!src.includes(anchor)) throw new Error(`could not patch Porffor's class self-name rewrite (${what}): anchor not found in ${file}`);
  }
  src = src.replace(CLASS_SELF_IMPORT_ANCHOR, CLASS_SELF_IMPORT_INJECT).replace(CLASS_SELF_CALL_ANCHOR, CLASS_SELF_CALL_INJECT);
  await writeFile(file, src);
}

async function patchCompilerArgs(root: string): Promise<void> {
  await writeFile(resolve(root, "compiler/sb-http10.js"), HTTP10_HELPER);
  const file = resolve(root, "compiler/index.js");
  let src = await readFile(file, "utf8");
  let changed = false;
  for (const [marker, anchor, inject, what] of [
    [LINK_MARKER, LINK_ANCHOR, LINK_INJECT, "extra link args"],
    [CFLAGS_MARKER, CFLAGS_ANCHOR, CFLAGS_INJECT, "extra compiler flags"],
    [FP_CONTRACT_MARKER, FP_CONTRACT_ANCHOR, FP_CONTRACT_INJECT, "floating-point contraction"],
    [HTTP10_IMPORT_MARKER, HTTP10_IMPORT_ANCHOR, HTTP10_IMPORT_INJECT, "HTTP/1.0 helper import (#236)"],
    [HTTP10_CALL_MARKER, HTTP10_CALL_ANCHOR, HTTP10_CALL_INJECT, "HTTP/1.0 parser edit (#236)"],
  ] as const) {
    if (src.includes(marker)) continue;
    const at = src.indexOf(anchor);
    if (at === -1) {
      throw new Error(
        `could not patch Porffor for ${what}: anchor not found in ${file}. ` +
          "Porffor's native-fetch build changed. See https://github.com/baronunread/sproutboat/tree/main/patches/upstream.",
      );
    }
    // Add flags to compileOnlyArgs so every generated C unit sees them and
    // Porffor's module-build cache includes them in its compiler command.
    src =
      marker !== LINK_MARKER
        ? src.slice(0, at + anchor.length) + inject + src.slice(at + anchor.length)
        : src.slice(0, at) + inject + src.slice(at);
    changed = true;
  }
  if (changed) await writeFile(file, src);
}

export async function patchDateParser(root: string): Promise<void> {
  const file = resolve(root, "compiler/builtins/date.ts");
  const src = await readFile(file, "utf8");
  if (src.includes(DATE_PARSER_MARKER)) return;
  const start = src.indexOf("export const __ecma262_ParseDTSF");
  const end = src.indexOf("// RFC 7231 or Date.prototype.toString() parser", start);
  if (start < 0 || end < 0) throw new Error(`could not find Porffor's ISO date parser in ${file}`);
  const parser = src.slice(start, end);
  if (!parser.includes(DATE_PARSER_ANCHOR))
    throw new Error(`could not patch Porffor's ISO date parser: anchor not found in ${file}`);
  await writeFile(file, src.slice(0, start) + parser.replace(DATE_PARSER_ANCHOR, DATE_PARSER_INJECT) + src.slice(end));
}

/** #168: keep a promise resolving to null out of the `then` probe. Precompiled by patchTypedArrayFrom. */
export async function patchPromiseResolveNull(root: string): Promise<void> {
  const file = resolve(root, "compiler/builtins/promise.ts");
  const src = await readFile(file, "utf8");
  if (src.includes(PROMISE_NULL_MARKER)) return;
  if (!src.includes(PROMISE_NULL_ANCHOR))
    throw new Error(`could not patch Porffor's promise resolve for null: anchor not found in ${file}`);
  await writeFile(file, src.replace(PROMISE_NULL_ANCHOR, PROMISE_NULL_INJECT));
}

/** #237: linear String.prototype.replaceAll. Precompiled by patchTypedArrayFrom. */
export async function patchReplaceAll(root: string): Promise<void> {
  const file = resolve(root, "compiler/builtins/string.ts");
  let src = await readFile(file, "utf8");
  if (src.includes(REPLACE_ALL_MARKER)) return;
  const start = src.indexOf("export const __Porffor_string_replaceAll = ");
  const end = src.indexOf("export const __String_prototype_replaceAll = ", start);
  if (start < 0 || end < 0) throw new Error(`could not find Porffor's replaceAll in ${file}`);
  let body = src.slice(start, end);
  for (const [anchor, inject] of REPLACE_ALL_EDITS) {
    if (!body.includes(anchor)) throw new Error(`could not patch Porffor's replaceAll: anchor not found in ${file}`);
    body = body.replace(anchor, inject);
  }
  src = src.slice(0, start) + body + src.slice(end);
  await writeFile(file, src);
}

/** #238: modular typed-array stores. Before the precompile so builtins get it too. */
export async function patchTypedArrayStore(root: string): Promise<void> {
  const file = resolve(root, "compiler/codegen.js");
  let src = await readFile(file, "utf8");
  let changed = false;
  for (const [marker, anchor, inject, what] of [
    [TA_STORE_MARKER, TA_STORE_ANCHOR, TA_STORE_INJECT, "typed-array store conversion"],
    [BITNOT_MARKER, BITNOT_ANCHOR, BITNOT_INJECT, "bitwise NOT conversion"],
    [TA_GET_MARKER, TA_GET_ANCHOR, TA_GET_INJECT, "typed-array read bounds"],
    [TA_SET_BOUNDS_MARKER, TA_SET_BOUNDS_ANCHOR, TA_SET_BOUNDS_INJECT, "typed-array write bounds"],
  ] as const) {
    if (src.includes(marker)) continue;
    if (!src.includes(anchor)) throw new Error(`could not patch Porffor's ${what}: anchor not found in ${file}`);
    src = src.replace(anchor, inject);
    changed = true;
  }
  if (changed) await writeFile(file, src);
}

export async function patchTypedArrayFrom(root: string): Promise<void> {
  const file = resolve(root, "compiler/builtins/typedarray.js");
  const src = await readFile(file, "utf8");
  if (!src.includes(TYPED_ARRAY_FROM_MARKER) && !src.includes(TYPED_ARRAY_FROM_ANCHOR)) {
    throw new Error(`could not patch Porffor's TypedArray.from: anchor not found in ${file}`);
  }
  let edited = src;
  if (!edited.includes(TYPED_ARRAY_FROM_MARKER)) edited = edited.replace(TYPED_ARRAY_FROM_ANCHOR, TYPED_ARRAY_FROM_INJECT);
  if (!edited.includes(TA_JOIN_MARKER)) {
    if (!edited.includes(TA_JOIN_ANCHOR))
      throw new Error(`could not patch Porffor's typed-array method generator: anchor not found in ${file}`);
    edited = edited.replace(TA_JOIN_ANCHOR, TA_JOIN_INJECT);
  }
  if (!edited.includes(TA_SET_OFFSET_MARKER)) {
    if (!edited.includes(TA_SET_OFFSET_ANCHOR))
      throw new Error(`could not patch Porffor's TypedArray.prototype.set offset: anchor not found in ${file}`);
    edited = edited.replace(TA_SET_OFFSET_ANCHOR, TA_SET_OFFSET_INJECT);
  }
  if (edited !== src) await writeFile(file, edited);
  const table = resolve(root, "compiler/builtins_precompiled.js");
  const before = await readFile(table);
  // Porffor only writes the table when import.meta.url matches argv[1].
  // macOS's /var -> /private/var symlink makes a noncanonical argv[1] skip it.
  const precompile = await realpath(resolve(root, "compiler/precompile.js"));
  const child = Bun.spawn(["node", precompile], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`could not precompile Porffor's TypedArray.from: ${stderr || stdout}`);
  if (edited !== src && before.equals(await readFile(table)))
    throw new Error(`Porffor precompile did not update ${table}`);
}

/** The native-fetch server source: $PORT support + the #165 console sink. Exported for tests. */
export async function patchRenderJs(root: string): Promise<void> {
  const file = resolve(root, "compiler/render.js");
  let src = await readFile(file, "utf8");
  let changed = false;
  for (const [marker, anchor, inject, what] of RENDER_EDITS) {
    if (src.includes(marker)) continue;
    const at = src.indexOf(anchor);
    if (at === -1) {
      throw new Error(
        `could not patch Porffor for ${what}: anchor not found in ${file}. ` +
          "Porffor's native-fetch renderer changed. See https://github.com/baronunread/sproutboat/tree/main/patches/upstream.",
      );
    }
    src = src.slice(0, at + anchor.length) + inject + src.slice(at + anchor.length);
    changed = true;
  }

  // Full-block replacements, not append-after-anchor: each needs the whole
  // matched region gone, not just something added alongside it.
  for (const [marker, anchor, inject, what] of RENDER_REPLACEMENTS) {
    if (src.includes(marker)) continue;
    if (!src.includes(anchor)) {
      throw new Error(
        `could not patch Porffor for ${what}: anchor not found in ${file}. ` +
          "Porffor's native-fetch renderer changed. See https://github.com/baronunread/sproutboat/tree/main/patches/upstream.",
      );
    }
    src = src.replace(anchor, inject);
    changed = true;
  }

  if (changed) await writeFile(file, src);
}

/**
 * Apply every patch to a Porffor checkout at `root` (the directory that holds
 * `compiler/` and `runtime/`). Idempotent per process and per marker, so it is
 * safe to call on every build. Callers pass an explicit root — `ensurePorffor`
 * right after extraction, the compile path against its resolved checkout.
 */
export async function ensurePorfforPatched(root: string): Promise<void> {
  if (done.has(root)) return;
  await patchCompilerArgs(root);
  await patchClassSelfName(root);
  await patchUwebsockets(root);
  await patchRenderJs(root);
  await patchDateParser(root);
  await patchPromiseResolveNull(root);
  await patchReplaceAll(root);
  await patchTypedArrayStore(root);
  // Last of the builtin edits: its precompile picks up the date, promise and
  // replaceAll patches above too.
  await patchTypedArrayFrom(root);
  await patchUnicode(root);
  done.add(root);
}
