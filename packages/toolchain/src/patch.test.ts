import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_BINDINGS, wrapNativeFetchHandler } from "../../runtime/src/wrap";
import {
  patchHeadersArrayInit,
  patchLocalFunctionTypes,
  patchFunctionSourcesScan,
  patchDeferredDiscard,
  patchGcFootprint,
  patchIdleTrim,
  patchRepeatDoubling,
  patchConsoleColors,
  patchCaseMapping,
  patchZeroDelayTimers,
  patchStreamingResponses,
  patchAsyncWaker,
  patchSplitGlobals,
  patchMacroNames,
  patchTypedArrayShadow,
  patchCallArgOrder,
  patchNavigatorWritable,
  patchGlobalThisSync,
  patchBlobClass,
  patchFetchClasses,
  patchResponseBytes,
  patchHeadersClass,
  patchTextDecoder,
  patchResponseDefaults,
  patchURLClass,
  patchRenderJs,
  patchUwebsockets,
} from "./patch";

// The parts of Porffor's compiler/render.js the patch anchors to.
const RENDER = `void porf_native_fetch_runtime_init(void) {
#ifdef _WIN32
  exit(1);
#else
  signal(SIGPIPE, SIG_IGN);
  porf_init(0, NULL);
#endif
}

f64 porf_native_fetch_get_port(void) {
  return __porffor_native_fetch_port.val;
}

int porf_native_fetch_read_value(jsval value, const char** out_buf, size_t* out_len, char** out_owned) {
  if (!out_buf || !out_len || !out_owned) return -1;

  *out_buf = NULL;
  *out_len = 0;
  *out_owned = NULL;

  if (value.type == \${TYPES.bytestring}) {
    const u32 ptr = (u32)value.val;
    *out_buf = (const char*)(MEM + ptr + 4);
    *out_len = (size_t)*(u32*)(MEM + ptr);
    return 0;
  }

  return -1;
}

#define PORF_CORO_MAX 16384
`;

// Porffor's compiler/uwebsockets.js, trimmed to the parts the patch touches:
// body limit (#56), the #156 status-line switch, #163's collect_headers, and
// #176's read_value forward decl / is_forbidden_response_header /
// write_response_value.
const SHIM = `export const makeUWebSocketsShimSource = () => \`
#include "App.h"
static const size_t REQUEST_BODY_MAX_BYTES = 1024u * 1024u;

int porf_native_fetch_read_value(struct jsval value, const char** out_buf, size_t* out_len, char** out_owned);

static std::string_view lookup_status_line(i32 status) {
  switch (status) {
    case 200: return "200 OK";
    case 302: return "302 Found";
    case 429: return "429 Too Many Requests";
    default: return {};
  }
}

static i32 collect_headers(uWS::HttpRequest* req) {
  i32 header_capacity = 0;
  for (auto [key, value] : *req) {
    (void)key;
    (void)value;
    header_capacity += 2;
  }
  const i32 header_bytes = 16 + header_capacity * 8;
  const i32 headers_ptr = (i32)porf_native_fetch_alloc((u32)header_bytes, 208);
  const i32 entries_ptr = headers_ptr + 16;
  i32 slot = 0;
  for (auto [key, value] : *req) {
    *((u64*)(porf_mem + entries_ptr + slot * 8)) = pack_bytestring((i32)porf_native_fetch_alloc_bytestring(key.data(), key.size()));
    slot++;
    *((u64*)(porf_mem + entries_ptr + slot * 8)) = pack_bytestring((i32)porf_native_fetch_alloc_bytestring(value.data(), value.size()));
    slot++;
  }
  *((i32*)(porf_mem + headers_ptr)) = slot;

  return headers_ptr;
}

static void on_request(uWS::HttpResponse<false>* res, uWS::HttpRequest* req) {
  const std::string_view method = req->getCaseSensitiveMethod();
  const i32 method_ptr = get_method_ptr(method);
  if (method_ptr == 0) return;
  __porffor_js_enter();
  const i32 url_ptr = alloc_request_url(req);
  const i32 headers_ptr = collect_headers(req);
}

static bool is_forbidden_response_header(std::string_view key) {
  return key == "connection" ||
         key == "content-length" ||
         key == "transfer-encoding";
}

static void write_response_value(uWS::HttpResponse<false>* res, struct jsval response, bool* aborted) {
  struct NativeFetchResponseParts response_parts;
  porf_native_fetch_finalize_response(response.val, response.type, &response_parts);
  const i32 status = response_parts.status;
  const struct jsval body_value = response_parts.body;
  const i32 headers_entries_ptr = (i32)response_parts.headers.val;

  const char* body_buf = nullptr;
  size_t body_len = 0;
  char* body_owned = nullptr;
  porf_native_fetch_read_value(body_value, &body_buf, &body_len, &body_owned);

  if (!aborted || !*aborted) {
    res->cork([res, status, headers_entries_ptr, body_buf, body_len]() {
      if (status != 200) res->writeStatus(lookup_status_line(status));

      const i32 headers_len = *((i32*)(porf_mem + headers_entries_ptr)) / 2;
      const i32 headers_entries = *((i32*)(porf_mem + headers_entries_ptr + 4));
      for (i32 i = 0; i < headers_len; i++) {
        const i32 name_base = headers_entries + i * 16;
        const i32 value_base = name_base + 8;
        const struct jsval name_value = unpack_jsval(*((u64*)(porf_mem + name_base)));
        const struct jsval value_value = unpack_jsval(*((u64*)(porf_mem + value_base)));

        const char* name_buf = nullptr;
        size_t name_len = 0;
        char* name_owned = nullptr;
        const char* value_buf = nullptr;
        size_t value_len = 0;
        char* value_owned = nullptr;
        porf_native_fetch_read_value(name_value, &name_buf, &name_len, &name_owned);
        porf_native_fetch_read_value(value_value, &value_buf, &value_len, &value_owned);

        const std::string_view key(name_buf, name_len);
        if (!is_forbidden_response_header(key)) {
          res->writeHeader(key, std::string_view(value_buf, value_len));
        }

        if (name_owned) free(name_owned);
        if (value_owned) free(value_owned);
      }

      res->end(std::string_view(body_buf, body_len));
    });
  }

  if (body_owned) free(body_owned);
}
`;

async function shimDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sb-patch-uws-"));
  await mkdir(join(root, "compiler"), { recursive: true });
  await writeFile(join(root, "compiler/uwebsockets.js"), SHIM);
  return root;
}

test("#156: status-line fallback synthesizes a line for unlisted codes, idempotently", async () => {
  const root = await shimDir();
  try {
    await patchUwebsockets(root);
    const once = await readFile(join(root, "compiler/uwebsockets.js"), "utf8");

    // Return type widened, empty fallback replaced, known cases untouched.
    expect(once).toContain("static std::string lookup_status_line(i32 status) {");
    expect(once).not.toContain("std::string_view lookup_status_line");
    expect(once).toContain('default: return std::to_string(status) + " Status";');
    expect(once).not.toContain("default: return {};");
    expect(once).toContain('case 302: return "302 Found";');
    // 303 gets its real phrase; the switch stays well-formed (302 still present once).
    expect(once).toContain('case 303: return "303 See Other";');
    expect(once.match(/case 302: return "302 Found";/g)).toHaveLength(1);
    // Body-limit edit still rides along.
    expect(once).toContain("sb_request_body_max");
    // #195: a valid transfer ticket is intercepted before JS request roots and
    // the ordinary PendingRequest body allocation path.
    expect(once).toContain("sb_r2_transfer_open");
    expect(once).toContain("sb_r2_transfer_write");
    expect(once).toContain("try_handle_r2_transfer(res, req, method)");
    expect(once).toContain("sb_r2_transfer_download_open");
    expect(once).toContain("sb_r2_transfer_download_v1");
    expect(once).toContain("sb_r2_transfer_range_v1");
    expect(once).toContain("sb_r2_transfer_conditional_v1");

    // #163: collect_headers takes res, drops a client-sent x-sb-remote-addr, and
    // appends the real peer; the call site passes res through.
    expect(once).toContain("static i32 collect_headers(uWS::HttpRequest* req, uWS::HttpResponse<false>* res) {");
    expect(once).toContain("const i32 headers_ptr = collect_headers(req, res);");
    expect(once).toContain('if (key == "x-sb-remote-addr") continue;');
    expect(once).toContain("res->getRemoteAddressAsText()");
    expect(once).toContain('porf_native_fetch_alloc_bytestring("x-sb-remote-addr", 16)');
    expect(once).toContain("header_capacity += 2;");

    // #176: a dedicated porf_native_fetch_read_raw_bytes, declared alongside
    // the untouched original; write_response_value scans for a reserved
    // x-sb-raw-body header and calls the new function instead of the old one
    // only for the body, only when it's present -- header reads are
    // unchanged, and the marker is dropped from what reaches the client.
    expect(once).toContain(
      "int porf_native_fetch_read_raw_bytes(struct jsval value, const char** out_buf, size_t* out_len);",
    );
    expect(once).toContain('key == "x-sb-raw-body"');
    expect(once).toContain("bool raw_body = false;");
    expect(once).toContain('if (std::string_view(scan_buf, scan_bytes) == "x-sb-raw-body") raw_body = true;');
    expect(once).toContain(
      "if (raw_body && porf_native_fetch_read_raw_bytes(body_value, &body_buf, &body_len) != 0 && body_value.type == 67) {",
    );
    // A UTF-16 body (type 67) is narrowed unit by unit, never UTF-8 encoded.
    expect(once).toContain("body_owned[i] = (char)(units[i] & 0xff);");
    expect(once).toContain(
      "} else if (!raw_body || !body_buf) porf_native_fetch_read_value(body_value, &body_buf, &body_len, &body_owned);",
    );
    // Header reads are the original 4-arg call, unchanged.
    expect(once).toContain("porf_native_fetch_read_value(name_value, &name_buf, &name_len, &name_owned);");
    expect(once).toContain("porf_native_fetch_read_value(value_value, &value_buf, &value_len, &value_owned);");

    await patchUwebsockets(root);
    expect(await readFile(join(root, "compiler/uwebsockets.js"), "utf8")).toBe(once);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a drifted shim fails loudly instead of silently no-op'ing", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-patch-uws-drift-"));
  try {
    await mkdir(join(root, "compiler"), { recursive: true });
    await writeFile(join(root, "compiler/uwebsockets.js"), "// nothing the patch recognizes\n");
    await expect(patchUwebsockets(root)).rejects.toThrow(/anchor not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("broker transport defines every direct R2 transfer symbol the patched shim calls", async () => {
  const root = await shimDir();
  try {
    await patchUwebsockets(root);
    const shim = await readFile(join(root, "compiler/uwebsockets.js"), "utf8");
    const abi = shim.match(/extern "C" \{([\s\S]*?)\n\}/)?.[1];
    if (abi === undefined) throw new Error("patched shim did not contain the R2 transfer ABI");
    const required = [...abi.matchAll(/\b(sb_r2_transfer_[a-z_]+)\s*\(/g)].map((match) => match[1]);
    const wrapped = wrapNativeFetchHandler(
      "export default { fetch() { return new Response('ok'); } }",
      "",
      {},
      EMPTY_BINDINGS,
      8080,
      "2026-08-26",
      "test",
      undefined,
      "broker",
    );

    for (const symbol of new Set(required)) {
      expect(wrapped).toMatch(new RegExp(`\\b${symbol}\\s*\\([^)]*\\)\\s*\\{`));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#165: render.js routes console output to stderr, unbuffered, idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-patch-render-"));
  try {
    await mkdir(join(root, "compiler"), { recursive: true });
    await writeFile(join(root, "compiler/render.js"), RENDER);
    await patchRenderJs(root);
    const once = await readFile(join(root, "compiler/render.js"), "utf8");

    expect(once).toContain("dup2(2, 1);");
    expect(once).toContain("setvbuf(stdout, NULL, _IONBF, 0);");
    // Injected inside runtime_init, right after the SIGPIPE line.
    expect(once).toMatch(/signal\(SIGPIPE, SIG_IGN\);\n {2}\/\* sproutboat #165/);
    // The $PORT edit still lands too.
    expect(once).toContain('getenv("PORT")');

    // #172: the bytestring branch encodes instead of copying raw bytes.
    expect(once).toContain("sproutboat #172");
    expect(once).toContain("(char)(0xc0 | (c >> 6));");
    // #176: a separate, dedicated function does the original zero-copy
    // passthrough for already-finished bytes (an asset) -- porf_native_fetch_
    // read_value's own signature and behavior are untouched, so its ~30 other
    // callers across sproutboat's inline C need no changes at all.
    expect(once).toContain("sproutboat #176");
    expect(once).toContain(
      "int porf_native_fetch_read_raw_bytes(jsval value, const char** out_buf, size_t* out_len) {",
    );
    expect(once).toContain(
      "int porf_native_fetch_read_value(jsval value, const char** out_buf, size_t* out_len, char** out_owned) {",
    );

    await patchRenderJs(root);
    expect(await readFile(join(root, "compiler/render.js"), "utf8")).toBe(once);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local function type patch registers lexical bindings and is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-local-functions-"));
  try {
    await mkdir(join(root, "compiler"));
    const file = join(root, "compiler/codegen.js");
    await writeFile(
      file,
      "if (!hoistRead && directCallOnlyFunctionBinding(scope, kind, name, pattern, func)) {\n        return valUndefined();\n}\nconst func = resolveNamedFunction(scope, name) ?? funcByName(name);",
    );
    await patchLocalFunctionTypes(root);
    const patched = await readFile(file, "utf8");
    expect(patched).toContain("bindNamedFunction(scope, name, func);");
    expect(patched).not.toContain("?? funcByName(name)");
    await patchLocalFunctionTypes(root);
    expect(await readFile(file, "utf8")).toBe(patched);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("function source patch checks the body before walking the program, idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-function-sources-"));
  try {
    await mkdir(join(root, "compiler"));
    const file = join(root, "compiler/codegen.js");
    const anchor =
      "    // only names that are nothing but this declaration and its direct calls\n    if (find(program, n => n.name === x.id.name).length !== 1) continue;\n";
    await writeFile(file, anchor);
    await patchFunctionSourcesScan(root);
    const patched = await readFile(file, "utf8");
    expect(patched.indexOf("n.callee.name === 'Function').length === 0) continue;")).toBeLessThan(
      patched.indexOf("find(program,"),
    );
    await patchFunctionSourcesScan(root);
    expect(await readFile(file, "utf8")).toBe(patched);
    await writeFile(file, "const unrelated = 1;\n");
    await expect(patchFunctionSourcesScan(root)).rejects.toThrow("anchor not found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Response defaults patch types string bodies only, idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-response-defaults-"));
  try {
    await mkdir(join(root, "runtime"));
    const file = join(root, "runtime/fetch-globals.js");
    await writeFile(
      file,
      "class Response {\n  constructor(body = null, init = undefined) {\n    this.body = body;\n    this.status = Number(init?.status ?? 200);\n    this.headers = new Headers(init?.headers);\n  }\n}\n",
    );
    await patchResponseDefaults(root);
    const patched = await readFile(file, "utf8");
    expect(patched).toContain(
      "if (typeof body === 'string' && !this.headers.has('content-type')) this.headers.set('content-type', 'text/plain;charset=UTF-8');",
    );
    await patchResponseDefaults(root);
    expect(await readFile(file, "utf8")).toBe(patched);
    await writeFile(file, "class Response {}\n");
    await expect(patchResponseDefaults(root)).rejects.toThrow("anchor not found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Headers array-init patch sends arrays to the sequence branch, idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-headers-array-"));
  try {
    await mkdir(join(root, "runtime"));
    const file = join(root, "runtime/fetch-globals.js");
    await writeFile(
      file,
      "    if (Porffor.type(init.entries) == Porffor.TYPES.function) {\n      this._entries = Porffor.array.new(8);\n      for (const entry of init.entries()) {\n",
    );
    await patchHeadersArrayInit(root);
    const patched = await readFile(file, "utf8");
    expect(patched).toContain("if (!Array.isArray(init) && Porffor.type(init.entries) == Porffor.TYPES.function) {");
    await patchHeadersArrayInit(root);
    expect(await readFile(file, "utf8")).toBe(patched);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("URL patch replaces Porffor's URL class, idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-url-class-"));
  try {
    await mkdir(join(root, "runtime"));
    const file = join(root, "runtime/fetch-globals.js");
    await writeFile(
      file,
      "class TextDecoder {}\n\nclass URL {\n  constructor(input) {\n    this.href = '';\n  }\n}\n\nclass Request {\n  constructor() {}\n}\n",
    );
    await patchURLClass(root);
    const patched = await readFile(file, "utf8");
    expect(patched).toContain("sproutboat: WHATWG-style URL");
    expect(patched).not.toContain("this.href = '';");
    expect(patched.startsWith("class TextDecoder {}\n\nclass URL {")).toBe(true);
    expect(patched.endsWith("}\n\nclass Request {\n  constructor() {}\n}\n")).toBe(true);
    await patchURLClass(root);
    expect(await readFile(file, "utf8")).toBe(patched);
    await writeFile(file, "class URL {}\n");
    await expect(patchURLClass(root)).rejects.toThrow("anchor not found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("idle trim patch keeps 16 MiB above the heap top outside the idle collection, idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-idle-trim-"));
  try {
    await mkdir(join(root, "compiler"));
    const file = join(root, "compiler/render.js");
    const anchor = "  const u32 keep_slack = ${prefs.nativeFetch ? '0u' : '16u * 1024u * 1024u'};\n";
    await writeFile(file, "static i32 porf_gc_discard_pending = 0;\n" + anchor);
    await patchIdleTrim(root);
    const patched = await readFile(file, "utf8");
    expect(patched).not.toContain(anchor);
    expect(patched).toContain("porf_gc_discard_now ? 0u : 16u * 1024u * 1024u");
    expect(patched).toContain("porf_gc_discard_pending = 1;");
    // The edited line is template source: render it both ways.
    const body = patched.slice(patched.indexOf("  const u32 keep_slack"));
    const render = (nativeFetch: boolean) => new Function("prefs", "return `" + body + "`;")({ nativeFetch });
    expect(render(true)).toBe(
      "  const u32 keep_slack = porf_gc_discard_now ? 0u : 16u * 1024u * 1024u;\n" +
        "  if (!porf_gc_discard_now && (u64)porf_heap_top < porf_heap_committed) porf_gc_discard_pending = 1;\n",
    );
    expect(render(false)).toBe("  const u32 keep_slack = 16u * 1024u * 1024u;\n");
    await patchIdleTrim(root);
    expect(await readFile(file, "utf8")).toBe(patched);
    await writeFile(file, anchor);
    await expect(patchIdleTrim(root)).rejects.toThrow("deferred discard missing");
    await writeFile(file, "static i32 porf_gc_discard_pending = 0;\n");
    await expect(patchIdleTrim(root)).rejects.toThrow("anchor not found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deferred discard patch moves page discard to the idle collection, idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-deferred-discard-"));
  try {
    await mkdir(join(root, "compiler"));
    const file = join(root, "compiler/render.js");
    await writeFile(
      file,
      "static i32 porf_gc_mark_queue_cap = 0;\n" +
        "    porf_gc_discard_free_runs();\n" +
        "porf_gc_mark_queue_cap > 65536);' : '  return 0;'\n" +
        "  porf_c_stack_top = stack_top;\n  porf_gc_collect(0);\n  // The mark queue is empty\n",
    );
    await patchDeferredDiscard(root);
    const patched = await readFile(file, "utf8");
    expect(patched).toContain(
      "if (porf_gc_discard_now) porf_gc_discard_free_runs(); else porf_gc_discard_pending = 1;",
    );
    expect(patched).toContain(
      "porf_gc_discard_pending || porf_gc_claimed_since_full > 0 || porf_gc_promoted_since_full > 0);",
    );
    expect(patched).toContain(
      "  porf_gc_discard_now = 1;\n  porf_gc_collect(0);\n  porf_gc_discard_now = 0;\n  porf_gc_discard_pending = 0;",
    );
    await patchDeferredDiscard(root);
    expect(await readFile(file, "utf8")).toBe(patched);
    await writeFile(file, "export const x = 1;\n");
    await expect(patchDeferredDiscard(root)).rejects.toThrow("anchor not found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repeat patch replaces both per-repetition loops once", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-repeat-patch-"));
  try {
    await mkdir(join(root, "compiler/builtins"), { recursive: true });
    const file = join(root, "compiler/builtins/string.ts");
    const loop =
      "  for (let i: i32 = 0; i < count; i++) {\n" +
      "    Porffor.IR.copy(Porffor.IR.ptr(out) + 4 + i * thisLen, Porffor.IR.ptr(this) + 4, thisLen);\n" +
      "  }\n";
    await writeFile(file, "a\n" + loop + "b\n" + loop);
    await patchRepeatDoubling(root);
    const patched = await readFile(file, "utf8");
    expect(patched.split("sproutboat B16: doubling repeat").length).toBe(3);
    expect(patched).not.toContain("i * thisLen");
    await patchRepeatDoubling(root);
    expect(await readFile(file, "utf8")).toBe(patched);
    await writeFile(file, "a\n" + loop);
    await expect(patchRepeatDoubling(root)).rejects.toThrow("anchor not found twice");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensurePorfforPatched trusts a cache entry this toolchain version and patch chain patched, and nothing else", async () => {
  const { ensurePorfforPatched } = await import("./patch");
  const { PORFFOR_COMMIT_FULL } = await import("./pin");
  const { PATCH_FINGERPRINT } = await import("./fingerprint");
  const { version } = await import("../package.json");
  const root = await mkdtemp(join(tmpdir(), "sb-patched-stamp-"));
  try {
    // An empty tree: running the chain would throw on the first missing file.
    await writeFile(
      join(root, ".sproutboat-complete"),
      JSON.stringify({ commit: PORFFOR_COMMIT_FULL, toolchainVersion: version, patchFingerprint: PATCH_FINGERPRINT }),
    );
    await ensurePorfforPatched(root);
    const stale = await mkdtemp(join(tmpdir(), "sb-patched-stale-"));
    try {
      await writeFile(
        join(stale, ".sproutboat-complete"),
        JSON.stringify({ commit: PORFFOR_COMMIT_FULL, toolchainVersion: "0.0.0" }),
      );
      await expect(ensurePorfforPatched(stale)).rejects.toThrow();
      // Same release, older patch chain (B19): the chain runs again.
      await writeFile(
        join(stale, ".sproutboat-complete"),
        JSON.stringify({ commit: PORFFOR_COMMIT_FULL, toolchainVersion: version, patchFingerprint: "000000000000" }),
      );
      await expect(ensurePorfforPatched(stale)).rejects.toThrow();
    } finally {
      await rm(stale, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("console colour patch colours only on a terminal, idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-console-colors-"));
  try {
    await mkdir(join(root, "compiler/builtins"), { recursive: true });
    const file = join(root, "compiler/builtins/console.ts");
    await writeFile(
      file,
      "export const __Porffor_consolePrint = (arg: any): void => {\n  if (x) return;\n  __Porffor_print(arg);\n};\n",
    );
    await patchConsoleColors(root);
    const patched = await readFile(file, "utf8");
    expect(patched).toContain("Porffor.c`tty = isatty(1) ? 1 : 0;`;");
    expect(patched).toContain("  __Porffor_print(arg, __Porffor_consoleColors());\n};");
    await patchConsoleColors(root);
    expect(await readFile(file, "utf8")).toBe(patched);
    await writeFile(file, "export const x = 1;\n");
    await expect(patchConsoleColors(root)).rejects.toThrow("anchor not found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TextDecoder and Headers patches replace Porffor's classes once", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-web-classes-"));
  try {
    await mkdir(join(root, "runtime"));
    const file = join(root, "runtime/fetch-globals.js");
    await writeFile(
      file,
      "class Headers {\n  old() {}\n}\nfunction setTimeout() {}\nclass TextDecoder {\n  old() {}\n}\nclass URL {\n}\n",
    );
    await patchHeadersClass(root);
    await patchTextDecoder(root);
    const patched = await readFile(file, "utf8");
    expect(patched).toContain("sproutboat: Fetch-spec Headers");
    expect(patched).toContain("sproutboat: WHATWG UTF-8 decoder");
    expect(patched).not.toContain("old() {}");
    expect(patched).toContain("\nfunction setTimeout() {}\nclass TextDecoder {");
    await patchHeadersClass(root);
    await patchTextDecoder(root);
    expect(await readFile(file, "utf8")).toBe(patched);
    await writeFile(file, "export const x = 1;\n");
    await expect(patchHeadersClass(root)).rejects.toThrow("anchor not found");
    await expect(patchTextDecoder(root)).rejects.toThrow("anchor not found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("case mapping patch adds the lookup and routes non-ASCII units through it, idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-case-map-"));
  try {
    await mkdir(join(root, "compiler/builtins"), { recursive: true });
    const file = join(root, "compiler/builtins/string.ts");
    await writeFile(
      file,
      "export const __String_prototype_toUpperCase = function (this: string) {\n" +
        "    if (chr >= 97) if (chr <= 122) chr -= 32;\n\n    Porffor.IR.storeU16(j, 4, chr);\n" +
        "    if (chr >= 97) if (chr <= 122) chr -= 32;\n\n    Porffor.IR.storeU8(j++, 4, chr);\n" +
        "    if (chr >= 65) if (chr <= 90) chr += 32;\n\n    Porffor.IR.storeU16(j, 4, chr);\n" +
        "    if (chr >= 65) if (chr <= 90) chr += 32;\n\n    Porffor.IR.storeU8(j++, 4, chr);\n",
    );
    await patchCaseMapping(root);
    const patched = await readFile(file, "utf8");
    expect(patched).toContain("export const __Porffor_caseFind = (chr: i32, runs: string): i32 => {");
    expect(patched).toContain("else chr = __Porffor_caseUpper(chr);");
    expect(patched).toContain("else chr = __Porffor_caseLower(chr);");
    expect(patched).toContain("if (chr != 247) chr -= 32;");
    await patchCaseMapping(root);
    expect(await readFile(file, "utf8")).toBe(patched);
    await writeFile(file, "export const x = 1;\n");
    await expect(patchCaseMapping(root)).rejects.toThrow("anchor not found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("zero-delay timer patch arms timers at 1 ms, idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-zero-timers-"));
  try {
    await mkdir(join(root, "compiler"));
    const file = join(root, "compiler/render.js");
    await writeFile(
      file,
      "x\n  porf_native_fetch_timer_start(id, (i32)delay_ms, timer->repeat ? (i32)delay_ms : 0);\n",
    );
    await patchZeroDelayTimers(root);
    const patched = await readFile(file, "utf8");
    expect(patched).toContain("delay_ms < 1 ? 1 : (i32)delay_ms");
    await patchZeroDelayTimers(root);
    expect(await readFile(file, "utf8")).toBe(patched);
    await writeFile(file, "export const x = 1;\n");
    await expect(patchZeroDelayTimers(root)).rejects.toThrow("anchor not found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Request/Response, Blob and finalizer patches replace their targets once", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-fetch-classes-"));
  try {
    await mkdir(join(root, "runtime"));
    const globals = join(root, "runtime/fetch-globals.js"),
      entry = join(root, "runtime/native-fetch.js");
    await writeFile(
      globals,
      "class Blob {\n  old() {}\n}\nclass TextEncoder {\n}\nclass Request {\n  old() {}\n}\nclass Response {\n  old() {}\n}\n",
    );
    await writeFile(
      entry,
      "x\n  const body = response.body == null ? '' : String(response.body);\n  const headersEntries = response.headers._entries;\n",
    );
    await patchFetchClasses(root);
    await patchBlobClass(root);
    await patchResponseBytes(root);
    const g = await readFile(globals, "utf8"),
      e = await readFile(entry, "utf8");
    expect(g).toContain("sproutboat: Fetch-spec Request and Response");
    expect(g).toContain("sproutboat: byte-backed Blob and File");
    expect(g).toContain("class File extends Blob {");
    expect(g).not.toContain("old() {}");
    expect(e).toContain("headersEntries.push('x-sb-raw-body', '1');");
    await patchFetchClasses(root);
    await patchBlobClass(root);
    await patchResponseBytes(root);
    expect(await readFile(globals, "utf8")).toBe(g);
    expect(await readFile(entry, "utf8")).toBe(e);
    await writeFile(globals, "export const x = 1;\n");
    await writeFile(entry, "export const x = 1;\n");
    await expect(patchFetchClasses(root)).rejects.toThrow("anchor not found");
    await expect(patchBlobClass(root)).rejects.toThrow("anchor not found");
    await expect(patchResponseBytes(root)).rejects.toThrow("anchor not found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("streaming patch adds the stream registry and attaches marked responses, idempotently", async () => {
  const streaming = await import("./streaming");
  const root = await mkdtemp(join(tmpdir(), "sb-streaming-"));
  try {
    await mkdir(join(root, "compiler"));
    const file = join(root, "compiler/uwebsockets.js");
    const render = join(root, "compiler/render.js");
    await writeFile(render, "f64 x;\n" + streaming.STREAM_STUBS_ANCHOR + " for a bytestring\n");
    await writeFile(
      file,
      streaming.STREAM_FORBIDDEN_ANCHOR +
        streaming.STREAM_REGISTRY_ANCHOR +
        streaming.STREAM_FLAG_ANCHOR +
        streaming.STREAM_SCAN_ANCHOR +
        streaming.STREAM_CORK_ANCHOR +
        streaming.STREAM_END_ANCHOR,
    );
    await patchStreamingResponses(root);
    const patched = await readFile(file, "utf8");
    expect(patched).toContain('extern "C" u32 sb_stream_open(void) {');
    expect(patched).toContain("if (stream_id) sb_stream_attach(stream_id, res);");
    expect(patched).toContain('key == "x-sb-stream"; // sproutboat B19');
    expect(patched.indexOf("sproutboat B19: streamed responses")).toBeLessThan(
      patched.indexOf("static void write_response_value"),
    );
    const stubs = await readFile(render, "utf8");
    expect(stubs).toContain("__attribute__((weak)) int sb_stream_supported(void) { return 0; }");
    expect(stubs.indexOf("streaming fallbacks")).toBeLessThan(stubs.indexOf(streaming.STREAM_STUBS_ANCHOR));
    await patchStreamingResponses(root);
    expect(await readFile(file, "utf8")).toBe(patched);
    expect(await readFile(render, "utf8")).toBe(stubs);
    await writeFile(file, "export const x = 1;\n");
    await expect(patchStreamingResponses(root)).rejects.toThrow("anchor not found");
    await writeFile(render, "export const x = 1;\n");
    await expect(patchStreamingResponses(root)).rejects.toThrow("streaming fallbacks: anchor not found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("async waker patch installs a loop waker in the native server, idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-async-waker-"));
  try {
    await mkdir(join(root, "compiler"));
    const file = join(root, "compiler/uwebsockets.js");
    await writeFile(
      file,
      "static void on_request() {}\nint main(void) {\n  porf_native_fetch_runtime_init();\n  porf_native_fetch_static_init();\n\n  uWS::App();\n}\n",
    );
    await patchAsyncWaker(root);
    const patched = await readFile(file, "utf8");
    expect(patched).toContain('extern "C" __attribute__((weak)) void sb_async_set_waker(void (*wake)(void))');
    expect(patched).toContain("sb_async_loop->defer([] {");
    expect(patched.indexOf("sb_async_set_waker(sb_async_wake);")).toBeGreaterThan(
      patched.indexOf("porf_native_fetch_static_init();"),
    );
    expect(patched.indexOf("sb_async_set_waker(sb_async_wake);")).toBeLessThan(patched.indexOf("uWS::App();"));
    await patchAsyncWaker(root);
    expect(await readFile(file, "utf8")).toBe(patched);
    await writeFile(file, "export const x = 1;\n");
    await expect(patchAsyncWaker(root)).rejects.toThrow("main() anchor not found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("split globals patch prefixes module globals so none binds to libc, idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-split-globals-"));
  try {
    await mkdir(join(root, "compiler"));
    const file = join(root, "compiler/render.js");
    await writeFile(
      file,
      [
        "  const st = split ? '' : 'static ';",
        "      case K.Global:\n        cur.globals[node[N_A]] = true;\n      case K.Local:\n        return [sanitize(node[N_A]), P_PRIM];",
        "        emit(`${ind()}${sanitize(node[N_A][N_A])} = ${rx(node[N_B], P_COMMA)};\\n`);",
        "            ? `${sanitize(update[N_A][N_A])} = ${rx(update[N_B], P_COMMA)}`",
        "    const t = sanitize(target[N_A]);",
        "  for (const g of globals) link.push(`${st}${CT[g.type]} ${sanitize(g.name)};`);",
        "      const name = sanitize(g.name);",
        "          const buckets = sanitize(g.name.replace(/underlyingStore$/, 'underlyingBuckets'));",
        "          const bucketsCap = sanitize(g.name.replace(/underlyingStore$/, 'underlyingBucketsCap'));",
        "      for (const x of Object.keys(parts.globals).sort()) text.push(`extern ${CT[globalTypes[x]]} ${sanitize(x)};\\n`);",
        "",
      ].join("\n"),
    );
    await patchSplitGlobals(root);
    const patched = await readFile(file, "utf8");
    expect(patched).toContain("const gname = n => sanitize(split && !n.startsWith('__') ? 'pg_' + n : n);");
    expect(patched).toContain(
      "return [gname(node[N_A]), P_PRIM];\n      case K.Local:\n        return [sanitize(node[N_A]), P_PRIM];",
    );
    expect(patched).toContain("${st}${CT[g.type]} ${gname(g.name)}");
    expect(patched).toContain("text.push(`extern ${CT[globalTypes[x]]} ${gname(x)};\\n`);");
    expect(patched.match(/gname\(/g)?.length).toBe(9);
    await patchSplitGlobals(root);
    expect(await readFile(file, "utf8")).toBe(patched);
    await writeFile(file, "export const x = 1;\n");
    await expect(patchSplitGlobals(root)).rejects.toThrow("anchor not found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GC footprint patch returns every free run at idle and adds porf_gc_seal_heap, idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-gc-footprint-"));
  try {
    await mkdir(join(root, "compiler"));
    const file = join(root, "compiler/render.js");
    const source =
      "static i32 porf_gc_discard_pending = 0;\n#define PORF_GC_PF_TAIL 8u\n" +
      "static int porf_gc_install_run(i32 ci, u32 pg) {\n  return 1;\n}\n" +
      "static void porf_gc_partial_push(u32 pg) {\n  struct porf_gc_page* m = &porf_gc_pages[pg];\n  if ((m->flags & PORF_GC_PF_PARTIAL) != 0u) return;\n}\n" +
      "      if (run_len >= 32u) porf_gc_discard_range(a, b);\n  if (run_len >= 32u) porf_gc_discard_range(a, b);\n" +
      "  memset(porf_gc_active, 0, sizeof(porf_gc_active));\n  porf_gc_minor_mode = 0;\n}\n";
    await writeFile(file, source);
    await patchGcFootprint(root);
    const patched = await readFile(file, "utf8");
    expect(patched).toContain("#define PORF_GC_PF_SEALED 16u");
    expect(patched).toContain("  if ((porf_gc_pages[pg].flags & PORF_GC_PF_SEALED) != 0u) return 0;\n  return 1;");
    expect(patched).toContain("(PORF_GC_PF_PARTIAL | PORF_GC_PF_SEALED)");
    expect(patched).not.toContain("run_len >= 32u");
    expect(patched.split("if (run_len > 0u) porf_gc_discard_range").length).toBe(3);
    expect(patched).toContain("void porf_gc_seal_heap(void) {");
    await patchGcFootprint(root);
    expect(await readFile(file, "utf8")).toBe(patched);
    await writeFile(file, source.replace("static i32 porf_gc_discard_pending = 0;\n", ""));
    await expect(patchGcFootprint(root)).rejects.toThrow("deferred discard missing");
    await writeFile(file, "static i32 porf_gc_discard_pending = 0;\n");
    await expect(patchGcFootprint(root)).rejects.toThrow("anchor not found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("globalThis patch rewrites only changed bindings on access, idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-globalthis-sync-"));
  try {
    await mkdir(join(root, "compiler"), { recursive: true });
    const codegen = join(root, "compiler/codegen.js");
    const builtins = join(root, "compiler/builtins.js");
    await writeFile(
      codegen,
      [
        "  Reinterpret, Box, JvType, JvNum, JvPtr, JvIsNum,",
        "  globalThisUserSync: (objJv, sync) => {",
        "    const finalizer = () => {",
        "      sync.length = 0;",
        "      const seen = new Set();",
        "      const push = (key, value) => {",
        "        seen.add(key);",
        "        sync.push(builtinCall(scope, '__Porffor_object_set', [ objJv, makeString(scope, key), value ]));",
        "      };",
        "",
      ].join("\n"),
    );
    await writeFile(
      builtins,
      [
        "        const sync = [];",
        "        if (name === 'globalThis') globalThisUserSync(Box(getPtr, Const(T.i32, TYPES.object)), sync);",
        "        out.push(BlockStmt(sync));",
        "",
      ].join("\n"),
    );
    await patchGlobalThisSync(root);
    const patchedCodegen = await readFile(codegen, "utf8");
    const patchedBuiltins = await readFile(builtins, "utf8");
    expect(patchedCodegen).toContain("JvPtr, JvBits, JvIsNum,");
    expect(patchedCodegen).toContain("globalThisUserSync: (objJv, sync, once) => {");
    expect(patchedCodegen).toContain("once.length = 0;");
    expect(patchedCodegen).toContain("sync.push(If(Bin('!=', T.u64, JvBits(value), shadow), write()));");
    expect(patchedCodegen).toContain("once.push(...write());");
    expect(patchedBuiltins).toContain("globalThisUserSync(Box(getPtr, Const(T.i32, TYPES.object)), sync, once);");
    expect(patchedBuiltins).toContain("out.push(BlockStmt(once));");
    expect(patchedBuiltins).not.toContain("out.push(BlockStmt(sync));");
    await patchGlobalThisSync(root);
    expect(await readFile(codegen, "utf8")).toBe(patchedCodegen);
    expect(await readFile(builtins, "utf8")).toBe(patchedBuiltins);
    await writeFile(codegen, "export const x = 1;\n");
    await expect(patchGlobalThisSync(root)).rejects.toThrow("anchor not found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// One idempotent, anchor-checked edit of a Porffor source file, as the patches above are tested.
async function expectPatch(
  patch: (root: string) => Promise<void>,
  file: string,
  anchor: string,
  expected: string,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "sb-patch-"));
  try {
    await mkdir(join(root, "compiler"));
    const path = join(root, file);
    await writeFile(path, `// before\n${anchor}// after\n`);
    await patch(root);
    const patched = await readFile(path, "utf8");
    expect(patched).toContain(expected);
    await patch(root);
    expect(await readFile(path, "utf8")).toBe(patched);
    await writeFile(path, "export const x = 1;\n");
    await expect(patch(root)).rejects.toThrow("anchor not found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("patchMacroNames prefixes all-caps bindings so libc macros cannot rewrite them", async () => {
  await expectPatch(
    patchMacroNames,
    "compiler/render.js",
    "  while (cReservedNames.has(out) || sanitizeUsed.has(out)) out = '_' + out;\n",
    "if (/^[A-Z][A-Z0-9_]+$/.test(out)) out = 'js_' + out;",
  );
});

test("patchTypedArrayShadow lets a typed array with an underlying object shadow builtin methods", async () => {
  await expectPatch(
    patchTypedArrayShadow,
    "compiler/codegen.js",
    "        const call = owner === 'RegExp' && shadowable ? shadowed : () => generate(scope, builtinCallNode);\n",
    "(owner === 'RegExp' || owner === 'TypedArray') && shadowable",
  );
});

test("patchCallArgOrder copies earlier arguments before a later one that assigns", async () => {
  await expectPatch(
    patchCallArgOrder,
    "compiler/codegen.js",
    "const generateCall = (scope, decl) => {\n",
    "if (!decl._argsOrdered && !globalThis.precompile && decl.arguments.length > 1) {",
  );
});

test("patchNavigatorWritable makes navigator.userAgent assignable", async () => {
  await expectPatch(
    patchNavigatorWritable,
    "compiler/builtins.js",
    "      writable: false,\n      enumerable: true,\n      configurable: false\n    }, {\n      userAgent: 'x'\n",
    "writable: true, // sproutboat: navigator is writable",
  );
});
