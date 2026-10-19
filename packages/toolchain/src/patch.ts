/**
 * Idempotent, marker-guarded in-place edits to Porffor's generated C
 * (`compiler/render.js`, `compiler/index.js`, `compiler/uwebsockets.js`,
 * `compiler/builtins/date.ts`). Run
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
import { URL_CLASS_SOURCE } from "./url-class";
import { TEXT_DECODER_SOURCE } from "./text-decoder";
import { CASE_LOWER_RUNS, CASE_UPPER_RUNS } from "./case-map";
import { HEADERS_CLASS_SOURCE } from "./headers-class";
import { PORFFOR_COMMIT_FULL } from "./pin";
import { version as TOOLCHAIN_VERSION } from "../package.json" with { type: "json" };

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
  [
    CONSOLE_MARKER,
    CONSOLE_ANCHOR,
    CONSOLE_INJECT,
    "console output sink (#165)",
  ],
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
 * render.js full-block replacements: `[marker, anchor, inject, what]`, each a
 * complete swap of the matched region (unlike `RENDER_EDITS`, which only ever
 * inserts after its anchor).
 */
const RENDER_REPLACEMENTS = [
  [
    BYTESTRING_MARKER,
    BYTESTRING_ANCHOR,
    BYTESTRING_INJECT,
    "bytestring UTF-8 encoding (#172)",
  ],
  [
    READ_RAW_MARKER,
    READ_RAW_ANCHOR,
    READ_RAW_INJECT,
    "raw bytestring passthrough function (#176)",
  ],
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
const FP_CONTRACT_ANCHOR =
  "      '-fno-ident', '-ffunction-sections', '-fdata-sections',\n";
const FP_CONTRACT_INJECT =
  "      '-ffp-contract=off', // sproutboat #235: JS rounds a * b + c twice\n";
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
const HTTP10_IMPORT_INJECT =
  "import { sbPatchHttp10 } from './sb-http10.js'; // sproutboat #236\n";
const HTTP10_IMPORT_MARKER = "./sb-http10.js";
const HTTP10_CALL_ANCHOR =
  "      const uwsDir = uwebsockets.ensureUWebSockets();\n";
const HTTP10_CALL_INJECT = "      sbPatchHttp10(uwsDir);\n";
const HTTP10_CALL_MARKER = "sbPatchHttp10(uwsDir)";
// The shim is content-cached, so a header edit alone would never recompile it.
// This line changes the shim once, which rebuilds it against the edited header.
const HTTP10_SHIM_ANCHOR =
  'export const makeUWebSocketsShimSource = () => `\n#include "App.h"\n';
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

  // Loop once past the last character to flush the final number, but read a
  // 0 there, not the byte after the string: if that byte happened to be '+' or
  // '-' it flipped the offset's sign.
  while (ptr <= endPtr) {
    const chr: i32 = ptr < endPtr ? Porffor.IR.loadU8(ptr, 4) : 0;
    ptr++;
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
const BODY_ANCHOR =
  "static const size_t REQUEST_BODY_MAX_BYTES = 1024u * 1024u;";
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
const STATUS_SIG_ANCHOR =
  "static std::string_view lookup_status_line(i32 status) {";
const STATUS_SIG_INJECT = "static std::string lookup_status_line(i32 status) {";
const STATUS_SIG_MARKER = "static std::string lookup_status_line(i32 status) {";
// 303 is the one this was reported for (POST-redirect-GET); give it the real
// reason phrase. Everything else unlisted rides the synthesized fallback below.
const STATUS_303_ANCHOR = '    case 302: return "302 Found";\n';
const STATUS_303_INJECT =
  '    case 302: return "302 Found";\n    case 303: return "303 See Other";\n';
const STATUS_303_MARKER = 'case 303: return "303 See Other";';
const STATUS_DEFAULT_ANCHOR = "    default: return {};";
const STATUS_DEFAULT_INJECT =
  '    default: return std::to_string(status) + " Status";';
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
const HDR_SIG_MARKER =
  "collect_headers(uWS::HttpRequest* req, uWS::HttpResponse";

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

const HDR_APPEND_ANCHOR =
  "  *((i32*)(porf_mem + headers_ptr)) = slot;\n\n  return headers_ptr;";
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
const READ_RAW_DECL_MARKER =
  "porf_native_fetch_read_raw_bytes(struct jsval value";

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
  "  if (raw_body && porf_native_fetch_read_raw_bytes(body_value, &body_buf, &body_len) != 0 && body_value.type == 67) {\n" +
  "    // Raw bytes can also arrive as a UTF-16 string (a fetch() response body parsed\n" +
  "    // from JSON), one byte per unit: narrow each unit, as the R2 upload path does.\n" +
  "    const u32 body_ptr = (u32)body_value.val;\n" +
  "    body_len = (size_t)*((u32*)(porf_mem + body_ptr));\n" +
  "    body_owned = (char*)malloc(body_len + 1);\n" +
  "    const unsigned short* units = (const unsigned short*)(porf_mem + body_ptr + 4);\n" +
  "    for (size_t i = 0; i < body_len; i++) body_owned[i] = (char)(units[i] & 0xff);\n" +
  "    body_buf = body_owned;\n" +
  "  } else if (!raw_body || !body_buf) porf_native_fetch_read_value(body_value, &body_buf, &body_len, &body_owned);\n" +
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
const R2_TRANSFER_ANCHOR =
  "static void on_request(uWS::HttpResponse<false>* res, uWS::HttpRequest* req) {\n";
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
    *pump = [res, state]() {
      if (state->closed) return false;
      for (;;) {
        const size_t want = state->size - state->sent < sizeof(state->chunk) ? (size_t)(state->size - state->sent) : sizeof(state->chunk);
        const size_t bytes = sb_r2_transfer_download_read(state->ctx, (size_t)(state->base + state->sent), state->chunk, want);
        const auto result = res->tryEnd(std::string_view(state->chunk, bytes), state->size);
        if (result.second || bytes == 0) { sb_r2_transfer_download_close(state->ctx); state->closed = true; return false; }
        if (!result.first) {
          res->onWritable([res, state](uintmax_t offset) {
            if (state->closed) return true;
            for (;;) {
              const size_t want = state->size - offset < sizeof(state->chunk) ? (size_t)(state->size - offset) : sizeof(state->chunk);
              const size_t bytes = sb_r2_transfer_download_read(state->ctx, (size_t)(state->base + offset), state->chunk, want);
              const auto resumed = res->tryEnd(std::string_view(state->chunk, bytes), state->size);
              if (resumed.second || bytes == 0) { sb_r2_transfer_download_close(state->ctx); state->closed = true; return true; }
              if (!resumed.first) return false;
              offset += bytes;
            }
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
const R2_TRANSFER_CALL_ANCHOR =
  "  __porffor_js_enter();\n  const i32 url_ptr = alloc_request_url(req);";
const R2_TRANSFER_CALL_INJECT =
  "  if (try_handle_r2_transfer(res, req, method)) return;\n" +
  R2_TRANSFER_CALL_ANCHOR;
const R2_TRANSFER_CALL_MARKER = "try_handle_r2_transfer(res, req, method)";
const R2_DOWNLOAD_CACHE_MARKER = "sb_r2_transfer_download_v1";
const R2_RANGE_CACHE_MARKER = "sb_r2_transfer_range_v1";
const R2_CONDITIONAL_CACHE_MARKER = "sb_r2_transfer_conditional_v1";
const R2_STREAMING_CACHE_MARKER = "sb_r2_transfer_streaming_v2";
const R2_RANGE_HEADER_CACHE_MARKER = "sb_r2_transfer_range_header_v2";
const R2_DOWNLOAD_DECL_ANCHOR =
  "  void sb_r2_transfer_abort(sb_r2_transfer_ctx*);\n}";
const R2_DOWNLOAD_DECL_INJECT =
  "  void sb_r2_transfer_abort(sb_r2_transfer_ctx*);\n" +
  "  int sb_r2_transfer_download_open(const char*, const char*, sb_r2_transfer_ctx**);\n" +
  "  size_t sb_r2_transfer_download_size(sb_r2_transfer_ctx*);\n" +
  "  const char* sb_r2_transfer_download_etag(sb_r2_transfer_ctx*);\n" +
  "  size_t sb_r2_transfer_download_read(sb_r2_transfer_ctx*, size_t, char*, size_t);\n" +
  "  void sb_r2_transfer_download_close(sb_r2_transfer_ctx*);\n}";
const R2_DOWNLOAD_BRANCH_ANCHOR =
  '  if (method != "PUT") { respond_with_error(res, "405 Method Not Allowed", "R2 transfer requires PUT", true); return true; }';
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
    *pump = [res, state]() {
      if (state->closed) return false;
      for (;;) {
        const size_t want = state->size - state->sent < sizeof(state->chunk) ? (size_t)(state->size - state->sent) : sizeof(state->chunk);
        const size_t bytes = sb_r2_transfer_download_read(state->ctx, (size_t)(state->base + state->sent), state->chunk, want);
        const auto result = res->tryEnd(std::string_view(state->chunk, bytes), state->size);
        if (result.second || bytes == 0) { sb_r2_transfer_download_close(state->ctx); state->closed = true; return false; }
        if (!result.first) {
          res->onWritable([res, state](uintmax_t offset) {
            if (state->closed) return true;
            for (;;) {
              const size_t want = state->size - offset < sizeof(state->chunk) ? (size_t)(state->size - offset) : sizeof(state->chunk);
              const size_t bytes = sb_r2_transfer_download_read(state->ctx, (size_t)(state->base + offset), state->chunk, want);
              const auto resumed = res->tryEnd(std::string_view(state->chunk, bytes), state->size);
              if (resumed.second || bytes == 0) { sb_r2_transfer_download_close(state->ctx); state->closed = true; return true; }
              if (!resumed.first) return false;
              offset += bytes;
            }
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
  [
    HTTP10_SHIM_MARKER,
    HTTP10_SHIM_ANCHOR,
    HTTP10_SHIM_INJECT,
    "shim rebuild for HTTP/1.0 (#236)",
  ],
  [BODY_MARKER, BODY_ANCHOR, BODY_INJECT, "request body limit"],
  [
    STATUS_SIG_MARKER,
    STATUS_SIG_ANCHOR,
    STATUS_SIG_INJECT,
    "status-line return type (#156)",
  ],
  [
    STATUS_303_MARKER,
    STATUS_303_ANCHOR,
    STATUS_303_INJECT,
    "status-line 303 case (#156)",
  ],
  [
    STATUS_DEFAULT_MARKER,
    STATUS_DEFAULT_ANCHOR,
    STATUS_DEFAULT_INJECT,
    "status-line fallback (#156)",
  ],
  [
    HDR_SIG_MARKER,
    HDR_SIG_ANCHOR,
    HDR_SIG_INJECT,
    "collect_headers res arg (#163)",
  ],
  [
    HDR_CALL_MARKER,
    HDR_CALL_ANCHOR,
    HDR_CALL_INJECT,
    "collect_headers call site (#163)",
  ],
  [
    HDR_CAP_MARKER,
    HDR_CAP_ANCHOR,
    HDR_CAP_INJECT,
    "remote-addr header capacity (#163)",
  ],
  [
    HDR_SKIP_MARKER,
    HDR_SKIP_ANCHOR,
    HDR_SKIP_INJECT,
    "drop client-sent x-sb-remote-addr (#163)",
  ],
  [
    HDR_APPEND_MARKER,
    HDR_APPEND_ANCHOR,
    HDR_APPEND_INJECT,
    "append x-sb-remote-addr (#163)",
  ],
  [
    READ_RAW_DECL_MARKER,
    READ_RAW_DECL_ANCHOR,
    READ_RAW_DECL_INJECT,
    "read_raw_bytes decl (#176)",
  ],
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
  [
    R2_TRANSFER_MARKER,
    R2_TRANSFER_ANCHOR,
    R2_TRANSFER_INJECT,
    "native direct R2 transfer ingress (#195)",
  ],
  [
    R2_TRANSFER_CALL_MARKER,
    R2_TRANSFER_CALL_ANCHOR,
    R2_TRANSFER_CALL_INJECT,
    "direct R2 transfer dispatch (#195)",
  ],
] as const;

/** The uWebSockets shim source: body limit + the #156 status-line fix. Exported for tests. */
export async function patchUwebsockets(root: string): Promise<void> {
  const file = resolve(root, "compiler/uwebsockets.js");
  let src = await readFile(file, "utf8");
  let changed = false;
  // Upgrade already-patched caches from the initial upload-only bridge. New
  // caches receive the full bridge below; old ones need declarations plus the
  // GET dispatch grafted onto their existing transfer handler.
  if (
    src.includes(R2_TRANSFER_MARKER) &&
    !src.includes(R2_DOWNLOAD_CACHE_MARKER)
  ) {
    if (
      !src.includes(R2_DOWNLOAD_DECL_ANCHOR) ||
      !src.includes(R2_DOWNLOAD_BRANCH_ANCHOR)
    )
      throw new Error(
        `could not upgrade Porffor's direct R2 transfer bridge: anchor not found in ${file}.`,
      );
    src = src.replace(R2_DOWNLOAD_DECL_ANCHOR, R2_DOWNLOAD_DECL_INJECT);
    src = src.replace(R2_DOWNLOAD_BRANCH_ANCHOR, R2_DOWNLOAD_BRANCH_INJECT);
    changed = true;
  }
  if (
    src.includes(R2_DOWNLOAD_CACHE_MARKER) &&
    !src.includes(R2_RANGE_CACHE_MARKER)
  ) {
    const stateAnchor =
      "    struct Download { sb_r2_transfer_ctx* ctx; uintmax_t size; bool closed = false; };\n    auto state = std::make_shared<Download>(Download{download, sb_r2_transfer_download_size(download)});";
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
    const state =
      "    struct Download { sb_r2_transfer_ctx* ctx; uintmax_t base; uintmax_t size; bool closed = false; };\n    auto state = std::make_shared<Download>(Download{download, first, last - first + 1});";
    if (!src.includes(stateAnchor))
      throw new Error(
        `could not upgrade Porffor's direct R2 range bridge: anchor not found in ${file}.`,
      );
    src = src.replace(
      "  // sb_r2_transfer_download_v1\n",
      "  // sb_r2_transfer_download_v1\n  // sb_r2_transfer_range_v1\n",
    );
    src = src.replace(stateAnchor, range + state);
    src = src.replace(
      "sb_r2_transfer_download_read(state->ctx, (size_t)offset, chunk, sizeof(chunk))",
      "sb_r2_transfer_download_read(state->ctx, (size_t)(state->base + offset), chunk, sizeof(chunk))",
    );
    changed = true;
  }
  if (
    src.includes(R2_RANGE_CACHE_MARKER) &&
    !src.includes(R2_CONDITIONAL_CACHE_MARKER)
  ) {
    const declaration =
      "  size_t sb_r2_transfer_download_size(sb_r2_transfer_ctx*);\n";
    const declarationReplacement =
      declaration +
      "  const char* sb_r2_transfer_download_etag(sb_r2_transfer_ctx*);\n";
    const anchor =
      "    const uintmax_t full_size = sb_r2_transfer_download_size(download);\n";
    const inject =
      `    // sb_r2_transfer_conditional_v1
    const std::string etag = sb_r2_transfer_download_etag(download);
    res->writeHeader("ETag", etag); res->writeHeader("Accept-Ranges", "bytes");
    const std::string_view if_none_match = req->getHeader("if-none-match");
    if (if_none_match == "*" || if_none_match == etag || (if_none_match.size() == etag.size() + 2 && if_none_match.front() == '"' && if_none_match.back() == '"' && if_none_match.substr(1, etag.size()) == etag)) {
      sb_r2_transfer_download_close(download); res->writeStatus("304 Not Modified"); res->end(); return true;
    }
` + anchor;
    if (!src.includes(declaration) || !src.includes(anchor))
      throw new Error(
        `could not upgrade Porffor's direct R2 conditional bridge: anchor not found in ${file}.`,
      );
    src = src
      .replace(declaration, declarationReplacement)
      .replace(anchor, inject);
    changed = true;
  }
  if (
    src.includes(R2_CONDITIONAL_CACHE_MARKER) &&
    !src.includes(R2_STREAMING_CACHE_MARKER)
  ) {
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
    if (!src.includes(oldPump))
      throw new Error(
        `could not upgrade Porffor's direct R2 streaming bridge: anchor not found in ${file}.`,
      );
    src = src
      .replace(
        "  // sb_r2_transfer_conditional_v1\n",
        "  // sb_r2_transfer_conditional_v1\n  // sb_r2_transfer_streaming_v2\n",
      )
      .replace(oldPump, newPump);
    changed = true;
  }
  // A short-lived v2 cache marker was written before its pump fix. Repair
  // those caches as well as applying the current form to future upgrades.
  if (
    src.includes("state->base + offset") &&
    src.includes("uintmax_t size; bool closed = false;")
  ) {
    const oldState =
      "struct Download { sb_r2_transfer_ctx* ctx; uintmax_t base; uintmax_t size; bool closed = false; };";
    const newState =
      "struct Download { sb_r2_transfer_ctx* ctx; uintmax_t base; uintmax_t size; uintmax_t sent = 0; bool closed = false; };";
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
    if (!src.includes(oldState) || !src.includes(oldPump))
      throw new Error(
        `could not repair Porffor's direct R2 streaming bridge: anchor not found in ${file}.`,
      );
    src = src.replace(oldState, newState).replace(oldPump, newPump);
    changed = true;
  }
  const duplicatePump =
    "      for (;;) {\n        char chunk[65536];\n      for (;;) {\n";
  if (src.includes(duplicatePump)) {
    src = src.replace(
      duplicatePump,
      "      for (;;) {\n        char chunk[65536];\n",
    );
    changed = true;
  }
  const unclosedPump = "        state->sent += bytes;\n    };\n";
  if (src.includes(unclosedPump)) {
    src = src.replace(
      unclosedPump,
      "        state->sent += bytes;\n      }\n    };\n",
    );
    changed = true;
  }
  if (
    src.includes(R2_STREAMING_CACHE_MARKER) &&
    !src.includes(R2_RANGE_HEADER_CACHE_MARKER)
  ) {
    const rangeHeader =
      '    const std::string_view range = req->getHeader("range");\n';
    if (!src.includes(rangeHeader))
      throw new Error(
        `could not upgrade Porffor's direct R2 range-header bridge: anchor not found in ${file}.`,
      );
    src = src.replace(
      "  // sb_r2_transfer_range_v1\n",
      "  // sb_r2_transfer_range_v1\n  // sb_r2_transfer_range_header_v2\n",
    );
    src = src.replace(
      rangeHeader,
      '    std::string_view range = req->getHeader("range"); if (range.empty()) range = req->getHeader("Range");\n',
    );
    changed = true;
  }
  const earlyConditionalHeaders =
    '    res->writeHeader("ETag", etag); res->writeHeader("Accept-Ranges", "bytes");\n';
  if (
    src.includes(earlyConditionalHeaders) &&
    src.indexOf(earlyConditionalHeaders) <
      src.indexOf(
        "    const uintmax_t full_size = sb_r2_transfer_download_size(download);",
      )
  ) {
    const old304 =
      '      sb_r2_transfer_download_close(download); res->writeStatus("304 Not Modified"); res->end(); return true;';
    const new304 =
      '      sb_r2_transfer_download_close(download); res->writeStatus("304 Not Modified"); res->writeHeader("ETag", etag); res->end(); return true;';
    const rangeEnd =
      '      res->writeStatus("206 Partial Content"); res->writeHeader("Content-Range", content_range);\n    }\n';
    if (!src.includes(old304) || !src.includes(rangeEnd))
      throw new Error(
        `could not repair Porffor's direct R2 response ordering: anchor not found in ${file}.`,
      );
    src = src
      .replace(earlyConditionalHeaders, "")
      .replace(old304, new304)
      .replace(
        rangeEnd,
        rangeEnd +
          '    res->writeHeader("ETag", etag); res->writeHeader("Accept-Ranges", "bytes");\n',
      );
    changed = true;
  }
  if (src.includes("state->sent") && src.includes(R2_DOWNLOAD_CACHE_MARKER)) {
    const stateStart = src.indexOf(
      "    struct Download {",
      src.indexOf(R2_DOWNLOAD_CACHE_MARKER),
    );
    const stateEnd = src.indexOf(
      '    res->writeHeader("Content-Type"',
      stateStart,
    );
    const freshStart = R2_DOWNLOAD_BRANCH_INJECT.indexOf(
      "    struct Download {",
    );
    const freshEnd = R2_DOWNLOAD_BRANCH_INJECT.indexOf(
      '    res->writeHeader("Content-Type"',
      freshStart,
    );
    if (stateStart < 0 || stateEnd < 0 || freshStart < 0 || freshEnd < 0)
      throw new Error(
        `could not replace Porffor's direct R2 stream pump: anchor not found in ${file}.`,
      );
    src =
      src.slice(0, stateStart) +
      R2_DOWNLOAD_BRANCH_INJECT.slice(freshStart, freshEnd) +
      src.slice(stateEnd);
    changed = true;
  }
  if (
    src.includes("writable_offset") &&
    src.includes(R2_DOWNLOAD_CACHE_MARKER)
  ) {
    const stateStart = src.indexOf(
      "    struct Download {",
      src.indexOf(R2_DOWNLOAD_CACHE_MARKER),
    );
    const stateEnd = src.indexOf(
      '    res->writeHeader("Content-Type"',
      stateStart,
    );
    const freshStart = R2_TRANSFER_INJECT.indexOf("    struct Download {");
    const freshEnd = R2_TRANSFER_INJECT.indexOf(
      '    res->writeHeader("Content-Type"',
      freshStart,
    );
    if (stateStart < 0 || stateEnd < 0 || freshStart < 0 || freshEnd < 0)
      throw new Error(
        `could not restore Porffor's direct R2 stream pump: anchor not found in ${file}.`,
      );
    src =
      src.slice(0, stateStart) +
      R2_TRANSFER_INJECT.slice(freshStart, freshEnd) +
      src.slice(stateEnd);
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
const CLASS_SELF_IMPORT_INJECT =
  "import link from './modules.js';\nimport sbClassSelf from './sb-class-self.js';";
const CLASS_SELF_CALL_ANCHOR =
  "  if (ast._ts) globalThis.typedInput = Prefs.optTypes;";
const CLASS_SELF_CALL_INJECT =
  "  sbClassSelf(ast); // sproutboat #256\n  if (ast._ts) globalThis.typedInput = Prefs.optTypes;";
const CLASS_SELF_MARKER = "sproutboat #256";

/** #256 — see CLASS_SELF_HELPER. */
export async function patchClassSelfName(root: string): Promise<void> {
  await writeFile(
    resolve(root, "compiler/sb-class-self.js"),
    CLASS_SELF_HELPER,
  );
  const file = resolve(root, "compiler/parse.js");
  let src = await readFile(file, "utf8");
  if (src.includes(CLASS_SELF_MARKER)) return;
  for (const [anchor, what] of [
    [CLASS_SELF_IMPORT_ANCHOR, "import"],
    [CLASS_SELF_CALL_ANCHOR, "call"],
  ] as const) {
    if (!src.includes(anchor))
      throw new Error(
        `could not patch Porffor's class self-name rewrite (${what}): anchor not found in ${file}`,
      );
  }
  src = src
    .replace(CLASS_SELF_IMPORT_ANCHOR, CLASS_SELF_IMPORT_INJECT)
    .replace(CLASS_SELF_CALL_ANCHOR, CLASS_SELF_CALL_INJECT);
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
    [
      FP_CONTRACT_MARKER,
      FP_CONTRACT_ANCHOR,
      FP_CONTRACT_INJECT,
      "floating-point contraction",
    ],
    [
      HTTP10_IMPORT_MARKER,
      HTTP10_IMPORT_ANCHOR,
      HTTP10_IMPORT_INJECT,
      "HTTP/1.0 helper import (#236)",
    ],
    [
      HTTP10_CALL_MARKER,
      HTTP10_CALL_ANCHOR,
      HTTP10_CALL_INJECT,
      "HTTP/1.0 parser edit (#236)",
    ],
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
        ? src.slice(0, at + anchor.length) +
          inject +
          src.slice(at + anchor.length)
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
  const end = src.indexOf(
    "// RFC 7231 or Date.prototype.toString() parser",
    start,
  );
  if (start < 0 || end < 0)
    throw new Error(`could not find Porffor's ISO date parser in ${file}`);
  const parser = src.slice(start, end);
  if (!parser.includes(DATE_PARSER_ANCHOR))
    throw new Error(
      `could not patch Porffor's ISO date parser: anchor not found in ${file}`,
    );
  await writeFile(
    file,
    src.slice(0, start) +
      parser.replace(DATE_PARSER_ANCHOR, DATE_PARSER_INJECT) +
      src.slice(end),
  );
}

/** #168: keep a promise resolving to null out of the `then` probe. */
export async function patchPromiseResolveNull(root: string): Promise<void> {
  const file = resolve(root, "compiler/builtins/promise.ts");
  const src = await readFile(file, "utf8");
  if (src.includes(PROMISE_NULL_MARKER)) return;
  if (!src.includes(PROMISE_NULL_ANCHOR))
    throw new Error(
      `could not patch Porffor's promise resolve for null: anchor not found in ${file}`,
    );
  await writeFile(file, src.replace(PROMISE_NULL_ANCHOR, PROMISE_NULL_INJECT));
}

/** #237: linear String.prototype.replaceAll. Precompiled by precompileBuiltins. */
export async function patchReplaceAll(root: string): Promise<void> {
  const file = resolve(root, "compiler/builtins/string.ts");
  let src = await readFile(file, "utf8");
  if (src.includes(REPLACE_ALL_MARKER)) return;
  const start = src.indexOf("export const __Porffor_string_replaceAll = ");
  const end = src.indexOf(
    "export const __String_prototype_replaceAll = ",
    start,
  );
  if (start < 0 || end < 0)
    throw new Error(`could not find Porffor's replaceAll in ${file}`);
  let body = src.slice(start, end);
  for (const [anchor, inject] of REPLACE_ALL_EDITS) {
    if (!body.includes(anchor))
      throw new Error(
        `could not patch Porffor's replaceAll: anchor not found in ${file}`,
      );
    body = body.replace(anchor, inject);
  }
  src = src.slice(0, start) + body + src.slice(end);
  await writeFile(file, src);
}

/** Register elided local function expressions so inference uses their lexical binding. */
export async function patchLocalFunctionTypes(root: string): Promise<void> {
  const file = resolve(root, "compiler/codegen.js");
  let src = await readFile(file, "utf8");
  const marker =
    "sproutboat: preserve lexical types for direct-only local functions";
  if (src.includes(marker)) return;
  const anchor =
    "if (!hoistRead && directCallOnlyFunctionBinding(scope, kind, name, pattern, func)) {\n        return valUndefined();";
  if (!src.includes(anchor))
    throw new Error(
      `could not patch Porffor local function types: anchor not found in ${file}`,
    );
  src = src.replace(
    anchor,
    "if (!hoistRead && directCallOnlyFunctionBinding(scope, kind, name, pattern, func)) {\n" +
      `        // ${marker}\n` +
      "        bindNamedFunction(scope, name, func);\n        return valUndefined();",
  );
  // resolveNamedFunction already handles unambiguous global fallbacks. Falling
  // back again can infer a type from an unrelated same-named function.
  const fallback =
    "const func = resolveNamedFunction(scope, name) ?? funcByName(name);";
  if (!src.includes(fallback))
    throw new Error(
      `could not patch Porffor local function type fallback: anchor not found in ${file}`,
    );
  src = src.replace(
    fallback,
    "const func = resolveNamedFunction(scope, name);",
  );
  await writeFile(file, src);
}

/** Keep base64 option tags accurate and truncate the complete-chunk count. */
export async function patchUint8ArrayBase64(root: string): Promise<void> {
  const file = resolve(root, "compiler/builtins/uint8array_base64.ts");
  let src = await readFile(file, "utf8");
  const marker = "sproutboat: base64 option tags and complete chunks";
  if (src.includes(marker)) return;
  const edits = [
    ["let alphabet: string =", "let alphabet: any ="],
    ["let lastChunkHandling: string =", "let lastChunkHandling: any ="],
    [
      "const fullChunks: i32 = (len / 3) * 3;",
      "const fullChunks: i32 = ((len / 3) | 0) * 3;",
    ],
  ] as const;
  for (const [anchor, replacement] of edits) {
    if (!src.includes(anchor))
      throw new Error(
        `could not patch Porffor base64: anchor not found in ${file}`,
      );
    src = src.replaceAll(anchor, replacement);
  }
  await writeFile(file, `// ${marker}\n${src}`);
}

export async function precompileBuiltins(root: string): Promise<void> {
  const table = resolve(root, "compiler/builtins_precompiled.js");
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
  if (code !== 0)
    throw new Error(
      `could not precompile Porffor's patched builtins: ${stderr || stdout}`,
    );
  if ((await readFile(table)).length === 0)
    throw new Error(`Porffor precompile produced an empty ${table}`);
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
    src =
      src.slice(0, at + anchor.length) + inject + src.slice(at + anchor.length);
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

/** Reclaim a burst's dead heap and oversized GC workspace after a quiet period. */
export async function patchQuietCollection(root: string): Promise<void> {
  const renderFile = resolve(root, "compiler/render.js");
  const shimFile = resolve(root, "compiler/uwebsockets.js");
  let render = await readFile(renderFile, "utf8");
  let shim = await readFile(shimFile, "utf8");
  const marker = "// sproutboat: reclaim large idle heaps";
  if (!render.includes(marker)) {
    const start = render.indexOf(
      "void porf_native_fetch_collect_normal_from(void* stack_top) {",
    );
    const end = render.indexOf(
      "\nint porf_native_fetch_should_collect(void)",
      start,
    );
    if (start < 0 || end < 0)
      throw new Error("Porffor quiet-GC renderer anchor missing");
    const normal = render.slice(start, end);
    if (
      !normal.includes("porf_gc_collect_idle();") ||
      !normal.includes("  porf_c_stack_top = prev_stack_top;")
    )
      throw new Error("Porffor quiet-GC collector changed");
    const quiet = normal
      .replace("collect_normal_from", "collect_quiet_from")
      .replace(
        "if (porf_heap_base == 0) return;",
        "if (!porf_native_fetch_needs_quiet_collect()) return;",
      )
      .replace("porf_gc_collect_idle();", "porf_gc_collect(0);")
      .replace(
        "  porf_c_stack_top = prev_stack_top;",
        `  // The mark queue is empty after collection; its capacity is scratch, not live roots.
  if (porf_gc_mark_queue_len == 0 && porf_gc_mark_queue_cap > 4096) {
    free(porf_gc_mark_queue);
    porf_gc_mark_queue = NULL;
    porf_gc_mark_queue_cap = 0;
  }
  porf_c_stack_top = prev_stack_top;`,
      );
    const needs = `int porf_native_fetch_needs_quiet_collect(void) {
\${gcEnabled ? '  return porf_heap_base != 0 && ((u64)porf_heap_top - (u64)porf_heap_base > 8ull * 1024ull * 1024ull || porf_gc_mark_queue_cap > 65536);' : '  return 0;'}
}
`;
    render =
      render.slice(0, end) +
      "\n" +
      marker +
      "\n" +
      needs +
      quiet +
      render.slice(end);
  }
  if (!shim.includes(marker)) {
    const declaration =
      "void porf_native_fetch_collect_normal_from(void* stack_top);";
    const start = shim.indexOf("static void collect_after_request(void) {");
    const end = shim.indexOf("\n}\n", start);
    if (!shim.includes(declaration) || start < 0 || end < 0)
      throw new Error("Porffor quiet-GC native shim anchor missing");
    const original = shim.slice(start, end);
    if (
      !original.includes(
        "porf_native_fetch_collect_normal_from((void*)&porf_stack_anchor);",
      )
    )
      throw new Error("Porffor normal request collection changed");
    const timer = `${marker}
static us_timer_t* sb_quiet_gc_timer = nullptr;
static void sb_collect_quiet(struct us_timer_t*) {
  volatile int stack_anchor = 0;
  porf_native_fetch_collect_quiet_from((void*)&stack_anchor);
}
`;
    // Preserve normal request collection unconditionally; only the extra timer is guarded.
    const schedule = `
  if (porf_native_fetch_needs_quiet_collect()) {
    if (!sb_quiet_gc_timer) sb_quiet_gc_timer = us_create_timer((struct us_loop_t*)uWS::Loop::get(), 0, 0);
    if (sb_quiet_gc_timer) us_timer_set(sb_quiet_gc_timer, sb_collect_quiet, 500, 0);
  }`;
    shim = shim.slice(0, start) + timer + original + schedule + shim.slice(end);
    shim = shim.replace(
      declaration,
      declaration +
        "\nvoid porf_native_fetch_collect_quiet_from(void* stack_top);\nint porf_native_fetch_needs_quiet_collect(void);",
    );
  }
  await Promise.all([writeFile(renderFile, render), writeFile(shimFile, shim)]);
}

/**
 * Apply every patch to a Porffor checkout at `root` (the directory that holds
 * `compiler/` and `runtime/`). Idempotent per process and per marker, so it is
 * safe to call on every build. Callers pass an explicit root — `ensurePorffor`
 * right after extraction, the compile path against its resolved checkout.
 */
const RESPONSE_DEFAULTS_MARKER =
  "// sproutboat: Fetch default content type for text bodies";
const RESPONSE_DEFAULTS_ANCHOR =
  "class Response {\n  constructor(body = null, init = undefined) {\n    this.body = body;\n    this.status = Number(init?.status ?? 200);\n    this.headers = new Headers(init?.headers);\n";

/**
 * Fetch's extract-a-body step gives a string body `text/plain;charset=UTF-8` unless the
 * caller set a content type (workerd does). Porffor's Response sent none, so
 * `new Response("hi")` reached clients untyped.
 */
export async function patchResponseDefaults(root: string): Promise<void> {
  const file = resolve(root, "runtime/fetch-globals.js");
  const src = await readFile(file, "utf8");
  if (src.includes(RESPONSE_DEFAULTS_MARKER)) return;
  if (!src.includes(RESPONSE_DEFAULTS_ANCHOR))
    throw new Error(
      `could not patch Porffor's Response defaults: anchor not found in ${file}`,
    );
  await writeFile(
    file,
    src.replace(
      RESPONSE_DEFAULTS_ANCHOR,
      RESPONSE_DEFAULTS_ANCHOR +
        `    ${RESPONSE_DEFAULTS_MARKER}\n` +
        "    if (typeof body === 'string' && !this.headers.has('content-type')) this.headers.set('content-type', 'text/plain;charset=UTF-8');\n",
    ),
  );
}

const URL_CLASS_START = "class URL {\n  constructor(input) {\n";
const URL_CLASS_END = "\nclass Request {";
const URL_CLASS_MARKER = "sproutboat: WHATWG-style URL";

/**
 * Replaces Porffor's URL (href, origin, pathname and search only; no base argument, no
 * setters but pathname, no hash) with the WHATWG-style class in url-class.ts.
 */
export async function patchURLClass(root: string): Promise<void> {
  const file = resolve(root, "runtime/fetch-globals.js");
  const src = await readFile(file, "utf8");
  if (src.includes(URL_CLASS_MARKER)) return;
  const start = src.indexOf(URL_CLASS_START);
  const end = start === -1 ? -1 : src.indexOf(URL_CLASS_END, start);
  if (end === -1)
    throw new Error(`could not patch Porffor's URL: anchor not found in ${file}`);
  await writeFile(file, src.slice(0, start) + URL_CLASS_SOURCE + src.slice(end + 1));
}

const HEADERS_ARRAY_ANCHOR =
  "    if (Porffor.type(init.entries) == Porffor.TYPES.function) {\n      this._entries = Porffor.array.new(8);\n      for (const entry of init.entries()) {";
const HEADERS_ARRAY_INJECT =
  "    if (!Array.isArray(init) && Porffor.type(init.entries) == Porffor.TYPES.function) {\n      this._entries = Porffor.array.new(8);\n      for (const entry of init.entries()) {";

/**
 * `new Headers([["a", "1"]])`: arrays also have entries() (yielding [index, pair]), and
 * Porffor checked that first, so a list of pairs became headers named "0", "1"...
 * Arrays now reach the sequence branch below it.
 */
export async function patchHeadersArrayInit(root: string): Promise<void> {
  const file = resolve(root, "runtime/fetch-globals.js");
  const src = await readFile(file, "utf8");
  if (src.includes(HEADERS_ARRAY_INJECT) || src.includes("sproutboat: Fetch-spec Headers")) return;
  if (!src.includes(HEADERS_ARRAY_ANCHOR))
    throw new Error(
      `could not patch Porffor's Headers array init: anchor not found in ${file}`,
    );
  await writeFile(
    file,
    src.replace(HEADERS_ARRAY_ANCHOR, HEADERS_ARRAY_INJECT),
  );
}

// baronunread/sproutboat#286: Map.groupBy is missing (Object.groupBy exists). Same
// shape as __Object_groupBy, keyed by SameValueZero through the Map itself.
const MAP_GROUPBY_MARKER = "sproutboat #286: Map.groupBy";
const MAP_GROUPBY_SOURCE =
  "\n// sproutboat #286: Map.groupBy\n" +
  "export const __Map_groupBy = (items: any, callbackFn: any): Map => {\n" +
  "  const out: Map = __Porffor_hashtableNew(true);\n" +
  "  Porffor.IR.gcBarrier(out, Porffor.TYPES.map);\n" +
  "  let i: i32 = 0;\n" +
  "  for (const x of items) {\n" +
  "    const k: any = callbackFn(x, i++);\n" +
  "    if (!Porffor.callThis(__Map_prototype_has, out, k)) Porffor.callThis(__Map_prototype_set, out, k, Porffor.array.new(4));\n" +
  "    Porffor.array.fastPush(Porffor.callThis(__Map_prototype_get, out, k), x);\n" +
  "  }\n" +
  "  return out;\n" +
  "};\n";

/** #286: add Map.groupBy. Before the precompile, which compiles it with the other builtins. */
export async function patchMapGroupBy(root: string): Promise<void> {
  const file = resolve(root, "compiler/builtins/map.ts");
  const src = await readFile(file, "utf8");
  if (src.includes(MAP_GROUPBY_MARKER)) return;
  if (!src.includes("export const Map = function (iterable: any): Map {"))
    throw new Error(`could not patch Porffor's Map.groupBy: anchor not found in ${file}`);
  if (src.includes("export const __Map_groupBy"))
    throw new Error(`Porffor now defines Map.groupBy itself: drop patchMapGroupBy (${file})`);
  await writeFile(file, src.trimEnd() + "\n" + MAP_GROUPBY_SOURCE);
}

// baronunread/sproutboat#286: a private field (#x) is stored as an ordinary property
// named "__#x", installed like a public field, so Object.keys, for-in and
// JSON.stringify listed it. Install private fields the way methods are installed:
// writable and configurable but not enumerable. Object.getOwnPropertyNames still
// sees the internal name.
const PRIVATE_FIELD_MARKER = "sproutboat #286: private fields";
const PRIVATE_FIELD_EDITS: [string, string][] = [
  [
    "        builtinCall(func, '__Porffor_object_class_value', [\n",
    "        // sproutboat #286: private fields are not enumerable\n" +
      "        builtinCall(func, x.key?.type === 'PrivateIdentifier' ? '__Porffor_object_class_method' : '__Porffor_object_class_value', [\n",
  ],
  [
    "      if (kind === 'get' || kind === 'set') initKind = kind;\n",
    "      if (kind === 'get' || kind === 'set') initKind = kind;\n" +
      "      if (initKind === 'value' && x.key?.type === 'PrivateIdentifier') initKind = 'method'; // sproutboat #286: private fields\n",
  ],
];

export async function patchPrivateFieldsHidden(root: string): Promise<void> {
  const file = resolve(root, "compiler/codegen.js");
  let src = await readFile(file, "utf8");
  if (src.includes(PRIVATE_FIELD_MARKER)) return;
  for (const [anchor, inject] of PRIVATE_FIELD_EDITS) {
    if (src.split(anchor).length !== 2)
      throw new Error(`could not patch Porffor's private fields: anchor not found in ${file}`);
    src = src.replace(anchor, inject);
  }
  await writeFile(file, src);
}

// baronunread/sproutboat#287 (sproutd B9/B13): native-fetch mode runs frequent full
// collections, and each returned its free pages to the OS (porf_gc_discard_free_runs),
// so the next large allocation faulted them back in: allocation-heavy handlers ran up
// to 4x slower than plain Porffor. Full collections under load now keep their free
// pages, and the idle quiet collection returns them. The idle gate also opens when
// anything was claimed or promoted since the last full collection, so a small sprout
// that never reaches the 16 MiB / 8 MiB full-collection triggers still gives back its
// promoted garbage. Same edits as sproutd's deferred discard and idle return.
const DEFERRED_DISCARD_MARKER = "static i32 porf_gc_discard_pending = 0;";
const DEFERRED_DISCARD_EDITS: [string, string][] = [
  [
    "static i32 porf_gc_mark_queue_cap = 0;",
    "static i32 porf_gc_mark_queue_cap = 0;\n// sproutboat #287: discard free runs only in the idle collection\nstatic i32 porf_gc_discard_now = 0;\n" +
      DEFERRED_DISCARD_MARKER,
  ],
  [
    "    porf_gc_discard_free_runs();\n",
    "    if (porf_gc_discard_now) porf_gc_discard_free_runs(); else porf_gc_discard_pending = 1;\n",
  ],
  [
    "porf_gc_mark_queue_cap > 65536);' : '  return 0;'",
    "porf_gc_mark_queue_cap > 65536 || porf_gc_discard_pending || porf_gc_claimed_since_full > 0 || porf_gc_promoted_since_full > 0);' : '  return 0;'",
  ],
  [
    "  porf_c_stack_top = stack_top;\n  porf_gc_collect(0);\n  // The mark queue is empty",
    "  porf_c_stack_top = stack_top;\n  porf_gc_discard_now = 1;\n  porf_gc_collect(0);\n  porf_gc_discard_now = 0;\n  porf_gc_discard_pending = 0;\n  // The mark queue is empty",
  ],
];

/** #287: deferred discard and idle return. After patchQuietCollection, which adds the quiet collector. */
export async function patchDeferredDiscard(root: string): Promise<void> {
  const file = resolve(root, "compiler/render.js");
  let src = await readFile(file, "utf8");
  if (src.includes(DEFERRED_DISCARD_MARKER)) return;
  for (const [anchor, inject] of DEFERRED_DISCARD_EDITS) {
    if (src.split(anchor).length !== 2)
      throw new Error(`could not patch Porffor's deferred discard: anchor not found in ${file}`);
    src = src.replace(anchor, inject);
  }
  await writeFile(file, src);
}

// sproutd B16: String.prototype.repeat copied the source once per repetition, so
// "ab".repeat(300000) made 300,000 two-byte copies (about 60 MB/s; a proof fixture
// spent 64% of its load time here). Copy once, then double the filled prefix onto
// itself: log2(count) copies. Same for the UTF-16 and Latin-1 variants, which
// share the loop text.
const REPEAT_LOOP =
  "  for (let i: i32 = 0; i < count; i++) {\n" +
  "    Porffor.IR.copy(Porffor.IR.ptr(out) + 4 + i * thisLen, Porffor.IR.ptr(this) + 4, thisLen);\n" +
  "  }\n";
const REPEAT_MARKER = "sproutboat B16: doubling repeat";
const REPEAT_DOUBLING =
  "  // sproutboat B16: doubling repeat\n" +
  "  const total: i32 = thisLen * count;\n" +
  "  if (total > 0) {\n" +
  "    Porffor.IR.copy(Porffor.IR.ptr(out) + 4, Porffor.IR.ptr(this) + 4, thisLen);\n" +
  "    let filled: i32 = thisLen;\n" +
  "    while (filled * 2 <= total) {\n" +
  "      Porffor.IR.copy(Porffor.IR.ptr(out) + 4 + filled, Porffor.IR.ptr(out) + 4, filled);\n" +
  "      filled *= 2;\n" +
  "    }\n" +
  "    if (filled < total) Porffor.IR.copy(Porffor.IR.ptr(out) + 4 + filled, Porffor.IR.ptr(out) + 4, total - filled);\n" +
  "  }\n";

/** B16: doubling String.prototype.repeat. Before the precompile, which compiles it. */
export async function patchRepeatDoubling(root: string): Promise<void> {
  const file = resolve(root, "compiler/builtins/string.ts");
  const src = await readFile(file, "utf8");
  if (src.includes(REPEAT_MARKER)) return;
  if (src.split(REPEAT_LOOP).length !== 3)
    throw new Error(`could not patch Porffor's String.prototype.repeat: anchor not found twice in ${file}`);
  await writeFile(file, src.replaceAll(REPEAT_LOOP, REPEAT_DOUBLING));
}

// JSON.stringify of a cyclic object recursed until the native stack overflowed: the
// process died (SIGBUS/SIGSEGV) instead of throwing, so one request could take a
// worker down (found by the W2 conformance suite). The replacer path already checks
// cycles; the plain serializer now keeps its own ancestor stack and throws the same
// TypeError. Arrays and objects push on entry and pop on exit; JSON.stringify clears
// the stack first, so a throw mid-serialization leaves nothing behind.
const JSON_CYCLE_MARKER = "sproutboat: JSON cycle check";
const JSON_CYCLE_EDITS: [string, string, number][] = [
  [
    "let __Porffor_json_bufLimit: i32 = 0;\n",
    "let __Porffor_json_bufLimit: i32 = 0;\n" +
      "// sproutboat: JSON cycle check\n" +
      "let __Porffor_json_ancestors: any = 0;\n" +
      "export const __Porffor_json_enter = (value: any): void => {\n" +
      "  if (__Porffor_json_ancestors === 0) __Porffor_json_ancestors = Porffor.array.new(8);\n" +
      "  const stack: any[] = __Porffor_json_ancestors;\n" +
      "  if (stack.includes(value)) {\n" +
      "    stack.length = 0;\n" +
      "    throw new TypeError('Converting circular structure to JSON');\n" +
      "  }\n" +
      "  Porffor.array.fastPush(stack, value);\n" +
      "};\n" +
      "export const __Porffor_json_leave = (): void => {\n" +
      "  const stack: any[] = __Porffor_json_ancestors;\n" +
      "  stack.length = stack.length - 1;\n" +
      "};\n",
    1,
  ],
  ["    depth += 1;\n", "    depth += 1;\n    __Porffor_json_enter(value);\n", 2],
  ["    depth -= 1;\n", "    __Porffor_json_leave();\n    depth -= 1;\n", 2],
  [
    "  let out: i32 = __Porffor_json_serialize(buffer, value, 0, space);\n",
    "  if (__Porffor_json_ancestors !== 0) (__Porffor_json_ancestors as any[]).length = 0;\n" +
      "  let out: i32 = __Porffor_json_serialize(buffer, value, 0, space);\n",
    1,
  ],
];

/** JSON.stringify throws on cycles instead of overflowing the stack. Before the precompile. */
export async function patchJsonCycles(root: string): Promise<void> {
  const file = resolve(root, "compiler/builtins/json.ts");
  let src = await readFile(file, "utf8");
  if (src.includes(JSON_CYCLE_MARKER)) return;
  for (const [anchor, inject, count] of JSON_CYCLE_EDITS) {
    if (src.split(anchor).length !== count + 1)
      throw new Error(`could not patch Porffor's JSON cycle check: anchor not found ${count}x in ${file}`);
    src = src.replaceAll(anchor, inject);
  }
  await writeFile(file, src);
}

// Object.prototype.toString gave "[object Object]" for typed arrays: their lazily
// built prototypes have no toStringTag, and the fallback list of builtin tags left
// them out (W2 conformance; V8 gives "[object Uint8Array]").
const TA_TAG_MARKER = "sproutboat: typed array toStringTag";
const TA_TAG_ANCHOR = "  return '[object ' + builtinTag + ']';\n};\n";
const TA_TAG_INJECT =
  "  // sproutboat: typed array toStringTag\n" +
  "  if (Porffor.fastAnd(tag === undefined, t >= Porffor.TYPES.uint8clampedarray, t <= Porffor.TYPES.float64array)) {\n" +
  "    if (t == Porffor.TYPES.uint8clampedarray) builtinTag = 'Uint8ClampedArray';\n    else if (t == Porffor.TYPES.uint8array) builtinTag = 'Uint8Array';\n    else if (t == Porffor.TYPES.int8array) builtinTag = 'Int8Array';\n    else if (t == Porffor.TYPES.uint16array) builtinTag = 'Uint16Array';\n    else if (t == Porffor.TYPES.int16array) builtinTag = 'Int16Array';\n    else if (t == Porffor.TYPES.uint32array) builtinTag = 'Uint32Array';\n    else if (t == Porffor.TYPES.int32array) builtinTag = 'Int32Array';\n    else if (t == Porffor.TYPES.biguint64array) builtinTag = 'BigUint64Array';\n    else if (t == Porffor.TYPES.bigint64array) builtinTag = 'BigInt64Array';\n    else if (t == Porffor.TYPES.float32array) builtinTag = 'Float32Array';\n    else if (t == Porffor.TYPES.float64array) builtinTag = 'Float64Array';\n" +
  "  }\n" +
  TA_TAG_ANCHOR;

/** Typed arrays get their own toString tag. Before the precompile. */
export async function patchTypedArrayTag(root: string): Promise<void> {
  const file = resolve(root, "compiler/builtins/object.ts");
  const src = await readFile(file, "utf8");
  if (src.includes(TA_TAG_MARKER)) return;
  if (src.split(TA_TAG_ANCHOR).length !== 2)
    throw new Error(`could not patch Porffor's typed array toStringTag: anchor not found in ${file}`);
  await writeFile(file, src.replace(TA_TAG_ANCHOR, TA_TAG_INJECT));
}

// console.log coloured numbers, booleans and objects with ANSI escapes even when
// stdout was a file or pipe, so sproutd's per-app logs (B21) and piped sprout output
// were full of \x1b[33m. Colour only when stdout is a terminal, as Node and Bun do.
const CONSOLE_COLOR_MARKER = "sproutboat: console colours only on a terminal";
const CONSOLE_COLOR_ANCHOR = "export const __Porffor_consolePrint = (arg: any): void => {\n";
const CONSOLE_COLOR_PRINT = "  __Porffor_print(arg);\n};\n";
const CONSOLE_COLOR_HELPER =
  "// sproutboat: console colours only on a terminal\n" +
  "let __Porffor_console_tty: i32 = -1;\n" +
  "export const __Porffor_consoleColors = (): boolean => {\n" +
  "  if (__Porffor_console_tty < 0) {\n" +
  "    let tty: i32 = 0;\n" +
  "    Porffor.c`tty = isatty(1) ? 1 : 0;`;\n" +
  "    __Porffor_console_tty = tty;\n" +
  "  }\n" +
  "  return __Porffor_console_tty == 1;\n" +
  "};\n\n";

/** console colours only when stdout is a terminal. Before the precompile. */
export async function patchConsoleColors(root: string): Promise<void> {
  const file = resolve(root, "compiler/builtins/console.ts");
  let src = await readFile(file, "utf8");
  if (src.includes(CONSOLE_COLOR_MARKER)) return;
  const at = src.indexOf(CONSOLE_COLOR_ANCHOR);
  const print = at < 0 ? -1 : src.indexOf(CONSOLE_COLOR_PRINT, at);
  if (at < 0 || print < 0 || src.split(CONSOLE_COLOR_ANCHOR).length !== 2)
    throw new Error(`could not patch Porffor's console colours: anchor not found in ${file}`);
  src =
    src.slice(0, at) + CONSOLE_COLOR_HELPER + src.slice(at, print) +
    "  __Porffor_print(arg, __Porffor_consoleColors());\n};\n" + src.slice(print + CONSOLE_COLOR_PRINT.length);
  await writeFile(file, src);
}

const TEXT_DECODER_MARKER = "sproutboat: WHATWG UTF-8 decoder";
/** Replaces Porffor's TextDecoder (text-decoder.ts). After patchURLClass, whose class ends it. */
export async function patchTextDecoder(root: string): Promise<void> {
  const file = resolve(root, "runtime/fetch-globals.js");
  const src = await readFile(file, "utf8");
  if (src.includes(TEXT_DECODER_MARKER)) return;
  const start = src.indexOf("class TextDecoder {");
  const end = start < 0 ? -1 : src.indexOf("\nclass URL {", start);
  if (start < 0 || end < 0 || src.indexOf("class TextDecoder {", start + 1) >= 0)
    throw new Error(`could not patch Porffor's TextDecoder: anchor not found in ${file}`);
  await writeFile(file, src.slice(0, start) + TEXT_DECODER_SOURCE + src.slice(end));
}

// String.prototype.toLowerCase/toUpperCase mapped ASCII only ("todo: unicode" upstream), so
// "ÄÖÜ", Greek and Cyrillic came back unchanged, and URL hosts lowercased wrongly (W2).
// Simple one-to-one BMP mappings from case-map.ts, looked up by binary search for units
// >= 128. Latin-1 strings keep their own range (À-Þ, à-þ); one-to-many special casing
// (ß to SS) and Latin-1 µ/ÿ uppercase (which leave Latin-1) are not handled.
const CASE_MARKER = "sproutboat: Unicode case mapping";
const caseLiteral = (runs: string) =>
  "'" + Array.from(runs, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join("") + "'";
const CASE_HELPERS =
  "// sproutboat: Unicode case mapping\n" +
  "export const __Porffor_caseFind = (chr: i32, runs: string): i32 => {\n" +
  "  let lo: i32 = 0, hi: i32 = runs.length / 4 - 1, found: i32 = -1;\n" +
  "  while (lo <= hi) {\n" +
  "    const mid: i32 = (lo + hi) >> 1;\n" +
  "    if (runs.charCodeAt(mid * 4) <= chr) { found = mid; lo = mid + 1; } else hi = mid - 1;\n" +
  "  }\n" +
  "  if (found < 0) return chr;\n" +
  "  const start: i32 = runs.charCodeAt(found * 4);\n" +
  "  if (chr > runs.charCodeAt(found * 4 + 1)) return chr;\n" +
  "  if ((chr - start) % runs.charCodeAt(found * 4 + 3) != 0) return chr;\n" +
  "  return runs.charCodeAt(found * 4 + 2) + (chr - start);\n" +
  "};\n" +
  "export const __Porffor_caseLower = (chr: i32): i32 => __Porffor_caseFind(chr, " + caseLiteral(CASE_LOWER_RUNS) + ");\n" +
  "export const __Porffor_caseUpper = (chr: i32): i32 => __Porffor_caseFind(chr, " + caseLiteral(CASE_UPPER_RUNS) + ");\n\n";
const CASE_EDITS: [string, string][] = [
  ["    if (chr >= 97) if (chr <= 122) chr -= 32;\n\n    Porffor.IR.storeU16(j, 4, chr);",
   "    if (chr < 128) { if (chr >= 97) if (chr <= 122) chr -= 32; } else chr = __Porffor_caseUpper(chr);\n\n    Porffor.IR.storeU16(j, 4, chr);"],
  ["    if (chr >= 65) if (chr <= 90) chr += 32;\n\n    Porffor.IR.storeU16(j, 4, chr);",
   "    if (chr < 128) { if (chr >= 65) if (chr <= 90) chr += 32; } else chr = __Porffor_caseLower(chr);\n\n    Porffor.IR.storeU16(j, 4, chr);"],
  ["    if (chr >= 97) if (chr <= 122) chr -= 32;\n\n    Porffor.IR.storeU8(j++, 4, chr);",
   "    if (chr >= 97) { if (chr <= 122) chr -= 32; else if (chr >= 224) if (chr <= 254) if (chr != 247) chr -= 32; }\n\n    Porffor.IR.storeU8(j++, 4, chr);"],
  ["    if (chr >= 65) if (chr <= 90) chr += 32;\n\n    Porffor.IR.storeU8(j++, 4, chr);",
   "    if (chr >= 65) { if (chr <= 90) chr += 32; else if (chr >= 192) if (chr <= 222) if (chr != 215) chr += 32; }\n\n    Porffor.IR.storeU8(j++, 4, chr);"],
];

/** Unicode simple case mapping for toLowerCase/toUpperCase. Before the precompile. */
export async function patchCaseMapping(root: string): Promise<void> {
  const file = resolve(root, "compiler/builtins/string.ts");
  let src = await readFile(file, "utf8");
  if (src.includes(CASE_MARKER)) return;
  const at = src.indexOf("export const __String_prototype_toUpperCase = function (this: string) {");
  if (at < 0) throw new Error(`could not patch Porffor's case mapping: anchor not found in ${file}`);
  for (const [anchor, inject] of CASE_EDITS) {
    if (src.split(anchor).length !== 2) throw new Error(`could not patch Porffor's case mapping: anchor not found in ${file}`);
    src = src.replace(anchor, inject);
  }
  await writeFile(file, src.slice(0, at) + CASE_HELPERS + src.slice(at));
}

const HEADERS_CLASS_MARKER = "sproutboat: Fetch-spec Headers";
/** Replaces Porffor's Headers (headers-class.ts), which also covers patchHeadersArrayInit's fix. */
export async function patchHeadersClass(root: string): Promise<void> {
  const file = resolve(root, "runtime/fetch-globals.js");
  const src = await readFile(file, "utf8");
  if (src.includes(HEADERS_CLASS_MARKER)) return;
  const start = src.indexOf("class Headers {");
  const end = start < 0 ? -1 : src.indexOf("\nfunction setTimeout(", start);
  if (start < 0 || end < 0) throw new Error(`could not patch Porffor's Headers: anchor not found in ${file}`);
  await writeFile(file, src.slice(0, start) + HEADERS_CLASS_SOURCE + src.slice(end));
}

// setTimeout(fn, 0) never fired on Linux: uSockets arms timers with timerfd_settime, where
// a zero first expiry disarms the timer (kqueue on macOS fires it at once). The same held
// for setInterval(fn, 0), which also lost its repeat. Arm at least 1 ms.
const ZERO_TIMER_ANCHOR =
  "  porf_native_fetch_timer_start(id, (i32)delay_ms, timer->repeat ? (i32)delay_ms : 0);";
const ZERO_TIMER_INJECT =
  "  porf_native_fetch_timer_start(id, delay_ms < 1 ? 1 : (i32)delay_ms, timer->repeat ? (delay_ms < 1 ? 1 : (i32)delay_ms) : 0); /* sproutboat: zero-delay timers fire on Linux */";

/** Zero-delay timers are armed at 1 ms, since a zero timerfd expiry disarms them. */
export async function patchZeroDelayTimers(root: string): Promise<void> {
  const file = resolve(root, "compiler/render.js");
  const src = await readFile(file, "utf8");
  if (src.includes("sproutboat: zero-delay timers fire on Linux")) return;
  if (src.split(ZERO_TIMER_ANCHOR).length !== 2)
    throw new Error(`could not patch Porffor's zero-delay timers: anchor not found in ${file}`);
  await writeFile(file, src.replace(ZERO_TIMER_ANCHOR, ZERO_TIMER_INJECT));
}

/**
 * True when root is a finished cache entry that this toolchain version patched
 * (ensurePorffor patches before it writes the manifest). The CLI calls
 * ensurePorfforPatched on every compile: re-running the patch chain there cost
 * ~1.3 s per build, and its precompile rewrote builtins_precompiled.js in place,
 * so parallel builds sharing the cache could import a half-written table.
 */
async function patchedByThisVersion(root: string): Promise<boolean> {
  try {
    // SAFETY: private manifest written by ensurePorffor; only two fields are read.
    const manifest = JSON.parse(await readFile(resolve(root, ".sproutboat-complete"), "utf8")) as {
      commit?: string;
      toolchainVersion?: string;
    };
    return manifest.commit === PORFFOR_COMMIT_FULL && manifest.toolchainVersion === TOOLCHAIN_VERSION;
  } catch {
    return false;
  }
}

export async function ensurePorfforPatched(root: string): Promise<void> {
  if (done.has(root)) return;
  if (await patchedByThisVersion(root)) {
    done.add(root);
    return;
  }
  await patchCompilerArgs(root);
  await patchClassSelfName(root);
  await patchUwebsockets(root);
  await patchRenderJs(root);
  await patchQuietCollection(root);
  await patchDeferredDiscard(root);
  await patchDateParser(root);
  await patchPromiseResolveNull(root);
  await patchReplaceAll(root);
  await patchLocalFunctionTypes(root);
  await patchUint8ArrayBase64(root);
  await patchResponseDefaults(root);
  await patchHeadersArrayInit(root);
  await patchHeadersClass(root);
  await patchURLClass(root);
  await patchTextDecoder(root);
  await patchMapGroupBy(root);
  await patchPrivateFieldsHidden(root);
  await patchRepeatDoubling(root);
  await patchJsonCycles(root);
  await patchTypedArrayTag(root);
  await patchConsoleColors(root);
  await patchCaseMapping(root);
  await patchZeroDelayTimers(root);
  // Last of the builtin edits: its precompile picks up the date, promise and
  // replaceAll patches above too.
  await precompileBuiltins(root);
  await patchUnicode(root);
  done.add(root);
}
