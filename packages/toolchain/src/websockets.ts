/**
 * Client sockets for standalone and platform sprouts, patched into Porffor's uWebSockets shim
 * (compiler/uwebsockets.js) by patchWebSockets.
 *
 * The prelude (runtime 0.33, from compatibility date 2026-10-30) stands a host socket in for the
 * client end of a 101 response: it opens one (sb_ws_hook 'o'), marks the Response with the
 * internal x-sb-websocket: <id> header, sends on the socket ('t' text, 'b' bytes, 'c' close),
 * polls what arrived ('p', 'i'), acknowledges what it dispatched ('k') and parks a timer for the
 * next event ('w'). sproutd's worker bridge implements that hook over its IPC. This shim
 * implements it in the server itself, which is one process with the handler:
 *
 * - The server registers a uWS WebSocket behavior beside its HTTP handler. A GET with
 *   `Upgrade: websocket` reaches the handler as a request, as in sproutd, and remembers the
 *   key and uWS context it may upgrade into.
 * - When the response comes back as 101 with x-sb-websocket, the connection is upgraded (the
 *   protocol the app chose goes out as Sec-WebSocket-Protocol). Any other answer is plain HTTP;
 *   a 101 to a request that was not an upgrade is a 500.
 * - What the app sent before the 101 was written waits on the socket and goes out right after.
 * - Messages from the client queue on the socket; the prelude polls them. With more than
 *   1 MiB dispatched-but-unacknowledged the shim stops reading the client; more arrive in
 *   `held` until the prelude acknowledges. Inbound messages are capped at 32 MiB (1009).
 * - An app that sends to a client more than SB_WS_MAX_BACKPRESSURE bytes behind loses the
 *   connection (the app sees 1006), as on sproutd.
 *
 * Without this shim (sproutd's workers) nothing here exists: the weak STUBS keep the hook null
 * for the prelude, and sproutd's bridge installs its own.
 */

/** Forward declarations, before the B19 registry. */
export const WS_DECLS_ANCHOR = "// sproutboat B19: streamed responses\n";
export const WS_DECLS =
  "// sproutboat: WebSockets (websockets.ts)\n" +
  "static u32 sb_ws_response_id(uWS::HttpResponse<false>* res, i32 headers_entries_ptr, bool* upgrade);\n" +
  "static void sb_ws_finish(uWS::HttpResponse<false>* res, u32 id, i32 headers_entries_ptr);\n";

/** write_response_value: the id of a socket the app handed over, found with the other markers. */
export const WS_FLAG_ANCHOR = "  u32 stream_id = 0; // sproutboat B19\n";
export const WS_FLAG_INJECT = WS_FLAG_ANCHOR + "  u32 sb_ws_id = 0; // sproutboat: WebSockets\n";

export const WS_SCAN_ANCHOR = '      if (std::string_view(scan_buf, scan_bytes) == "x-sb-stream") {\n';
export const WS_SCAN_INJECT =
  '      if (std::string_view(scan_buf, scan_bytes) == "x-sb-websocket") {\n' +
  "        const struct jsval ws_value = unpack_jsval(*((u64*)(porf_mem + scan_entries + i * 16 + 8)));\n" +
  "        const char* ws_buf = nullptr;\n" +
  "        size_t ws_len = 0;\n" +
  "        char* ws_owned = nullptr;\n" +
  "        porf_native_fetch_read_value(ws_value, &ws_buf, &ws_len, &ws_owned);\n" +
  "        sb_ws_id = (u32)strtoul(std::string(ws_buf, ws_len).c_str(), nullptr, 10);\n" +
  "        if (ws_owned) free(ws_owned);\n" +
  "      }\n" +
  WS_SCAN_ANCHOR;

/** The marker is internal: never sent on the wire, even by a plain response. */
export const WS_FORBIDDEN_ANCHOR = '         key == "x-sb-stream"; // sproutboat B19: internal signal, never sent\n';
export const WS_FORBIDDEN_INJECT =
  '         key == "x-sb-stream" || // sproutboat B19: internal signal, never sent\n' +
  '         key == "x-sb-websocket"; // sproutboat: internal signal, never sent\n';

/** The cork lambda: an upgrade writes its own status and headers, so it goes first. */
export const WS_CORK_ANCHOR = "    res->cork([res, status, headers_entries_ptr, body_buf, body_len, stream_id]() {\n";
export const WS_CORK_INJECT =
  "    res->cork([res, status, headers_entries_ptr, body_buf, body_len, stream_id, sb_ws_id]() {\n" +
  "      if (sb_ws_id || status == 101) { sb_ws_finish(res, sb_ws_id, headers_entries_ptr); return; }\n";

/** Inserted before write_response_value. C++ inside a JS template literal: no backticks, no ${. */
export const WS_REGISTRY_ANCHOR =
  "static void write_response_value(uWS::HttpResponse<false>* res, struct jsval response, bool* aborted) {\n";
export const WS_REGISTRY = String.raw`// sproutboat: WebSockets
#include "internal/internal.h"
static const size_t SB_WS_MAX_MESSAGE = 32u << 20;
static const size_t SB_WS_WINDOW = 1u << 20;
static const size_t SB_WS_MAX_BACKPRESSURE = 8u << 20;
struct SbWsData { u32 id = 0; };
using SbWebSocket = uWS::WebSocket<false, true, SbWsData>;
struct SbWsEvent { int kind = 0; u32 code = 0; std::string data; };
struct SbWsEarly { int kind = 0; u32 code = 0; std::string data; };
struct SbWsConn {
  SbWebSocket* ws = nullptr;
  bool lost = false;
  std::vector<SbWsEarly> early;
  std::deque<SbWsEvent> events;
  std::deque<SbWsEvent> held;
  size_t held_bytes = 0, unacked = 0;
  bool paused = false;
  int poll_events = 0;
  u32 waiter = 0;
};
static std::unordered_map<u32, SbWsConn> sb_ws_conns;
static u32 sb_ws_next = 0;
struct SbWsUpgrade { std::string key; us_socket_context_t* context = nullptr; };
static std::unordered_map<uWS::HttpResponse<false>*, SbWsUpgrade> sb_ws_upgrades;

extern "C" long long (*sb_ws_hook)(int op, unsigned int id, const char* data, size_t length, char* out, size_t cap);

// Fires the timer the prelude parked, if any. Always from a deferred call: the callers are uWS
// callbacks that can run inside one of the prelude's own calls (a close it just asked for).
static void sb_ws_wake(u32 id) {
  uWS::Loop::get()->defer([id]() {
    auto it = sb_ws_conns.find(id);
    if (it == sb_ws_conns.end() || !it->second.waiter) return;
    const u32 timer = it->second.waiter;
    it->second.waiter = 0;
    __porffor_js_enter();
    porf_native_fetch_timer_clear(timer);
    porf_native_fetch_fire_timer(timer);
    __porffor_js_exit();
  });
}

// Stops (and restarts) reading a client socket, as uWS's own protected pause() does.
static void sb_ws_pause(SbWebSocket* ws, SbWsConn& c, bool pause) {
  auto* p = (us_poll_t*)ws;
  auto* loop = us_socket_context_loop(0, us_socket_context(0, (us_socket_t*)ws));
  if (pause) { c.poll_events = us_poll_events(p); us_poll_change(p, loop, 0); }
  else us_poll_change(p, loop, LIBUS_SOCKET_READABLE | (ws->getBufferedAmount() ? LIBUS_SOCKET_WRITABLE : 0) | c.poll_events);
}

static void sb_ws_push(u32 id, SbWsConn& c, int kind, u32 code, std::string data) {
  SbWsEvent e;
  e.kind = kind; e.code = code; e.data = std::move(data);
  c.events.push_back(std::move(e));
  sb_ws_wake(id);
}

// The connection is gone (or never became one): the app gets a close event.
static void sb_ws_gone(u32 id, int kind, u32 code, std::string reason) {
  auto it = sb_ws_conns.find(id);
  if (it == sb_ws_conns.end() || it->second.lost) return;
  SbWsConn& c = it->second;
  c.lost = true;
  c.ws = nullptr;
  c.early.clear();
  // What the client sent before it went is still the app's to read, ahead of the close.
  while (!c.held.empty()) { c.events.push_back(std::move(c.held.front())); c.held.pop_front(); }
  c.held_bytes = 0;
  sb_ws_push(id, c, kind, code, std::move(reason));
}

static void sb_ws_open(SbWebSocket* ws) {
  const u32 id = ws->getUserData()->id;
  auto it = sb_ws_conns.find(id);
  if (it == sb_ws_conns.end() || it->second.lost) { ws->close(); return; }
  SbWsConn& c = it->second;
  c.ws = ws;
  auto early = std::move(c.early);
  c.early.clear();
  for (auto& m : early) {
    if (m.kind == 2) { ws->end((int)m.code, m.data); break; }
    ws->send(m.data, m.kind == 0 ? uWS::OpCode::TEXT : uWS::OpCode::BINARY);
  }
}

static void sb_ws_deliver(u32 id, SbWsConn& c, int kind, std::string data) {
  c.unacked += data.size();
  sb_ws_push(id, c, kind, 0, std::move(data));
}

static void sb_ws_message(SbWebSocket* ws, std::string_view message, uWS::OpCode op) {
  const u32 id = ws->getUserData()->id;
  auto it = sb_ws_conns.find(id);
  if (it == sb_ws_conns.end()) return;
  SbWsConn& c = it->second;
  const int kind = op == uWS::OpCode::TEXT ? 0 : 1;
  if (c.paused || !c.held.empty()) {
    // Read while paused (a frame already in the socket buffer): wait for the prelude.
    if (c.held_bytes + message.size() > SB_WS_MAX_MESSAGE + (8u << 20)) { ws->close(); return; }
    SbWsEvent e; e.kind = kind; e.data = std::string(message);
    c.held_bytes += message.size();
    c.held.push_back(std::move(e));
    return;
  }
  sb_ws_deliver(id, c, kind, std::string(message));
  if (!c.paused && c.unacked > SB_WS_WINDOW) { c.paused = true; sb_ws_pause(ws, c, true); }
}

static void sb_ws_closed(SbWebSocket* ws, int code, std::string_view reason) {
  const u32 id = ws->getUserData()->id;
  auto it = sb_ws_conns.find(id);
  if (it == sb_ws_conns.end() || it->second.lost) return;
  it->second.paused = false;
  sb_ws_gone(id, code == 1006 ? 3 : 2, (u32)code, code == 1006 ? std::string() : std::string(reason));
}

// The prelude acknowledged BYTES it dispatched: deliver what waited, and read the client again.
static void sb_ws_ack(u32 id, SbWsConn& c, size_t bytes) {
  c.unacked -= bytes < c.unacked ? bytes : c.unacked;
  while (!c.held.empty() && c.unacked <= SB_WS_WINDOW) {
    SbWsEvent e = std::move(c.held.front());
    c.held.pop_front();
    c.held_bytes -= e.data.size();
    sb_ws_deliver(id, c, e.kind, std::move(e.data));
  }
  if (c.paused && c.held.empty() && c.unacked <= SB_WS_WINDOW) {
    c.paused = false;
    if (c.ws) sb_ws_pause(c.ws, c, false);
  }
}

static long long sb_ws_host(int op, unsigned int id, const char* data, size_t length, char* out, size_t cap) {
  if (op == 'o') {
    // A server carries client sockets from compatibility date 2026-11-01 (the prelude sends the app's).
    if (!data || std::string_view(data, length) < std::string_view("2026-11-01")) return 0;
    do { if (!++sb_ws_next) sb_ws_next = 1; } while (sb_ws_conns.count(sb_ws_next));
    sb_ws_conns[sb_ws_next] = SbWsConn();
    return sb_ws_next;
  }
  auto it = sb_ws_conns.find(id);
  if (it == sb_ws_conns.end()) return op == 'p' || op == 'k' || op == 'w' || op == 'r' ? 0 : -1;
  SbWsConn& c = it->second;
  switch (op) {
    case 't': case 'b': {
      if (c.lost) return -1;
      if (!c.ws) { SbWsEarly m; m.kind = op == 't' ? 0 : 1; m.data.assign(data, length); c.early.push_back(std::move(m)); return 0; }
      const auto status = c.ws->send(std::string_view(data, length), op == 't' ? uWS::OpCode::TEXT : uWS::OpCode::BINARY);
      if (status == SbWebSocket::DROPPED) {
        // The client is too far behind to keep: drop it, and the app hears 1006 on its turn.
        auto* ws = c.ws;
        uWS::Loop::get()->defer([ws]() { ws->close(); });
        return -1;
      }
      return 0;
    }
    case 'c': {
      if (c.lost) return -1;
      const u32 code = (u32)cap;
      if (!c.ws) { SbWsEarly m; m.kind = 2; m.code = code; m.data.assign(data, length); c.early.push_back(std::move(m)); return 0; }
      c.ws->end((int)code, std::string_view(data, length));
      return 0;
    }
    case 'p':
      if (!out || !cap) return -1;
      out[0] = 0;
      if (!c.events.empty()) snprintf(out, cap, "%d %zu %u", c.events.front().kind, c.events.front().data.size(), c.events.front().code);
      return 0;
    case 'i': {
      if (c.events.empty()) return -1;
      SbWsEvent e = std::move(c.events.front());
      c.events.pop_front();
      const size_t n = e.data.size() < cap ? e.data.size() : cap;
      if (n) memcpy(out, e.data.data(), n);
      return (long long)n;
    }
    case 'k': sb_ws_ack((u32)id, c, cap); return 0;
    case 'w': c.waiter = (u32)cap; return 0;
    case 'r': {
      if (c.ws && !c.lost) { c.ws->getUserData()->id = 0; c.ws->close(); }
      sb_ws_conns.erase(it);
      return 0;
    }
  }
  return -1;
}

// GET with Upgrade: websocket: what the 101 answer needs to upgrade this connection.
static void sb_ws_note_upgrade(uWS::HttpResponse<false>* res, uWS::HttpRequest* req, us_socket_context_t* context) {
  SbWsUpgrade up;
  up.key = std::string(req->getHeader("sec-websocket-key"));
  up.context = context;
  sb_ws_upgrades[res] = std::move(up);
}
// A plain request on a response object that once carried an upgrade (uWS reuses them).
static void sb_ws_forget_upgrade(uWS::HttpResponse<false>* res) { sb_ws_upgrades.erase(res); }

// The answer is a 101 (or carries a socket): upgrade when the request asked for one.
static void sb_ws_finish(uWS::HttpResponse<false>* res, u32 id, i32 headers_entries_ptr) {
  auto up = sb_ws_upgrades.find(res);
  if (!id || up == sb_ws_upgrades.end()) {
    if (id) sb_ws_gone(id, 3, 1006, std::string());
    res->writeStatus("500 Internal Server Error")->end(id ? "WebSocket response to a request that is not an upgrade" : "status 101 without a WebSocket");
    if (up != sb_ws_upgrades.end()) sb_ws_upgrades.erase(up);
    return;
  }
  SbWsUpgrade info = std::move(up->second);
  sb_ws_upgrades.erase(up);
  std::string protocol;
  const i32 headers_len = *((i32*)(porf_mem + headers_entries_ptr)) / 2;
  const i32 headers_entries = *((i32*)(porf_mem + headers_entries_ptr + 4));
  for (i32 i = 0; i < headers_len; i++) {
    const i32 name_base = headers_entries + i * 16;
    const struct jsval name_value = unpack_jsval(*((u64*)(porf_mem + name_base)));
    const struct jsval value_value = unpack_jsval(*((u64*)(porf_mem + name_base + 8)));
    const char* name_buf = nullptr; size_t name_len = 0; char* name_owned = nullptr;
    const char* value_buf = nullptr; size_t value_len = 0; char* value_owned = nullptr;
    porf_native_fetch_read_value(name_value, &name_buf, &name_len, &name_owned);
    porf_native_fetch_read_value(value_value, &value_buf, &value_len, &value_owned);
    if (std::string_view(name_buf, name_len) == "sec-websocket-protocol") protocol.assign(value_buf, value_len);
    if (name_owned) free(name_owned);
    if (value_owned) free(value_owned);
  }
  SbWsData data;
  data.id = id;
  res->template upgrade<SbWsData>(std::move(data), info.key, protocol, "", info.context);
}

`;

/** Replaces the server's one HTTP handler with the WebSocket behavior beside it. */
export const WS_MAIN_ANCHOR = '  uWS::App().any("/*", [](auto* res, auto* req) {\n    on_request(res, req);\n  })';
export const WS_MAIN_INJECT =
  "  if (sb_ws_hook == nullptr) sb_ws_hook = sb_ws_host; // sproutboat: this server carries client sockets\n" +
  '  uWS::App().ws<SbWsData>("/*", {\n' +
  "    .maxPayloadLength = (unsigned)SB_WS_MAX_MESSAGE, .idleTimeout = 120, .maxBackpressure = (unsigned)SB_WS_MAX_BACKPRESSURE,\n" +
  "    .upgrade = [](auto* res, auto* req, auto* context) { sb_ws_note_upgrade(res, req, context); on_request(res, req); },\n" +
  "    .open = [](SbWebSocket* ws) { sb_ws_open(ws); },\n" +
  "    .message = [](SbWebSocket* ws, std::string_view message, uWS::OpCode op) { sb_ws_message(ws, message, op); },\n" +
  "    .close = [](SbWebSocket* ws, int code, std::string_view reason) { sb_ws_closed(ws, code, reason); },\n" +
  '  }).any("/*", [](auto* res, auto* req) {\n    sb_ws_forget_upgrade(res);\n    on_request(res, req);\n  })';

/** Every edit to the shim: [anchor, replacement]. */
export const WS_EDITS: readonly (readonly [string, string])[] = [
  [WS_DECLS_ANCHOR, WS_DECLS + WS_DECLS_ANCHOR],
  [WS_FLAG_ANCHOR, WS_FLAG_INJECT],
  [WS_SCAN_ANCHOR, WS_SCAN_INJECT],
  [WS_FORBIDDEN_ANCHOR, WS_FORBIDDEN_INJECT],
  [WS_CORK_ANCHOR, WS_CORK_INJECT],
  [WS_REGISTRY_ANCHOR, WS_REGISTRY + WS_REGISTRY_ANCHOR],
  [WS_MAIN_ANCHOR, WS_MAIN_INJECT],
];

export const WS_MARKER = "sproutboat: WebSockets";
