import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchPromiseTs, patchRenderJs, patchUwebsockets } from "./patch";

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
`;

// Porffor's compiler/uwebsockets.js, trimmed to the parts the patch touches:
// body limit (#56), the #156 status-line switch, #163's collect_headers, and
// #176's read_value forward decl / is_forbidden_response_header /
// write_response_value.
const SHIM = `static const size_t REQUEST_BODY_MAX_BYTES = 1024u * 1024u;

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
    expect(once).toContain("if (raw_body) porf_native_fetch_read_raw_bytes(body_value, &body_buf, &body_len);");
    expect(once).toContain("else porf_native_fetch_read_value(body_value, &body_buf, &body_len, &body_owned);");
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

// The part of Porffor's compiler/builtins/promise.ts the #168 patch anchors to.
const PROMISE_TS = `export const __Porffor_promise_resolve = (value: any, promise: any): void => {
  if (Porffor.type(value) == Porffor.TYPES.object) {
    // cheap prototype-chain probe for 'then' before the expensive Get below, does not invoke getters
    const thenHash: i32 = __Porffor_object_hash('then');
    let probe: any = value;
    while (Porffor.type(probe) == Porffor.TYPES.object) {
      if (Porffor.object.lookup(probe, 'then', thenHash) != 0) break;
      probe = __Porffor_object_getPrototype(probe);
    }
    if (Porffor.type(probe) != Porffor.TYPES.object) {
      __ecma262_FulfillPromise(promise, value);
      return;
    }
  }
};
`;

test("#168: promise-resolve's then-probe gets a fixed-point guard, idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-patch-promise-"));
  try {
    await mkdir(join(root, "compiler/builtins"), { recursive: true });
    await writeFile(join(root, "compiler/builtins/promise.ts"), PROMISE_TS);
    await patchPromiseTs(root);
    const once = await readFile(join(root, "compiler/builtins/promise.ts"), "utf8");

    expect(once).toContain("sproutboat #168");
    expect(once).toContain("let probeFound: boolean = false;");
    expect(once).toContain("if (Porffor.object.lookup(probe, 'then', thenHash) != 0) { probeFound = true; break; }");
    // The fixed-point guard mirrors _internal_object.ts's lastProto idiom.
    expect(once).toContain("Porffor.fastOr(probe == null, Porffor.IR.ptr(probe) == Porffor.IR.ptr(lastProto))");
    expect(once).toContain("if (!probeFound) {");
    // Belt-and-suspenders: a hard iteration cap terminates the loop even if
    // some other corruption shape (a drifting pointer, a longer cycle) defeats
    // the fixed-point check above.
    expect(once).toContain("if (probeSteps > 64) break;");
    // The old type-check-only exit condition is gone.
    expect(once).not.toContain("if (Porffor.type(probe) != Porffor.TYPES.object) {");

    await patchPromiseTs(root);
    expect(await readFile(join(root, "compiler/builtins/promise.ts"), "utf8")).toBe(once);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#168: a drifted promise builtin fails loudly instead of silently no-op'ing", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-patch-promise-drift-"));
  try {
    await mkdir(join(root, "compiler/builtins"), { recursive: true });
    await writeFile(join(root, "compiler/builtins/promise.ts"), "// nothing the patch recognizes\n");
    await expect(patchPromiseTs(root)).rejects.toThrow(/anchor not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
