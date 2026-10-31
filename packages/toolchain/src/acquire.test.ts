import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ensurePorffor, PORFFOR_COMMIT_FULL, PorfforToolchainError } from "./index";
import { PATCH_FINGERPRINT } from "./fingerprint";
import { NATIVE_BYTES_LAYOUT, NATIVE_BYTES_RENDER_ANCHOR } from "./native-bytes";
import { ASYNC_CONTEXT_PROMISE_ANCHORS, ASYNC_CONTEXT_RENDER_ANCHORS } from "./async-context";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{ archive: string; sha256: string }> {
  const root = await mkdtemp(join(tmpdir(), "sb-porffor-fixture-"));
  temporary.push(root);
  const source = join(root, `porffor-${PORFFOR_COMMIT_FULL}`);
  const files = {
    "runtime/index.js": "fixture:runtime/index.js\n",
    "compiler/render.js":
      // patchUnhandledRejections' anchors: the async-result helper, the rejected-promise helper and
      // the settle calls of a coroutine that threw.
      "  const settleAsyncResult = promiseResolveFunc\n" +
      "${st}jsval porf_promise_rejected(jsval value) {\n  return porf_promise_settled(value, 2);\n}" +
      "  porf_promise_settle_direct(out_promise, porf_exception, 2);\n" +
      NATIVE_BYTES_RENDER_ANCHOR +
      // patchAsyncContext's anchors.
      ASYNC_CONTEXT_RENDER_ANCHORS +
      "// sb_native_utf8_scalar_v1\n" +
      "static void porf_gc_cons_candidate(u32 c);\n" +
      // patchStaticArrayEntries' anchor.
      "  if (entries == body + 16) return porf_gc_static_range(body, 16ull + bytes);\n  return porf_gc_static_range(entries, bytes);\n}\n" +
      // patchArrayGrowEntries' anchor.
      "  const u32 ent = porf_alloc((u32)cap << 3, 0);\n  memcpy(MEM + ent, MEM + PORF_ARR_ENT(a), (size_t)copy << 3);\n  memset(MEM + ent + ((u64)copy << 3), 0, ((size_t)cap - (size_t)copy) << 3);\n  PORF_ARR_ENT(a) = ent; PORF_ARR_CAP(a) = cap;\n" +
      // patchIdleTrim's anchor.
      "  const u32 keep_slack = ${prefs.nativeFetch ? '0u' : '16u * 1024u * 1024u'};\n" +
      // Both conservative scanners consume raw f64 values.
      (
        "    if (d > 0.0 && d < 4294967296.0) {\n" +
        "      const i64 iv = (i64)d;\n" +
        "      if ((f64)iv == d) porf_gc_cons_candidate((u32)(u64)iv);\n    }\n"
      ).repeat(2) +
      "static i32 porf_gc_mark_queue_cap = 0;\n    porf_gc_discard_free_runs();\n" +
      // patchGcFootprint's anchors.
      "#define PORF_GC_PF_TAIL 8u\nstatic int porf_gc_install_run(i32 ci, u32 pg) {\n" +
      "static void porf_gc_partial_push(u32 pg) {\n  struct porf_gc_page* m = &porf_gc_pages[pg];\n  if ((m->flags & PORF_GC_PF_PARTIAL) != 0u) return;\n" +
      "if (run_len >= 32u) porf_gc_discard_range\nif (run_len >= 32u) porf_gc_discard_range\n" +
      "  memset(porf_gc_active, 0, sizeof(porf_gc_active));\n  porf_gc_minor_mode = 0;\n}\n" +
      "  porf_native_fetch_timer_start(id, (i32)delay_ms, timer->repeat ? (i32)delay_ms : 0);\n" +
      "void porf_native_fetch_collect_normal_from(void* stack_top) {\n" +
      "  if (porf_heap_base == 0) return;\n" +
      "  void* prev_stack_top = porf_c_stack_top;\n  porf_c_stack_top = stack_top;\n" +
      "  porf_gc_collect_idle();\n  porf_c_stack_top = prev_stack_top;\n}\n" +
      "\nint porf_native_fetch_should_collect(void) { return 0; }\n" +
      "void porf_native_fetch_runtime_init(void) {\n  signal(SIGPIPE, SIG_IGN);\n  porf_init(0, NULL);\n}\n" +
      "f64 porf_native_fetch_get_port(void) {\nfixture:compiler/render.js\n" +
      "int porf_native_fetch_read_value(jsval value, const char** out_buf, size_t* out_len, char** out_owned) {\n" +
      "  if (value.type == ${TYPES.bytestring}) {\n" +
      "    const u32 ptr = (u32)value.val;\n" +
      "    *out_buf = (const char*)(MEM + ptr + 4);\n" +
      "    *out_len = (size_t)*(u32*)(MEM + ptr);\n" +
      "    return 0;\n" +
      "  }\n" +
      "  return -1;\n" +
      "}\n" +
      // patchSplitGlobals' anchors.
      "  const st = split ? '' : 'static ';\n" +
      "      case K.Global:\n        cur.globals[node[N_A]] = true;\n      case K.Local:\n        return [sanitize(node[N_A]), P_PRIM];\n" +
      "        emit(`${ind()}${sanitize(node[N_A][N_A])} = ${rx(node[N_B], P_COMMA)};\\n`);\n" +
      "            ? `${sanitize(update[N_A][N_A])} = ${rx(update[N_B], P_COMMA)}`\n" +
      "    const t = sanitize(target[N_A]);\n" +
      "  for (const g of globals) link.push(`${st}${CT[g.type]} ${sanitize(g.name)};`);\n" +
      "      const name = sanitize(g.name);\n" +
      "          const buckets = sanitize(g.name.replace(/underlyingStore$/, 'underlyingBuckets'));\n" +
      "          const bucketsCap = sanitize(g.name.replace(/underlyingStore$/, 'underlyingBucketsCap'));\n" +
      "      for (const x of Object.keys(parts.globals).sort()) text.push(`extern ${CT[globalTypes[x]]} ${sanitize(x)};\\n`);\n",
    "compiler/parse.js":
      "import link from './modules.js';\n" +
      "export default (input) => {\n" +
      "  const ast = parse(input);\n" +
      "  if (ast._ts) globalThis.typedInput = Prefs.optTypes;\n" +
      "  return ast;\n" +
      "};\n",
    "compiler/index.js":
      "import { hashId } from './modules.js';\n" +
      "      const uwsDir = uwebsockets.ensureUWebSockets();\n" +
      "    if (Prefs.musl) compiler = [ 'zig', 'cc', '-target', 'x86_64-linux-musl' ];\n" +
      "    if (Prefs.musl) cxx = [ 'zig', 'c++', '-target', 'x86_64-linux-musl' ];\n" +
      "      '-fno-ident', '-ffunction-sections', '-fdata-sections',\n      ...darwinReleaseCompileArgs,\n        uSocketsArchive,\n        '-lm'\n",
    "compiler/precompile.js":
      "const fs = require('node:fs');\n" +
      "const path = require('node:path');\n" +
      "fs.writeFileSync(path.join(__dirname, 'builtins_precompiled.js'), fs.readFileSync(path.join(__dirname, 'builtins/typedarray.js')));\n",
    "compiler/builtins_precompiled.js": "fixture:precompiled\n",
    // patchObjectGrowEntries' anchor.
    "compiler/builtins/_internal_object.ts":
      "  Porffor.IR.storeU16(obj, 2, capacity);\n  Porffor.IR.storeI32(obj, 12, newEntriesPtr);\n  Porffor.IR.gcBarrier(obj, Porffor.TYPES.object);\n  return newEntriesPtr;\n",
    "compiler/builtins/date.ts": "export const __ecma262_ParseDTSF = (string: string) => {\n};\n",
    "compiler/builtins/arraybuffer.ts": "// maxByteLength -1 for fixed length, -2 for immutable\n",
    "compiler/builtins/typedarray.js":
      NATIVE_BYTES_LAYOUT +
      "\n" +
      "${typedArrayFuncs.reduce((acc, x) => acc + x.replace('// @porf-typed-array\\n', '').replaceAll('Array', name).replaceAll('any[]', name) + '\\n\\n', '')}`;\n" +
      "  offset = Math.trunc(offset);\n  if (Porffor.fastOr(offset < 0, offset > len)) throw new RangeError('Offset out of bounds');\n" +
      "export const __${name}_from = (arg: any, mapFn: any): ${name} => {\n" +
      "  const arr: any[] = Porffor.array.new(4);\n" +
      "  let len: i32 = 0;\n" +
      "  if (Porffor.type(arg) == Porffor.TYPES.array) {\n" +
      "    let i: i32 = 0;\n" +
      "    for (const x of arg) arr[i++] = x;\n" +
      "    len = i;\n" +
      "  }\n\n  arr.length = len;\n\n  return new ${name}(arr);\n};\n",
    "compiler/uwebsockets.js":
      "const repoDir = path.join(cacheRoot, `uWebSockets-${UWS_COMMIT}${Prefs.musl ? '-musl' : ''}`);\n  const appHeader = 1;\n" +
      'export const makeUWebSocketsShimSource = () => `\n#include "App.h"\n' +
      "void porf_native_fetch_collect_normal_from(void* stack_top);\n" +
      "static void collect_after_request(void) {\n  volatile int porf_stack_anchor = 0;\n" +
      "  porf_native_fetch_collect_normal_from((void*)&porf_stack_anchor);\n}\n" +
      "static const size_t REQUEST_BODY_MAX_BYTES = 1024u * 1024u;\n" +
      "int porf_native_fetch_read_value(struct jsval value, const char** out_buf, size_t* out_len, char** out_owned);\n" +
      "static std::string_view lookup_status_line(i32 status) {\n" +
      '  switch (status) {\n    case 302: return "302 Found";\n    default: return {};\n  }\n}\n' +
      "static i32 collect_headers(uWS::HttpRequest* req) {\n" +
      "  i32 header_capacity = 0;\n" +
      "  const i32 header_bytes = 16 + header_capacity * 8;\n" +
      "  i32 slot = 0;\n  for (auto [key, value] : *req) {\n    slot++;\n  }\n" +
      "  *((i32*)(porf_mem + headers_ptr)) = slot;\n\n  return headers_ptr;\n}\n" +
      "static void on_request(uWS::HttpResponse<false>* res, uWS::HttpRequest* req) {\n" +
      "  const std::string_view method = req->getCaseSensitiveMethod();\n" +
      "  const i32 method_ptr = get_method_ptr(method);\n" +
      "  if (method_ptr == 0) return;\n" +
      "  __porffor_js_enter();\n  const i32 url_ptr = alloc_request_url(req);\n" +
      "  const i32 headers_ptr = collect_headers(req);\n" +
      "  if (declared_content_length > REQUEST_BODY_MAX_BYTES || REQUEST_BODY_MAX_BYTES == 0) {\n  }\n}\n" +
      "static bool handle_request(uWS::HttpResponse<false>* res, i32 method_ptr, i32 url_ptr, i32 headers_ptr, std::string_view request_body, bool* aborted, NativeRequestRoots* roots) {\n" +
      "      res->onAborted([pending]() {\n        pending->aborted = true;\n        pending->res = nullptr;\n      });\n}\n" +
      "static bool is_forbidden_response_header(std::string_view key) {\n" +
      '  return key == "connection" ||\n' +
      '         key == "content-length" ||\n' +
      '         key == "transfer-encoding";\n' +
      "}\n" +
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
      "}\n" +
      'int main(void) {\n  porf_native_fetch_runtime_init();\n  porf_native_fetch_static_init();\n\n  uWS::App().any("/*", [](auto* res, auto* req) {\n    on_request(res, req);\n  }).listen(port, [&listened, port](auto* token) {\n    if (token) {\n      listened = true;\n    }\n  }).run();\n  return 0;\n}\n',
    "compiler/builtins/json.ts":
      "// sb_json_utf16_v1\n" +
      "export const __Porffor_json_serialize = (_buffer: i32, value: any): i32 => {\n" +
      "    for (const x of (value as any[])) {\n    }\n" +
      "      const val: any = value[key];\n" +
      "};\nexport const __JSON_stringify = (value: any) => {\n  let cap: i32 = 4096;\n};\n" +
      "export const __Porffor_json_skipWhitespace = (text: any, pos: i32, len: i32): i32 => {\n" +
      "  const c: i32 = text.charCodeAt(pos);\n".repeat(29) +
      "};\nexport const __Porffor_json_internalize = (holder: any) => {};\n",
    "compiler/builtins/string_f64.ts":
      "export const __String_prototype_charCodeAt = function (this: string, _index: any) {\n  const len: i32 = this.length;\n};\n" +
      "export const __ByteString_prototype_charCodeAt = function (this: bytestring, _index: any) {\n  const len: i32 = this.length;\n};\n",
    "compiler/builtins/regexp.ts":
      "export const __RegExp_prototype_Symbol_replace = function (this: any, string: any, replaceValue: any) {\n" +
      "  if (pristine && !functional && __Porffor_regex_flagIn(replaceValue, 36) == false) return __Porffor_regex_replacePlain(rx, s, replaceValue);\n" +
      "  let acc: any = '';\n" +
      "      acc = __Porffor_strcat(__Porffor_strcat(acc, __Porffor_regex_inputSubstring(s, sType, nextPos, position)), replacement);\n" +
      "  if (nextPos >= lengthS) return acc;\n  return __Porffor_strcat(acc, __Porffor_regex_inputSubstring(s, sType, nextPos, lengthS));\n" +
      "};\nexport const __RegExp_prototype_Symbol_split = function (this: any, string: any, limit: any) {};\n",
    "runtime/native-fetch.js":
      "export function finalize(response) {\n  const body = response.body == null ? '' : String(response.body);\n  const headersEntries = response.headers._entries;\n}\n",
    "runtime/fetch-globals.js":
      "// sb_text_encoder_scalar_v1\n" +
      "class Blob {\n}\nclass TextEncoder {\n}\n" +
      "class Headers {\n" +
      "    if (Porffor.type(init.entries) == Porffor.TYPES.function) {\n      this._entries = Porffor.array.new(8);\n      for (const entry of init.entries()) {\n" +
      "}\nfunction setTimeout() {}\nclass TextDecoder {\n}\n" +
      "class URL {\n  constructor(input) {\n    this.href = '';\n  }\n}\n\nclass Request {\n}\n" +
      "class Response {\n  constructor(body = null, init = undefined) {\n    this.body = body;\n    this.status = Number(init?.status ?? 200);\n    this.headers = new Headers(init?.headers);\n  }\n}\n",
    "compiler/builtins/console.ts":
      "export const __Porffor_consolePrint = (arg: any): void => {\n  __Porffor_print(arg);\n};\n",
    "compiler/builtins.js":
      "        const sync = [];\n        if (name === 'globalThis') globalThisUserSync(Box(getPtr, Const(T.i32, TYPES.object)), sync);\n" +
      "        out.push(BlockStmt(sync));\n",
    "compiler/codegen.js":
      "        const call = owner === 'RegExp' && shadowable ? shadowed : () => generate(scope, builtinCallNode);\n" +
      "  Reinterpret, Box, JvType, JvNum, JvPtr, JvIsNum,\n" +
      "  globalThisUserSync: (objJv, sync) => {\n    const finalizer = () => {\n      sync.length = 0;\n      const seen = new Set();\n      const push = (key, value) => {\n        seen.add(key);\n        sync.push(builtinCall(scope, '__Porffor_object_set', [ objJv, makeString(scope, key), value ]));\n      };\n" +
      "    includeBuiltin(topLevelFunc, '__Porffor_promise_resolve');\n" +
      "if (!hoistRead && directCallOnlyFunctionBinding(scope, kind, name, pattern, func)) {\n        return valUndefined();\n}\nconst func = resolveNamedFunction(scope, name) ?? funcByName(name);\n" +
      "    // only names that are nothing but this declaration and its direct calls\n    if (find(program, n => n.name === x.id.name).length !== 1) continue;\n" +
      "      stmt(scope, Store(ctype, addr, 4, ctype === 'f64' || ctype === 'f32' ? f : toUint32(scope, f)));\n" +
      "  const taGet = (ctype, size, signed = true) => () => {\n" +
      "    const loaded = Load(ctype, taAddr(size), 4);\n" +
      "    const f = ctype === 'f32' || ctype === 'f64' ? loaded : Convert(T.f64, loaded, signed ? CONVERT_SIGNED : 0);\n" +
      "    return Box(f, Const(T.i32, TYPES.number));\n" +
      "  };\n",
    "compiler/builtins/string.ts":
      "export const __String_prototype_toUpperCase = function (this: string) {\n" +
      "    if (chr >= 97) if (chr <= 122) chr -= 32;\n\n    Porffor.IR.storeU16(j, 4, chr);\n" +
      "    if (chr >= 97) if (chr <= 122) chr -= 32;\n\n    Porffor.IR.storeU8(j++, 4, chr);\n" +
      "    if (chr >= 65) if (chr <= 90) chr += 32;\n\n    Porffor.IR.storeU16(j, 4, chr);\n" +
      "    if (chr >= 65) if (chr <= 90) chr += 32;\n\n    Porffor.IR.storeU8(j++, 4, chr);\n" +
      "  for (let i: i32 = 0; i < count; i++) {\n    Porffor.IR.copy(Porffor.IR.ptr(out) + 4 + i * thisLen, Porffor.IR.ptr(this) + 4, thisLen);\n  }\n" +
      "  for (let i: i32 = 0; i < count; i++) {\n    Porffor.IR.copy(Porffor.IR.ptr(out) + 4 + i * thisLen, Porffor.IR.ptr(this) + 4, thisLen);\n  }\n" +
      "export const __Porffor_string_replaceAll = (str: any, searchValue: any, replaceValue: any) => {\n" +
      "  let out: any = __Porffor_string_emptyLike(str);\n  let appendIndex: i32 = 0;\n  let searchIndex: i32 = 0;\n  let matched: boolean = false;\n" +
      "    out = __Porffor_strcat(out, __Porffor_string_substringLike(str, appendIndex, matchIndex));\n    out = __Porffor_strcat(out, __Porffor_string_applyReplacer(str, match, matchIndex, replaceValue));\n" +
      "  if (!matched) return str;\n  return __Porffor_strcat(out, __Porffor_string_substringLike(str, appendIndex, thisLen));\n};\n" +
      "export const __String_prototype_replaceAll = function (this: string, searchValue: any, replaceValue: any) {};\n",
    "compiler/builtins/promise.ts":
      "export const __Porffor_promise_resolve = (value: any, promise: any): void => {\n" +
      "  if (Porffor.type(value) == Porffor.TYPES.object) {\n" +
      "    // cheap prototype-chain probe for 'then' before the expensive Get below, does not invoke getters\n" +
      "    const thenHash: i32 = __Porffor_object_hash('then');\n" +
      "    let probe: any = value;\n" +
      "    while (Porffor.type(probe) == Porffor.TYPES.object) {\n" +
      "      if (Porffor.object.lookup(probe, 'then', thenHash) != 0) break;\n" +
      "      probe = __Porffor_object_getPrototype(probe);\n" +
      "    }\n" +
      "    if (Porffor.type(probe) != Porffor.TYPES.object) {\n" +
      "      __ecma262_FulfillPromise(promise, value);\n" +
      "      return;\n" +
      "    }\n" +
      "  }\n" +
      ASYNC_CONTEXT_PROMISE_ANCHORS +
      "};\n" +
      "export const __Porffor_promise_runJobs = (): void => {\n" +
      "  while (pendingRejections.length > 0) {\n" +
      "    const p: any = pendingRejections.pop();\n" +
      "    if (Porffor.fastAnd(!__Porffor_promise_isHandled(p), __Porffor_promise_state(p) == 2)) {\n" +
      "      throw __Porffor_promise_result(p);\n" +
      "    }\n" +
      "  }\n" +
      "};\n",
  };
  for (const [file, contents] of Object.entries(files)) {
    const path = join(source, file);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents);
  }
  const archive = join(root, "porffor.tar.gz");
  const tar = Bun.spawn(["tar", "-czf", archive, "-C", root, basename(source)], { stderr: "pipe" });
  const [code, stderr] = await Promise.all([tar.exited, new Response(tar.stderr).text()]);
  if (code !== 0) throw new Error(`could not create fixture: ${stderr}`);
  const sha256 = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  return { archive, sha256 };
}

test("Porffor acquisition is atomic, shared concurrently, and warm-cache offline", async () => {
  const { archive, sha256 } = await fixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-porffor-cache-"));
  temporary.push(cacheRoot);
  let requests = 0;
  const fetcher = async () => {
    requests += 1;
    await Bun.sleep(5);
    return new Response(Bun.file(archive));
  };
  const options = { cacheRoot, url: "fixture", expectedSha256: sha256, fetcher };
  const roots = await Promise.all(Array.from({ length: 8 }, () => ensurePorffor(options)));
  expect(new Set(roots).size).toBe(1);
  expect(requests).toBe(1);
  expect((await readdir(cacheRoot)).filter((name) => name.startsWith(".porffor-"))).toEqual([]);
  const offline = await ensurePorffor({
    ...options,
    fetcher: async () => {
      throw new Error("offline fetch must not run");
    },
  });
  expect(offline).toBe(roots[0]);
});

test("integrity failures stop acquisition and publish no cache entry", async () => {
  const { archive } = await fixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-porffor-integrity-"));
  temporary.push(cacheRoot);
  const error = await ensurePorffor({
    cacheRoot,
    url: "fixture",
    expectedSha256: "0".repeat(64),
    fetcher: async () => new Response(Bun.file(archive)),
  }).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(PorfforToolchainError);
  if (!(error instanceof PorfforToolchainError)) throw error;
  expect(error.kind).toBe("integrity");
  expect((await readdir(cacheRoot)).some((name) => name.startsWith("porffor-"))).toBe(false);
});

test("the default call (no url/expectedSha256 override) never touches the network", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-porffor-vendored-"));
  temporary.push(cacheRoot);
  const dir = await ensurePorffor({
    cacheRoot,
    fetcher: async () => {
      throw new Error("the vendored archive must be used before any network fetch");
    },
  });
  expect(await readFile(join(dir, "runtime/index.js"), "utf8")).not.toBe("");
  // #242: generated typed-array join/toString keep a plain-array `parts`.
  expect(await readFile(join(dir, "compiler/builtins/typedarray.js"), "utf8")).toContain(
    "return Porffor.callThis(__Array_prototype_join, out, sep);",
  );
  // #238: TypedArray.prototype.set(source) with no offset copies to index 0.
  expect(await readFile(join(dir, "compiler/builtins/typedarray.js"), "utf8")).toContain(
    "const targetOffsetNum: number = ecma262.ToIntegerOrInfinity(offset);",
  );
  // #238/#241 (out-of-range typed-array reads and writes) are upstream's own
  // integer-indexed element access since alpha-18; no codegen patch remains.
  // Request, Response, Blob and File to the Fetch spec; byte bodies sent as bytes.
  expect(await readFile(join(dir, "runtime/native-fetch.js"), "utf8")).toContain(
    "sproutboat: byte bodies go out as their bytes",
  );
  // Unicode case mapping, the WHATWG TextDecoder and Fetch-spec Headers.
  expect(await readFile(join(dir, "compiler/builtins/string.ts"), "utf8")).toContain(
    "sproutboat: Unicode case mapping",
  );
  const globals = await readFile(join(dir, "runtime/fetch-globals.js"), "utf8");
  expect(globals).toContain("sproutboat: WHATWG UTF-8 decoder");
  expect(globals).toContain("sproutboat: Fetch-spec Headers");
  // B19: the native server streams ReadableStream bodies.
  expect(await readFile(join(dir, "compiler/uwebsockets.js"), "utf8")).toContain("sproutboat B19: streamed responses");
  // console colours only on a terminal.
  expect(await readFile(join(dir, "compiler/builtins/console.ts"), "utf8")).toContain("__Porffor_consoleColors");
  // JSON cycles, the JSON.parse reviver, typed-array toString tags, ISO date offsets,
  // base64 options, Map.groupBy and non-enumerable private fields (#286) are upstream's
  // own since alpha-19; json-cycles, groupby-private, date and base64 native tests cover them.
  // Alpha 19 new Function specialization checks a function body before walking the program.
  expect(await readFile(join(dir, "compiler/codegen.js"), "utf8")).toContain(
    "sproutboat: body check before the whole-program walks",
  );
  // B16: String.prototype.repeat doubles its copies.
  expect(await readFile(join(dir, "compiler/builtins/string.ts"), "utf8")).toContain("sproutboat B16: doubling repeat");
  // #287: full collections under load keep their free pages; the idle collection returns them.
  expect(await readFile(join(dir, "compiler/render.js"), "utf8")).toContain(
    "if (porf_gc_discard_now) porf_gc_discard_free_runs(); else porf_gc_discard_pending = 1;",
  );
  // #256: named class expressions inside functions are rewritten at parse time.
  expect(await readFile(join(dir, "compiler/parse.js"), "utf8")).toContain("sbClassSelf(ast); // sproutboat #256");
  expect(await readFile(join(dir, "compiler/sb-class-self.js"), "utf8")).toContain("sproutboat #256");
  // #237: replaceAll joins its pieces once instead of a strcat per match.
  expect(await readFile(join(dir, "compiler/builtins/string.ts"), "utf8")).toContain(
    "return Porffor.callThis(__Array_prototype_join, pieces, '');",
  );
  // Linear string building: the s += e pass, its builtins, replace(regex, fn) and character reads.
  expect(await readFile(join(dir, "compiler/parse.js"), "utf8")).toContain("sbStringAppend(ast);");
  expect(await readFile(join(dir, "compiler/sb-string-append.js"), "utf8")).toContain("__Porffor_strAppend");
  expect(await readFile(join(dir, "compiler/builtins/string.ts"), "utf8")).toContain(
    "export const __Porffor_strSettle = ",
  );
  expect(await readFile(join(dir, "compiler/builtins/regexp.ts"), "utf8")).toContain(
    "return __Porffor_regex_replaceCallback(rx, s, replaceValue);",
  );
  expect(await readFile(join(dir, "compiler/builtins/string_f64.ts"), "utf8")).toContain(
    "sproutboat: in-range number index",
  );
  expect(await readFile(join(dir, "compiler/builtins/json.ts"), "utf8")).not.toContain("text.charCodeAt(");
  // #236: the native-fetch build edits uWebSockets to accept HTTP/1.0.
  const index = await readFile(join(dir, "compiler/index.js"), "utf8");
  expect(index).toContain("import { sbPatchHttp10 } from './sb-http10.js';");
  expect(index).toContain("const uwsDir = uwebsockets.ensureUWebSockets();\n      sbPatchHttp10(uwsDir);");
  expect(await readFile(join(dir, "compiler/sb-http10.js"), "utf8")).toContain("export const sbPatchHttp10");
  // #235: every compiled unit keeps JavaScript's separate float roundings.
  expect(await readFile(join(dir, "compiler/index.js"), "utf8")).toContain("'-ffp-contract=off',");
  // #168: the real vendored source takes the null guard on the `then` probe.
  expect(await readFile(join(dir, "compiler/builtins/promise.ts"), "utf8")).toContain(
    "if (Porffor.type(value) == Porffor.TYPES.object && value != null) {",
  );
  // An unhandled rejection is reported through the prelude hook, not thrown out of the loop.
  expect(await readFile(join(dir, "compiler/builtins/promise.ts"), "utf8")).toContain(
    "globalThis.__sbOnUnhandledRejection",
  );
}, 60_000);

test("a corrupted warm cache is replaced from the verified archive", async () => {
  const { archive, sha256 } = await fixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-porffor-corrupt-"));
  temporary.push(cacheRoot);
  let requests = 0;
  const options = {
    cacheRoot,
    url: "fixture",
    expectedSha256: sha256,
    fetcher: async () => {
      requests += 1;
      return new Response(Bun.file(archive));
    },
  };
  const root = await ensurePorffor(options);
  await writeFile(join(root, "compiler/render.js"), "corrupt");
  await ensurePorffor(options);
  expect(requests).toBe(2);
  expect(await readFile(join(root, "compiler/render.js"), "utf8")).toContain('getenv("PORT")');
});

test("a cache built by an older toolchain version is rebuilt, not silently reused", async () => {
  const { archive, sha256 } = await fixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-porffor-stale-toolchain-"));
  temporary.push(cacheRoot);
  let requests = 0;
  const options = {
    cacheRoot,
    url: "fixture",
    expectedSha256: sha256,
    fetcher: async () => {
      requests += 1;
      return new Response(Bun.file(archive));
    },
  };
  const root = await ensurePorffor(options);
  const manifestPath = join(root, ".sproutboat-complete");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  expect(manifest.toolchainVersion).toBeTruthy();
  // Simulate a cache left behind by an older @sproutboat/toolchain publish
  // (baronunread/sproutboat#205): a patch.ts fix landing in a new version used
  // to sit unused because the cache key only tracked the upstream commit.
  await rm(manifestPath);
  await writeFile(manifestPath, JSON.stringify({ ...manifest, toolchainVersion: "0.0.0-stale" }));
  await ensurePorffor(options);
  expect(requests).toBe(2);
  const rebuilt = JSON.parse(await readFile(manifestPath, "utf8"));
  expect(rebuilt.toolchainVersion).toBe(manifest.toolchainVersion);
  // B19: an unreleased patch edit keeps the version; the patch fingerprint still rebuilds.
  expect(rebuilt.patchFingerprint).toBe(PATCH_FINGERPRINT);
  expect(root).toEndWith(`-${PATCH_FINGERPRINT}`);
  await rm(manifestPath);
  await writeFile(manifestPath, JSON.stringify({ ...rebuilt, patchFingerprint: "000000000000" }));
  await ensurePorffor(options);
  expect(requests).toBe(3);
  expect(JSON.parse(await readFile(manifestPath, "utf8")).patchFingerprint).toBe(PATCH_FINGERPRINT);
});

test("an interrupted stale lock is recovered", async () => {
  const { archive, sha256 } = await fixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-porffor-interrupted-"));
  temporary.push(cacheRoot);
  const lock = join(cacheRoot, `porffor-${PORFFOR_COMMIT_FULL}-${PATCH_FINGERPRINT}.lock`);
  await mkdir(lock);
  const stale = new Date(Date.now() - 10 * 60_000);
  await utimes(lock, stale, stale);
  const root = await ensurePorffor({
    cacheRoot,
    url: "fixture",
    expectedSha256: sha256,
    fetcher: async () => new Response(Bun.file(archive)),
  });
  expect(await readFile(join(root, "runtime/index.js"), "utf8")).toContain("fixture:");
  expect((await readdir(cacheRoot)).some((name) => name.endsWith(".lock"))).toBe(false);
});

test("download failures are classified without publishing partial state", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-porffor-download-"));
  temporary.push(cacheRoot);
  let attempts = 0;
  const error = await ensurePorffor({
    cacheRoot,
    url: "https://invalid.test/source.tar.gz",
    fetcher: async () => {
      attempts += 1;
      throw new Error("offline");
    },
  }).catch((cause: unknown) => cause);
  if (!(error instanceof PorfforToolchainError)) throw error;
  expect(error.kind).toBe("download");
  expect(attempts).toBe(2);
  expect(await readdir(cacheRoot)).toEqual([]);
});

test("the vendored archive is the one PORFFOR_ARCHIVE_URL serves: its root is porffor-<full commit>", () => {
  // codeload names the root after the ref in the URL, so an archive fetched by the short
  // commit has another root and digest than the pinned URL's, though the same files.
  const archive = join(import.meta.dir, `../vendor/porffor-${PORFFOR_COMMIT_FULL.slice(0, 7)}.tar.gz`);
  const list = Bun.spawnSync(["tar", "-tzf", archive], { stdout: "pipe" });
  expect(list.exitCode).toBe(0);
  expect(list.stdout.toString().split("\n")[0]).toBe(`porffor-${PORFFOR_COMMIT_FULL}/`);
});
