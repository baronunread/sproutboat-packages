import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchRenderJs, patchUwebsockets } from "./patch";

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
// body limit (#56), the #156 status-line switch, and #163's collect_headers.
const SHIM = `static const size_t REQUEST_BODY_MAX_BYTES = 1024u * 1024u;

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
    expect(once).not.toContain("*out_buf = (const char*)(MEM + ptr + 4);");

    await patchRenderJs(root);
    expect(await readFile(join(root, "compiler/render.js"), "utf8")).toBe(once);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
