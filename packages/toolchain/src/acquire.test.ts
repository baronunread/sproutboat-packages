import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ensurePorffor, PORFFOR_COMMIT_FULL, PorfforToolchainError } from "./index";

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
    "compiler/render.js": "// sb_native_utf8_scalar_v1\n" +
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
      "#define PORF_CORO_STACK_SIZE (256u * 1024u)\n",
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
      "      '-fno-ident', '-ffunction-sections', '-fdata-sections',\n      ...darwinReleaseCompileArgs,\n        uSocketsArchive,\n        '-lm'\n",
    "compiler/precompile.js":
      "const fs = require('node:fs');\n" +
      "const path = require('node:path');\n" +
      "fs.writeFileSync(path.join(__dirname, 'builtins_precompiled.js'), fs.readFileSync(path.join(__dirname, 'builtins/typedarray.js')));\n",
    "compiler/builtins_precompiled.js": "fixture:precompiled\n",
    "compiler/builtins/date.ts": "export const __ecma262_ParseDTSF = (string: string) => {\n  let n: number = 0;\n  let nInd: number = 0;\n\n  const len: i32 = string.length;\n  const endPtr: i32 = Porffor.IR.ptr(string) + len;\n  let ptr: i32 = Porffor.IR.ptr(string);\n\n  while (ptr <= endPtr) { // <= to include extra null byte to set last n\n    const chr: i32 = Porffor.IR.loadU8(ptr++, 4);\n    if (Porffor.fastAnd(chr >= 48, chr <= 57)) { // 0-9\n      n *= 10;\n      n += chr - 48;\n      continue;\n    }\n\n    if (chr == 45) { // -\n      if (Porffor.fastOr(ptr == Porffor.IR.ptr(string), nInd == 7)) n = -n;\n    }\n\n    if (n > 0) {\n      if (nInd == 0) y = n;\n        else if (nInd == 1) m = n - 1;\n        else if (nInd == 2) dt = n;\n        else if (nInd == 3) h = n;\n        else if (nInd == 4) min = n;\n        else if (nInd == 5) s = n;\n        else if (nInd == 6) milli = n;\n        else if (nInd == 7) tzHour = n;\n        else if (nInd == 8) tzMin = n;\n\n      n = 0;\n      nInd++;\n    }\n  }\n\n  h += tzHour;\n  min += tzMin;\n};\n// RFC 7231 or Date.prototype.toString() parser\n",
    "compiler/builtins/typedarray.js":
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
      'export const makeUWebSocketsShimSource = () => `\n#include "App.h"\n' +
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
      "  const i32 headers_ptr = collect_headers(req);\n}\n" +
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
      "}\n",
    "compiler/builtins/json.ts": "// sb_json_utf16_v1\n",
    "runtime/fetch-globals.js": "// sb_text_encoder_scalar_v1\n",
    "compiler/codegen.js":
      "      stmt(scope, Store(ctype, addr, 4, ctype === 'f64' || ctype === 'f32' ? f : signed ? Convert(T.i32, f) : Convert(T.u32, f, 0)));\n" +
      "      return Box(Convert(T.f64, Un('~', T.i32, Convert(T.i32, numValue(toNumeric())))), Const(T.i32, TYPES.number));\n" +
      "  const taGet = (ctype, size, signed = true) => () => {\n" +
      "    const loaded = Load(ctype, taAddr(size), 4);\n" +
      "    const f = ctype === 'f32' || ctype === 'f64' ? loaded : Convert(T.f64, loaded, signed ? CONVERT_SIGNED : 0);\n" +
      "    return Box(f, Const(T.i32, TYPES.number));\n" +
      "  };\n",
    "compiler/builtins/string.ts":
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
    ".replaceAll('const parts: ' + name + ' =', 'const parts: any[] =')",
  );
  // #238: TypedArray.prototype.set(source) with no offset copies to index 0.
  expect(await readFile(join(dir, "compiler/builtins/typedarray.js"), "utf8")).toContain(
    "offset = ecma262.ToIntegerOrInfinity(offset);",
  );
  // #238: ~ wraps (ToInt32), and out-of-range typed-array reads are undefined.
  const codegen = await readFile(join(dir, "compiler/codegen.js"), "utf8");
  expect(codegen).toContain("Convert(T.i32, toUint32(scope, numValue(toNumeric())), CONVERT_RANGE_KNOWN | CONVERT_SIGNED)");
  expect(codegen).toContain("Box(f, Const(T.i32, TYPES.number)), valUndefined());");
  // #241: out-of-range typed-array writes are ignored in user code.
  expect(codegen).toContain("if (globalThis.precompile) store();");
  // #238: integer typed-array stores wrap modulo 2^n instead of saturating.
  expect(await readFile(join(dir, "compiler/codegen.js"), "utf8")).toContain(
    "signed ? Convert(T.i32, toUint32(scope, f), CONVERT_RANGE_KNOWN | CONVERT_SIGNED) : toUint32(scope, f)",
  );
  // #256: named class expressions inside functions are rewritten at parse time.
  expect(await readFile(join(dir, "compiler/parse.js"), "utf8")).toContain("sbClassSelf(ast); // sproutboat #256");
  expect(await readFile(join(dir, "compiler/sb-class-self.js"), "utf8")).toContain("sproutboat #256");
  // #237: replaceAll joins its pieces once instead of a strcat per match.
  expect(await readFile(join(dir, "compiler/builtins/string.ts"), "utf8")).toContain(
    "return Porffor.callThis(__Array_prototype_join, pieces, '');",
  );
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
});

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
});

test("an interrupted stale lock is recovered", async () => {
  const { archive, sha256 } = await fixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-porffor-interrupted-"));
  temporary.push(cacheRoot);
  const lock = join(cacheRoot, `porffor-${PORFFOR_COMMIT_FULL}.lock`);
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
