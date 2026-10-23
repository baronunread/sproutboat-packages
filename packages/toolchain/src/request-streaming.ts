/**
 * Streamed request bodies for standalone and platform sprouts, patched into Porffor's
 * uWebSockets shim (compiler/uwebsockets.js) by patchStreamingRequests.
 *
 * Porffor's shim buffered the whole body in a std::string, copied it into the heap and only
 * then ran the handler. When the prelude turns streaming on (sb_reqbody_enable, from
 * compatibility date 2026-10-27), a request with a body runs its handler as soon as the
 * headers arrive. The body's bytes wait in a per-request buffer (SbReqBody) until the
 * prelude's ReadableStream reads them: it polls (sb_reqbody_poll), copies what is there
 * straight into a Uint8Array (sb_reqbody_take), or parks a timer (sb_reqbody_wait) that the
 * shim fires when more bytes, the end or an error arrive. Above SB_REQBODY_HIGH buffered bytes
 * the socket is paused until the stream reads them, so a slow reader holds at most that much.
 *
 * The limit (SB_REQUEST_BODY_MAX, default 100 MiB when streaming) is checked against the
 * declared Content-Length before the handler runs (413), and against the bytes received: a
 * chunked body that goes past it closes the connection, which the handler sees as an aborted
 * body. Internal trigger and RPC calls (x-sb-trigger, x-sb-rpc) stay buffered: the prelude
 * reads their bodies synchronously.
 *
 * Hosts without this shim (sproutd's workers) get the weak REQBODY_STUBS: sb_reqbody_enable
 * returns 0 and the prelude keeps the buffered body.
 */

/** Weak fallbacks in render.js, beside the B19 ones. */
export const REQBODY_STUBS =
  "// sproutboat: request-body streaming fallbacks, overridden by the native server's shim\n" +
  "__attribute__((weak)) int sb_reqbody_enable(void) { return 0; }\n" +
  "__attribute__((weak)) unsigned int sb_reqbody_take_current(void) { return 0; }\n" +
  "__attribute__((weak)) long long sb_reqbody_poll(unsigned int id) { (void)id; return -2; }\n" +
  "__attribute__((weak)) size_t sb_reqbody_take(unsigned int id, char* out, size_t cap) { (void)id; (void)out; (void)cap; return 0; }\n" +
  "__attribute__((weak)) void sb_reqbody_wait(unsigned int id, unsigned int timer) { (void)id; (void)timer; }\n" +
  "__attribute__((weak)) void sb_reqbody_close(unsigned int id) { (void)id; }\n\n";

/** Forward declarations, before the B19 registry (its abort handler reports to the body). */
export const REQBODY_DECLS_ANCHOR = "// sproutboat B19: streamed responses\n";
export const REQBODY_DECLS =
  "// sproutboat: streamed request bodies (request-streaming.ts)\n" +
  "static void sb_reqbody_aborted(uWS::HttpResponse<false>* res);\n" +
  "static void sb_reqbody_responding(uWS::HttpResponse<false>* res);\n";

/** A streamed response whose client goes away also ends the request body it may still read. */
export const REQBODY_STREAM_ABORT_ANCHOR = "  res->onAborted([id]() {\n    auto found = sb_streams.find(id);\n";
export const REQBODY_STREAM_ABORT_INJECT =
  "  res->onAborted([id, res]() {\n    sb_reqbody_aborted(res);\n    auto found = sb_streams.find(id);\n";

/** A pending (async) response's abort handler replaces the body's: it reports to it too. */
export const REQBODY_PENDING_ABORT_ANCHOR = "        pending->aborted = true;\n        pending->res = nullptr;\n";
export const REQBODY_PENDING_ABORT_INJECT =
  "        pending->aborted = true;\n        sb_reqbody_aborted(pending->res);\n        pending->res = nullptr;\n";

/** The response is about to be written: a paused body must flow again, or the socket stalls. */
export const REQBODY_WRITE_ANCHOR =
  "static void write_response_value(uWS::HttpResponse<false>* res, struct jsval response, bool* aborted) {\n";
export const REQBODY_WRITE_INJECT = REQBODY_WRITE_ANCHOR + "  sb_reqbody_responding(res);\n";

/** Inserted before handle_request. C++ inside a JS template literal: no backticks, no ${. */
export const REQBODY_REGISTRY_ANCHOR =
  "static bool handle_request(uWS::HttpResponse<false>* res, i32 method_ptr, i32 url_ptr, i32 headers_ptr, std::string_view request_body, bool* aborted, NativeRequestRoots* roots) {\n";
export const REQBODY_REGISTRY = String.raw`// sproutboat: streamed request bodies
static const size_t SB_REQBODY_HIGH = 1024u * 1024u;
struct SbReqBody {
  uWS::HttpResponse<false>* res = nullptr;
  std::string buf;
  size_t received = 0;
  u32 waiter = 0;
  bool ended = false, failed = false, paused = false, responding = false, read = false, closed = false;
};
static std::unordered_map<u32, SbReqBody> sb_reqbodies;
static std::unordered_map<uWS::HttpResponse<false>*, u32> sb_reqbody_by_res;
static u32 sb_reqbody_next = 1;
static u32 sb_reqbody_current = 0;
static bool sb_reqbody_on = false;

extern "C" int sb_reqbody_enable(void) { sb_reqbody_on = true; return 1; }
extern "C" unsigned int sb_reqbody_take_current(void) { const u32 id = sb_reqbody_current; sb_reqbody_current = 0; return id; }

static size_t sb_request_body_stream_max(void) {
  static size_t cached = 0;
  if (cached == 0) {
    const char* raw = getenv("SB_REQUEST_BODY_MAX");
    long parsed = raw && *raw ? atol(raw) : 0;
    cached = parsed > 0 ? (size_t)parsed : 100u * 1024u * 1024u;
  }
  return cached;
}

static void sb_reqbody_forget(u32 id) {
  auto it = sb_reqbodies.find(id);
  if (it == sb_reqbodies.end()) return;
  if (it->second.res) {
    auto r = sb_reqbody_by_res.find(it->second.res);
    if (r != sb_reqbody_by_res.end() && r->second == id) sb_reqbody_by_res.erase(r);
  }
  sb_reqbodies.erase(it);
}

// Fires the timer the prelude parked, if any: more bytes, the end or an error arrived.
static void sb_reqbody_wake(u32 id) {
  auto it = sb_reqbodies.find(id);
  if (it == sb_reqbodies.end() || !it->second.waiter) return;
  const u32 timer = it->second.waiter;
  it->second.waiter = 0;
  __porffor_js_enter();
  porf_native_fetch_timer_clear(timer);
  porf_native_fetch_fire_timer(timer);
  __porffor_js_exit();
}

// While the response is being written the socket can't be paused (it would hold the response
// back too), so a body still being read may buffer this much before it fails instead.
static const size_t SB_REQBODY_RESPONDING_MAX = 8u * 1024u * 1024u;

// The body's bytes as uWS hands them over.
static void sb_reqbody_data(u32 id, std::string_view chunk, bool is_last) {
  auto it = sb_reqbodies.find(id);
  if (it == sb_reqbodies.end()) return;
  SbReqBody& b = it->second;
  if (is_last) b.ended = true;
  if (b.failed || b.closed) {
    if (is_last) sb_reqbody_forget(id);
    return;
  }
  b.received += chunk.size();
  if (b.received > sb_request_body_stream_max()) {
    // Too large: the handler is already running, so the connection is closed (its abort
    // handler cleans up the response) and the stream fails.
    b.failed = true;
    std::string().swap(b.buf);
    auto* res = b.responding ? nullptr : b.res;
    sb_reqbody_wake(id);
    if (res) res->close();
    return;
  }
  b.buf.append(chunk.data(), chunk.size());
  if (b.responding && b.buf.size() > SB_REQBODY_RESPONDING_MAX) {
    b.failed = true;
    std::string().swap(b.buf);
  } else if (!b.ended && !b.responding && !b.paused && b.buf.size() >= SB_REQBODY_HIGH && b.res) {
    b.paused = true;
    b.res->pause();
  }
  sb_reqbody_wake(id);
}

static void sb_reqbody_aborted(uWS::HttpResponse<false>* res) {
  auto r = sb_reqbody_by_res.find(res);
  if (r == sb_reqbody_by_res.end()) return;
  const u32 id = r->second;
  sb_reqbody_by_res.erase(r);
  auto it = sb_reqbodies.find(id);
  if (it == sb_reqbodies.end()) return;
  it->second.res = nullptr;
  if (!it->second.ended) it->second.failed = true;
  std::string().swap(it->second.buf);
  sb_reqbody_wake(id);
  it = sb_reqbodies.find(id);
  if (it != sb_reqbodies.end() && (it->second.closed || !it->second.read || it->second.failed)) sb_reqbody_forget(id);
}

// The response is about to be written. A body nothing has read yet never will be (the
// handler has answered): drop it. One being read flows on, unpaused.
static void sb_reqbody_responding(uWS::HttpResponse<false>* res) {
  auto r = sb_reqbody_by_res.find(res);
  if (r == sb_reqbody_by_res.end()) return;
  const u32 id = r->second;
  auto it = sb_reqbodies.find(id);
  if (it == sb_reqbodies.end()) return;
  SbReqBody& b = it->second;
  b.responding = true;
  if (b.paused && b.res) { b.paused = false; b.res->resume(); }
  if (!b.read) {
    std::string().swap(b.buf);
    if (b.ended) sb_reqbody_forget(id);
    else b.failed = true;
  }
}

// -2 unknown or failed, -1 ended, 0 nothing yet, else the bytes waiting.
extern "C" long long sb_reqbody_poll(unsigned int id) {
  auto it = sb_reqbodies.find(id);
  if (it == sb_reqbodies.end()) return -2;
  SbReqBody& b = it->second;
  b.read = true;
  if (!b.buf.empty()) return (long long)b.buf.size();
  if (b.failed) return -2;
  return b.ended ? -1 : 0;
}

// Moves up to cap waiting bytes into out, and lets a paused socket read again.
extern "C" size_t sb_reqbody_take(unsigned int id, char* out, size_t cap) {
  auto it = sb_reqbodies.find(id);
  if (it == sb_reqbodies.end()) return 0;
  SbReqBody& b = it->second;
  const size_t n = b.buf.size() < cap ? b.buf.size() : cap;
  memcpy(out, b.buf.data(), n);
  if (n == b.buf.size()) std::string().swap(b.buf);
  else b.buf.erase(0, n);
  if (b.paused && b.buf.size() < SB_REQBODY_HIGH && b.res) { b.paused = false; b.res->resume(); }
  return n;
}

extern "C" void sb_reqbody_wait(unsigned int id, unsigned int timer) {
  auto it = sb_reqbodies.find(id);
  if (it == sb_reqbodies.end()) return;
  it->second.waiter = timer;
}

// The stream is done with the body: read to its end, failed or cancelled.
extern "C" void sb_reqbody_close(unsigned int id) {
  auto it = sb_reqbodies.find(id);
  if (it == sb_reqbodies.end()) return;
  SbReqBody& b = it->second;
  b.closed = true;
  std::string().swap(b.buf);
  if (b.paused && b.res) { b.paused = false; b.res->resume(); }
  if (b.ended || b.failed || !b.res) sb_reqbody_forget(id);
}

static u32 sb_reqbody_open(uWS::HttpResponse<false>* res) {
  u32 id = sb_reqbody_next++;
  if (id == 0) id = sb_reqbody_next++;
  SbReqBody b;
  b.res = res;
  sb_reqbodies[id] = std::move(b);
  sb_reqbody_by_res[res] = id;
  return id;
}

`;

/** In on_request, before the buffered path's limit check. */
export const REQBODY_DISPATCH_ANCHOR =
  "  if (declared_content_length > REQUEST_BODY_MAX_BYTES || REQUEST_BODY_MAX_BYTES == 0) {\n";
export const REQBODY_DISPATCH = String.raw`  // sproutboat: streamed request bodies, from compatibility date 2026-10-27
  if (sb_reqbody_on && req->getHeader("x-sb-trigger").empty() && req->getHeader("x-sb-rpc").empty()) {
    if (declared_content_length > sb_request_body_stream_max()) {
      __porffor_js_exit();
      respond_with_error(res, "413 Payload Too Large", "request body too large", true);
      collect_after_request();
      return;
    }
    const u32 body_id = sb_reqbody_open(res);
    res->onAborted([res]() { sb_reqbody_aborted(res); });
    res->onData([body_id](std::string_view chunk, bool is_last) { sb_reqbody_data(body_id, chunk, is_last); });
    sb_reqbody_current = body_id;
    const bool completed = handle_request(res, method_ptr, url_ptr, headers_ptr, std::string_view(), nullptr, nullptr);
    sb_reqbody_current = 0;
    __porffor_js_exit();
    if (completed) collect_after_request();
    return;
  }
`;

/** Every edit to the shim: [anchor, replacement]. */
export const REQBODY_EDITS: readonly (readonly [string, string])[] = [
  [REQBODY_DECLS_ANCHOR, REQBODY_DECLS + REQBODY_DECLS_ANCHOR],
  [REQBODY_STREAM_ABORT_ANCHOR, REQBODY_STREAM_ABORT_INJECT],
  [REQBODY_WRITE_ANCHOR, REQBODY_WRITE_INJECT],
  [REQBODY_PENDING_ABORT_ANCHOR, REQBODY_PENDING_ABORT_INJECT],
  [REQBODY_REGISTRY_ANCHOR, REQBODY_REGISTRY + REQBODY_REGISTRY_ANCHOR],
  [REQBODY_DISPATCH_ANCHOR, REQBODY_DISPATCH + REQBODY_DISPATCH_ANCHOR],
];

export const REQBODY_MARKER = "sproutboat: streamed request bodies";
