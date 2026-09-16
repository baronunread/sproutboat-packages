/**
 * Idempotent, marker-guarded in-place edits to Porffor's generated C
 * (`compiler/render.js`, `compiler/index.js`, `compiler/uwebsockets.js`). Run
 * from the build path, not a `postinstall` hook: package managers block
 * dependency lifecycle scripts by default, so a published `postinstall` would
 * silently not run.
 *
 * Each edit is independent and re-applied on every build; a file patched by an
 * older version of this module still receives the newer edits. All of them are
 * tracked in patches/UPSTREAM.md and go away as Porffor closes the gaps.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

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
 * render.js full-block replacements: `[marker, anchor, inject, what]`, each a
 * complete swap of the matched region (unlike `RENDER_EDITS`, which only ever
 * inserts after its anchor).
 */
const RENDER_REPLACEMENTS = [
  [BYTESTRING_MARKER, BYTESTRING_ANCHOR, BYTESTRING_INJECT, "bytestring UTF-8 encoding (#172)"],
  [READ_RAW_MARKER, READ_RAW_ANCHOR, READ_RAW_INJECT, "raw bytestring passthrough function (#176)"],
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
const LINK_ANCHOR = "          uSocketsArchive,\n          '-lm'\n";
const LINK_INJECT =
  "          ...(process.env.SB_EXTRA_LINK ? process.env.SB_EXTRA_LINK.split(' ').filter(Boolean) : []),\n";
const LINK_MARKER = "SB_EXTRA_LINK";

/**
 * #15 — and the same for the compile step, so the prelude's inline C can
 * `#include <bearssl.h>`. The link patch alone is not enough: Porffor compiles
 * the generated C from stdin with a fixed argument list, so there is otherwise
 * no way to add an include path.
 */
const CFLAGS_ANCHOR = "          '-xc', '-', '-c',\n";
const CFLAGS_INJECT =
  "          ...(process.env.SB_EXTRA_CFLAGS ? process.env.SB_EXTRA_CFLAGS.split(' ').filter(Boolean) : []),\n";
const CFLAGS_MARKER = "SB_EXTRA_CFLAGS";

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

const done = new Set<string>();

/** Edits to Porffor's uWebSockets shim: `[marker, anchor, inject, what]`. */
const UWS_EDITS = [
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
] as const;

/** The uWebSockets shim source: body limit + the #156 status-line fix. Exported for tests. */
export async function patchUwebsockets(root: string): Promise<void> {
  const file = resolve(root, "compiler/uwebsockets.js");
  let src = await readFile(file, "utf8");
  let changed = false;
  for (const [marker, anchor, inject, what] of UWS_EDITS) {
    if (src.includes(marker)) continue;
    if (!src.includes(anchor)) {
      throw new Error(
        `could not patch Porffor's ${what}: anchor not found in ${file}. ` +
          "Porffor's uWebSockets shim changed — check patches/UPSTREAM.md.",
      );
    }
    src = src.replace(anchor, inject);
    changed = true;
  }
  if (changed) await writeFile(file, src);
}

async function patchCompilerArgs(root: string): Promise<void> {
  const file = resolve(root, "compiler/index.js");
  let src = await readFile(file, "utf8");
  let changed = false;
  for (const [marker, anchor, inject, what] of [
    [LINK_MARKER, LINK_ANCHOR, LINK_INJECT, "extra link args"],
    [CFLAGS_MARKER, CFLAGS_ANCHOR, CFLAGS_INJECT, "extra compiler flags"],
  ] as const) {
    if (src.includes(marker)) continue;
    const at = src.indexOf(anchor);
    if (at === -1) {
      throw new Error(
        `could not patch Porffor for ${what}: anchor not found in ${file}. ` +
          "Porffor's native-fetch build changed — check patches/UPSTREAM.md.",
      );
    }
    // After the anchor for cflags (the args follow it), before it for the link
    // line (the object list ends with it).
    src =
      marker === CFLAGS_MARKER
        ? src.slice(0, at + anchor.length) + inject + src.slice(at + anchor.length)
        : src.slice(0, at) + inject + src.slice(at);
    changed = true;
  }
  if (changed) await writeFile(file, src);
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
          "Porffor's native-fetch renderer changed — check patches/UPSTREAM.md.",
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
          "Porffor's native-fetch renderer changed — check patches/UPSTREAM.md.",
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
  await patchUwebsockets(root);
  await patchRenderJs(root);
  done.add(root);
}
