/**
 * The standalone server on alpha 22: the alpha 19 uWebSockets shim (`compiler/uwebsockets.js`
 * `makeUWebSocketsShimSource()` of the patched alpha 19 tree: restart handover, WebSockets, request
 * and response streaming, R2 transfers, body limit, GC pacing) with its heap-layout sites rewritten
 * over flat data, so it drives the alpha 22 bridge (`native-fetch-a22.c`) instead of alpha 19's
 * render.js entry points. Everything else in the shim is C++ over plain C data and is kept verbatim.
 *
 * The alpha 19 shim read the heap in two places: building the request (the URL bytestring and the
 * headers array, alpha 19's `[len][entries][cap]` layout with packed jsvals) and reading the response
 * (`NativeFetchResponseParts`, the headers array walked three times, `sb_read_value_fast`). Here the
 * request goes to the bridge as method, URL, a name\0value\0 header blob and the body; the response
 * comes back from the bridge (`porf_native_fetch_response_complete_flat`) as status, the same kind of
 * blob and a body, during the dispatch call or later. The promise reactions alpha 19 attached in C
 * are gone: the dispatch shim's `then` callbacks complete the response from JS.
 *
 * Every edit is anchored on the shim's text and applied once; an anchor that is not found once fails
 * loudly (the alpha 19 chain changed under it).
 */

function replaceRegion(
  src: string,
  start: string,
  end: string,
  replacement: string,
  what: string,
  keepEnd = true,
): string {
  const a = src.indexOf(start);
  if (a < 0 || src.indexOf(start, a + 1) >= 0) throw new Error(`standalone shim: ${what}: start anchor not found once`);
  const b = src.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`standalone shim: ${what}: end anchor not found after the start`);
  return src.slice(0, a) + replacement + (keepEnd ? src.slice(b) : src.slice(b + end.length));
}
function replaceOnce(src: string, from: string, to: string, what: string): string {
  if (src.split(from).length !== 2) throw new Error(`standalone shim: ${what}: anchor not found once`);
  return src.replace(from, () => to);
}

const EXTERN_DECLS = String.raw`void porf_native_fetch_runtime_init(void);
void porf_native_fetch_collect_normal(void);
void porf_native_fetch_collect_normal_from(void* stack_top);
void porf_native_fetch_collect_quiet_from(void* stack_top);
int porf_native_fetch_needs_quiet_collect(void);
f64 porf_native_fetch_get_port(void);
int porf_native_fetch_should_collect(void);
void porf_native_fetch_drain_microtasks(void);
void porf_native_fetch_fire_timer(u32 id);
// sproutboat alpha 22: the request's flat parts go to the bridge; the reply comes back through
// porf_native_fetch_response_complete_flat below, during this call or later.
void porf_native_fetch_dispatch_flat(void* pending, const char* method, size_t method_len, const char* url, size_t url_len, const char* head, size_t head_len, const char* body, size_t body_len);
}
`;

const REQUEST_HELPERS = String.raw`static bool is_known_method(std::string_view m) {
  return m == "GET" || m == "HEAD" || m == "POST" || m == "PUT" || m == "DELETE" || m == "CONNECT" || m == "OPTIONS" || m == "TRACE" || m == "PATCH";
}

// The request URL as the alpha 19 server built it: http://<host><target>, or the target alone without a host.
static std::string build_request_url(uWS::HttpRequest* req) {
  std::string_view host = req->getHeader("host");
  std::string_view target = req->getFullUrl();
  std::string url;
  if (!host.empty()) {
    url.reserve(7 + host.size() + target.size());
    url.append("http://");
    url.append(host.data(), host.size());
  }
  url.append(target.data(), target.size());
  return url;
}

// The request headers as one name\0value\0 blob (the dispatch shim splits it into the flat Headers
// list), with x-sb-remote-addr set by the server (sproutboat #163; a client-sent one is dropped).
static std::string collect_headers_flat(uWS::HttpRequest* req, uWS::HttpResponse<false>* res) {
  std::string head;
  for (auto [key, value] : *req) {
    if (key == "x-sb-remote-addr") continue;
    head.append(key.data(), key.size());
    head.push_back('\0');
    head.append(value.data(), value.size());
    head.push_back('\0');
  }
  const std::string_view peer = res ? res->getRemoteAddressAsText() : std::string_view();
  head.append("x-sb-remote-addr");
  head.push_back('\0');
  head.append(peer.data(), peer.size());
  head.push_back('\0');
  return head;
}

struct PendingRequest {
  bool aborted = false;
  bool finished = false;
  std::string method;
  std::string url;
  std::string head;
  std::string body;
};
`;

const WS_FINISH_LOOP = String.raw`  {
    size_t at = 0;
    std::string_view name, value;
    while (sb_head_next(head, &at, &name, &value)) if (name == "sec-websocket-protocol") protocol.assign(value.data(), value.size());
  }
`;

const RESPONSE_WRITE = String.raw`// A name\0value\0 blob (the dispatch shim's __sbSerialize): the next pair at *at, or false at its end.
static bool sb_head_next(const std::string& head, size_t* at, std::string_view* name, std::string_view* value) {
  if (*at >= head.size()) return false;
  const size_t n0 = *at;
  const size_t n1 = head.find('\0', n0);
  if (n1 == std::string::npos) return false;
  const size_t v0 = n1 + 1;
  const size_t v1 = head.find('\0', v0);
  if (v1 == std::string::npos) return false;
  *name = std::string_view(head).substr(n0, n1 - n0);
  *value = std::string_view(head).substr(v0, v1 - v0);
  *at = v1 + 1;
  return true;
}

// sproutboat alpha 22: the response arrives flat from the bridge (status, the header blob, the body
// bytes), already UTF-8 (or the raw bytes of an x-sb-raw-body response); nothing here reads the heap.
static void write_response_value_flat(uWS::HttpResponse<false>* res, i32 status, const std::string& head, std::string_view body, bool head_request) {
  sb_reqbody_responding(res);
  u32 stream_id = 0; // sproutboat B19
  u32 sb_ws_id = 0; // sproutboat: WebSockets
  {
    size_t at = 0;
    std::string_view name, value;
    while (sb_head_next(head, &at, &name, &value)) {
      if (name == "x-sb-websocket") sb_ws_id = (u32)strtoul(std::string(value).c_str(), nullptr, 10);
      if (name == "x-sb-stream") stream_id = (u32)strtoul(std::string(value).c_str(), nullptr, 10);
    }
  }
  // A HEAD answer has no body, so its length is the one the app declared (the Content-Length of the GET it stands for).
  long long declared_length = -1;
  if (head_request) {
    size_t at = 0;
    std::string_view name, value;
    while (sb_head_next(head, &at, &name, &value))
      if (name == "content-length") declared_length = strtoll(std::string(value).c_str(), nullptr, 10);
  }
  res->cork([res, status, &head, body, stream_id, sb_ws_id, head_request, declared_length]() {
    if (sb_ws_id || status == 101) { sb_ws_finish(res, sb_ws_id, head); return; }
    if (status != 200) res->writeStatus(lookup_status_line(status));
    size_t at = 0;
    std::string_view name, value;
    while (sb_head_next(head, &at, &name, &value)) {
      if (!is_forbidden_response_header(name)) res->writeHeader(name, value);
    }
    if (sb_rs_closing) res->writeHeader("Connection", "close"); // sproutboat: draining
    if (stream_id) sb_stream_attach(stream_id, res); // sproutboat B19: the prelude pumps the body
    else if (head_request) res->endWithoutBody(declared_length >= 0 ? (size_t)declared_length : body.size());
    else res->end(body);
  });
}

`;

const PENDING_RESPONSE = String.raw`struct PendingResponse {
  uWS::HttpResponse<false>* res = nullptr;
  bool aborted = false;
  bool finished = false;
  bool head = false; // the request was a HEAD: its answer carries a length and no body
  explicit PendingResponse(uWS::HttpResponse<false>* res) : res(res) {}
};
// Every dispatched request until its reply: the reply may come after the client went away, and a
// handler that never settles keeps its entry (as alpha 19 kept its reactions).
static std::unordered_set<PendingResponse*> sb_pending_live;

extern "C" void porf_native_fetch_response_complete_flat(void* raw_pending, i32 status, const char* head, size_t head_len, const char* body, size_t body_len, i32 is_reject) {
  auto* pending = (PendingResponse*)raw_pending;
  if (!pending || sb_pending_live.find(pending) == sb_pending_live.end() || pending->finished) return;
  pending->finished = true;
  if (!pending->aborted && pending->res) {
    if (is_reject) {
      respond_with_error(pending->res, "500 Internal Server Error", "native fetch promise rejected", true);
    } else {
      const std::string head_blob(head, head_len);
      write_response_value_flat(pending->res, status, head_blob, std::string_view(body, body_len), pending->head);
    }
  }
  sb_pending_live.erase(pending);
  delete pending;
  collect_after_request();
}

`;

const HANDLE_REQUEST = String.raw`// Dispatches the request to the compiled handler. The reply arrives through
// porf_native_fetch_response_complete_flat, during this call (a synchronous handler, or a promise
// settled by the microtasks it queued) or later; the reply collects, so nothing here does.
static void handle_request(uWS::HttpResponse<false>* res, std::string_view method, const std::string& url, const std::string& head, std::string_view request_body, bool* aborted) {
  if (aborted && *aborted) return;
  auto* pending = new PendingResponse(res);
  pending->head = method == "HEAD";
  sb_pending_live.insert(pending);
  res->onAborted([pending]() {
    if (pending->finished || pending->aborted) return;
    pending->aborted = true;
    sb_reqbody_aborted(pending->res);
    pending->res = nullptr;
  });
  porf_native_fetch_dispatch_flat(pending, method.data(), method.size(), url.data(), url.size(), head.data(), head.size(), request_body.data(), request_body.size());
}
`;

const ON_REQUEST = String.raw`static void on_request(uWS::HttpResponse<false>* res, uWS::HttpRequest* req) {
  const std::string_view method_view = req->getCaseSensitiveMethod();
  if (!is_known_method(method_view)) {
    respond_with_error(res, "400 Bad Request", "unsupported method", true);
    collect_after_request();
    return;
  }

  if (try_handle_r2_transfer(res, req, method_view)) return;
  const std::string method(method_view);
  const std::string url = build_request_url(req);
  const std::string head = collect_headers_flat(req, res);

  const std::string_view content_length = req->getHeader("content-length");
  const std::string_view transfer_encoding = req->getHeader("transfer-encoding");
  size_t declared_content_length = 0;

  if (!content_length.empty() && !parse_content_length(content_length, &declared_content_length)) {
    respond_with_error(res, "400 Bad Request", "invalid content-length", true);
    collect_after_request();
    return;
  }

  if (transfer_encoding.empty() && declared_content_length == 0) {
    handle_request(res, method, url, head, std::string_view(), nullptr);
    return;
  }

  // sproutboat: streamed request bodies, from compatibility date 2026-10-27
  if (sb_reqbody_on && req->getHeader("x-sb-trigger").empty() && req->getHeader("x-sb-rpc").empty()) {
    if (declared_content_length > sb_request_body_stream_max()) {
      respond_with_error(res, "413 Payload Too Large", "request body too large", true);
      collect_after_request();
      return;
    }
    const u32 body_id = sb_reqbody_open(res);
    res->onAborted([res]() { sb_reqbody_aborted(res); });
    res->onData([body_id](std::string_view chunk, bool is_last) { sb_reqbody_data(body_id, chunk, is_last); });
    sb_reqbody_current = body_id;
    handle_request(res, method, url, head, std::string_view(), nullptr);
    sb_reqbody_current = 0;
    return;
  }
  if (declared_content_length > REQUEST_BODY_MAX_BYTES || REQUEST_BODY_MAX_BYTES == 0) {
    respond_with_error(res, "413 Payload Too Large", "request body too large", true);
    collect_after_request();
    return;
  }

  auto pending = std::make_shared<PendingRequest>();
  pending->method = method;
  pending->url = url;
  pending->head = head;
  res->onAborted([pending]() {
    if (finish_pending_request(pending.get())) {
      pending->aborted = true;
      release_pending_request(pending.get());
    }
  });

  res->onData([res, pending](std::string_view chunk, bool is_last) {
    if (pending->finished) return;
    if (body_would_exceed_limit(pending->body.size(), chunk.size())) {
      finish_pending_request(pending.get());
      release_pending_request(pending.get());
      respond_with_error(res, "413 Payload Too Large", "request body too large", true);
      return;
    }

    pending->body.append(chunk.data(), chunk.size());
    if (is_last) {
      finish_pending_request(pending.get());
      handle_request(res, pending->method, pending->url, pending->head, pending->body, &pending->aborted);
      release_pending_request(pending.get());
    }
  });
}
`;

/** The alpha 22 server shim from the alpha 19 shim source (`makeUWebSocketsShimSource()` of the patched alpha 19 tree). */
export function standaloneShimA22(alpha19Shim: string): string {
  let s = alpha19Shim;
  if (!s.includes("#include <unordered_map>\n")) throw new Error("standalone shim: includes: anchor not found");
  s = s.replace("#include <unordered_map>\n", "#include <unordered_map>\n#include <unordered_set>\n");
  // 1. the extern block: flat entry points, no heap
  s = replaceRegion(
    s,
    "struct NativeFetchResponseParts {",
    "static inline void __porffor_js_enter(void) {}",
    EXTERN_DECLS + "\n",
    "extern block",
  );
  // 2. request build: the method bytestrings, packing helpers, static init, URL and headers in the heap, roots
  s = replaceRegion(
    s,
    "static i32 method_get = 0;\n",
    "static size_t sb_request_body_max(void) {",
    REQUEST_HELPERS + "\n",
    "request build",
  );
  s = replaceOnce(
    s,
    "static void release_pending_request(PendingRequest* pending) {\n  pending->roots.clear();\n",
    "static void release_pending_request(PendingRequest* pending) {\n",
    "release_pending_request",
  );
  // 3. the WebSocket finish reads the protocol from the blob
  s = replaceOnce(
    s,
    "static u32 sb_ws_response_id(uWS::HttpResponse<false>* res, i32 headers_entries_ptr, bool* upgrade);\nstatic void sb_ws_finish(uWS::HttpResponse<false>* res, u32 id, i32 headers_entries_ptr);\n",
    "static void sb_ws_finish(uWS::HttpResponse<false>* res, u32 id, const std::string& head);\nstatic bool sb_head_next(const std::string& head, size_t* at, std::string_view* name, std::string_view* value);\n",
    "ws forward declarations",
  );
  s = replaceOnce(
    s,
    "static void sb_ws_finish(uWS::HttpResponse<false>* res, u32 id, i32 headers_entries_ptr) {",
    "static void sb_ws_finish(uWS::HttpResponse<false>* res, u32 id, const std::string& head) {",
    "ws finish signature",
  );
  s = replaceRegion(
    s,
    "  const i32 headers_len = *((i32*)(porf_mem + headers_entries_ptr)) / 2;\n  const i32 headers_entries = *((i32*)(porf_mem + headers_entries_ptr + 4));\n  for (i32 i = 0; i < headers_len; i++) {\n    const i32 name_base = headers_entries + i * 16;\n    const struct jsval name_value = unpack_jsval(*((u64*)(porf_mem + name_base)));\n    const struct jsval value_value = unpack_jsval(*((u64*)(porf_mem + name_base + 8)));",
    "  SbWsData data;\n",
    WS_FINISH_LOOP,
    "ws finish loop",
  );
  // 4. the response: the fast reader and write_response_value over the heap become the flat writer
  s = replaceRegion(
    s,
    "// sproutboat: a response's ASCII strings are written in place\n",
    "struct PendingResponse {",
    RESPONSE_WRITE,
    "response write",
  );
  // 5. the pending response and its completion (no reactions)
  s = replaceRegion(
    s,
    "struct PendingResponse {",
    "// sproutboat: streamed request bodies\nstatic const size_t SB_REQBODY_HIGH",
    PENDING_RESPONSE,
    "pending response",
  );
  // 6. dispatch
  s = replaceRegion(
    s,
    "static bool handle_request(uWS::HttpResponse<false>* res, i32 method_ptr,",
    '\nextern "C" {\n  struct sb_r2_transfer_ctx;',
    HANDLE_REQUEST,
    "handle_request",
  );
  // 7. on_request over flat data
  s = replaceRegion(
    s,
    "static void on_request(uWS::HttpResponse<false>* res, uWS::HttpRequest* req) {",
    "// sproutboat: async broker exchanges\n",
    ON_REQUEST,
    "on_request",
  );
  // 8. main: no static strings to pre-allocate
  s = replaceOnce(
    s,
    "  porf_native_fetch_runtime_init();\n  porf_native_fetch_static_init();\n",
    "  porf_native_fetch_runtime_init();\n",
    "main",
  );
  for (const gone of [
    "porf_mem",
    "pack_bytestring",
    "unpack_jsval",
    "NativeFetchResponseParts",
    "sb_read_value_fast",
    "porf_native_fetch_call_handler",
    "porf_native_fetch_finalize_response",
    "porf_native_fetch_attach_response",
    "porf_native_fetch_promise_state",
  ])
    if (s.includes(gone)) throw new Error(`standalone shim: ${gone} still referenced after the edits`);
  return s;
}
