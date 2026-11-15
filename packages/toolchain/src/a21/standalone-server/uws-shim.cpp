// Vendored source: the uWebSockets server shim of the standalone build (a C++ translation unit).
//
// What it is: the C++ that Porffor alpha 19's compiler generates for a native-fetch server
// (compiler/uwebsockets.js, makeUWebSocketsShimSource() with Prefs.eventLoop on), taken from the alpha 19 tree
// (upstream 0c135ce) with sproutboat's patch chain applied (@sproutboat/toolchain 0.26.1,
// patch fingerprint d9f485cffe3c): body limit, #156 status lines, #163 x-sb-remote-addr, #176 raw bodies, #195 R2
// transfers, the #236 shim stamp. standalone-shim.ts rewrites it over the alpha 22+ flat bridge at build time.
//
// Why it is here: the standalone build on Porffor alpha 24 serves requests with this shim. It used to acquire a
// whole patched alpha 19 tree only to read it. That tree is gone; this file is maintained here, by hand.
// Equivalence: everything after the marker below is byte for byte what the alpha 19 chain produced (sha256 in
// sources.json, "origin"; the pull request that vendored it records the verify run).
// ---- end of provenance header ----

#include "App.h"
// sproutboat #236: built against an HttpParser.h that accepts HTTP/1.0
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>

extern "C" {
typedef int i32;
typedef unsigned int u32;
typedef unsigned long long u64;
typedef double f64;

struct jsval {
  f64 val;
  i32 type;
};
struct NativeFetchResponseParts {
  i32 status;
  struct jsval body;
  struct jsval headers;
};

void porf_native_fetch_runtime_init(void);
void porf_native_fetch_collect_normal(void);
void porf_native_fetch_collect_normal_from(void* stack_top);
void porf_native_fetch_collect_quiet_from(void* stack_top);
int porf_native_fetch_needs_quiet_collect(void);
u32 porf_native_fetch_alloc(u32 bytes, u32 type);
u32 porf_native_fetch_alloc_bytestring(const char* input, size_t len);
i32 porf_gc_native_root_add(f64 value, i32 type);
void porf_gc_native_root_remove(i32 slot);
extern unsigned char* porf_mem;
struct jsval porf_native_fetch_call_handler(f64 method_value, i32 method_type, f64 url_value, i32 url_type, f64 headers_value, i32 headers_type, f64 body_value, i32 body_type);
void porf_native_fetch_finalize_response(f64 response_value, i32 response_type, struct NativeFetchResponseParts* out);
f64 porf_native_fetch_get_port(void);
int porf_native_fetch_should_collect(void);
int porf_native_fetch_read_value(struct jsval value, const char** out_buf, size_t* out_len, char** out_owned);
int porf_native_fetch_read_raw_bytes(struct jsval value, const char** out_buf, size_t* out_len);
int porf_native_fetch_promise_state(struct jsval value);
struct jsval porf_native_fetch_promise_result(struct jsval value);
void porf_native_fetch_attach_response(struct jsval promise, void* pending, u32* fulfill_out, u32* reject_out);
void porf_native_fetch_cancel_response_reaction(u32 reaction);
void porf_native_fetch_drain_microtasks(void);
void porf_native_fetch_fire_timer(u32 id);
}

static inline void __porffor_js_enter(void) {}
static inline void __porffor_js_exit(void) {}

struct NativeTimer {
  u32 id = 0;
  us_timer_t* timer = nullptr;
  bool repeat = false;
};

static std::unordered_map<u32, NativeTimer*> native_timers;
static u32 native_timer_firing = 0;

extern "C" void porf_native_fetch_timer_start(u32 id, i32 delay_ms, i32 repeat_ms) {
  auto* loop = (struct us_loop_t*)uWS::Loop::get();
  auto* timer = us_create_timer(loop, 0, sizeof(NativeTimer*));
  auto* native_timer = new NativeTimer();
  native_timer->id = id;
  native_timer->timer = timer;
  native_timer->repeat = repeat_ms != 0;
  std::memcpy(us_timer_ext(timer), &native_timer, sizeof(native_timer));
  native_timers[id] = native_timer;
  us_timer_set(timer, [](struct us_timer_t* timer) {
    NativeTimer* native_timer = nullptr;
    std::memcpy(&native_timer, us_timer_ext(timer), sizeof(native_timer));
    if (!native_timer) return;

    const u32 id = native_timer->id;

    native_timer_firing = id;
    __porffor_js_enter();
    porf_native_fetch_fire_timer(id);
    __porffor_js_exit();
    native_timer_firing = 0;

    if (!native_timer->repeat || native_timers.find(id) == native_timers.end()) {
      native_timers.erase(id);
      us_timer_close(timer);
      delete native_timer;
    }
  }, delay_ms < 0 ? 0 : delay_ms, repeat_ms < 0 ? 0 : repeat_ms);
}

extern "C" void porf_native_fetch_timer_clear(u32 id) {
  auto it = native_timers.find(id);
  if (it == native_timers.end()) return;
  NativeTimer* native_timer = it->second;
  native_timers.erase(it);
  if (native_timer_firing == id) {
    native_timer->repeat = false;
    return;
  }
  us_timer_close(native_timer->timer);
  delete native_timer;
}

static i32 method_get = 0;
static i32 method_head = 0;
static i32 method_post = 0;
static i32 method_put = 0;
static i32 method_delete = 0;
static i32 method_connect = 0;
static i32 method_options = 0;
static i32 method_trace = 0;
static i32 method_patch = 0;

static const u64 JSVAL_PATTERN = 0xFFF8000000000000ull;
static const i32 JS_TYPE_NUMBER = 1;

static inline u64 pack_bytestring(i32 ptr) {
  return JSVAL_PATTERN | ((u64)195 << 43) | (u64)(u32)ptr;
}

static inline struct jsval unpack_jsval(u64 bits) {
  if ((bits & JSVAL_PATTERN) != JSVAL_PATTERN) {
    f64 value;
    std::memcpy(&value, &bits, sizeof(value));
    return { value, JS_TYPE_NUMBER };
  }

  return { (f64)(u32)bits, (i32)((bits >> 43) & 0xff) };
}

static i32 alloc_static_bytestring(const char* input, size_t len) {
  const i32 ptr = (i32)porf_native_fetch_alloc_bytestring(input, len);
  porf_gc_native_root_add((f64)ptr, 195);
  return ptr;
}

static void porf_native_fetch_static_init(void) {
  if (method_get != 0) return;

  method_get = alloc_static_bytestring("GET", 3);
  method_head = alloc_static_bytestring("HEAD", 4);
  method_post = alloc_static_bytestring("POST", 4);
  method_put = alloc_static_bytestring("PUT", 3);
  method_delete = alloc_static_bytestring("DELETE", 6);
  method_connect = alloc_static_bytestring("CONNECT", 7);
  method_options = alloc_static_bytestring("OPTIONS", 7);
  method_trace = alloc_static_bytestring("TRACE", 5);
  method_patch = alloc_static_bytestring("PATCH", 5);
}

static i32 alloc_request_url(uWS::HttpRequest* req) {
  std::string_view host = req->getHeader("host");
  std::string_view target = req->getFullUrl();

  if (host.empty()) {
    return (i32)porf_native_fetch_alloc_bytestring(target.data(), target.size());
  }

  const size_t len = 7 + host.size() + target.size();
  const i32 ptr = (i32)porf_native_fetch_alloc((u32)(len + 4), 195);
  unsigned char* out = porf_mem + ptr;
  *((i32*)out) = (i32)len;
  out += 4;

  memcpy(out, "http://", 7);
  out += 7;
  memcpy(out, host.data(), host.size());
  out += host.size();
  memcpy(out, target.data(), target.size());
  return ptr;
}

struct NativeRoot {
  i32 slot = -1;

  NativeRoot() = default;
  NativeRoot(f64 value, i32 type) {
    reset(value, type);
  }
  NativeRoot(const NativeRoot&) = delete;
  NativeRoot& operator=(const NativeRoot&) = delete;

  ~NativeRoot() {
    clear();
  }

  void reset(f64 value, i32 type) {
    clear();
    slot = porf_gc_native_root_add(value, type);
  }

  void clear() {
    if (slot >= 0) {
      porf_gc_native_root_remove(slot);
      slot = -1;
    }
  }
};

static i32 collect_headers(uWS::HttpRequest* req, uWS::HttpResponse<false>* res) {
  i32 header_capacity = 0;
  for (auto [key, value] : *req) {
    (void)key;
    (void)value;
    header_capacity += 2;
  }
  header_capacity += 2; // sproutboat #163: room for the x-sb-remote-addr entry
  const i32 header_bytes = 16 + header_capacity * 8;
  const i32 headers_ptr = (i32)porf_native_fetch_alloc((u32)header_bytes, 72);
  const i32 entries_ptr = headers_ptr + 16;
  *((i32*)(porf_mem + headers_ptr)) = 0;
  *((u32*)(porf_mem + headers_ptr + 4)) = (u32)entries_ptr;
  *((i32*)(porf_mem + headers_ptr + 8)) = header_capacity;
  i32 slot = 0;
  for (auto [key, value] : *req) {
    if (key == "x-sb-remote-addr") continue; // #163: reserved, the server sets it below
    const i32 key_base = entries_ptr + slot * 8;
    *((u64*)(porf_mem + key_base)) = pack_bytestring((i32)porf_native_fetch_alloc_bytestring(key.data(), key.size()));
    slot++;

    const i32 value_base = entries_ptr + slot * 8;
    *((u64*)(porf_mem + value_base)) = pack_bytestring((i32)porf_native_fetch_alloc_bytestring(value.data(), value.size()));
    slot++;
  }
  {
    const std::string_view __sb_peer = res ? res->getRemoteAddressAsText() : std::string_view();
    *((u64*)(porf_mem + entries_ptr + slot * 8)) = pack_bytestring((i32)porf_native_fetch_alloc_bytestring("x-sb-remote-addr", 16));
    slot++;
    *((u64*)(porf_mem + entries_ptr + slot * 8)) = pack_bytestring((i32)porf_native_fetch_alloc_bytestring(__sb_peer.data(), __sb_peer.size()));
    slot++;
  }
  *((i32*)(porf_mem + headers_ptr)) = slot;

  return headers_ptr;
}

static i32 get_method_ptr(std::string_view method) {
  if (method == "GET") return method_get;
  if (method == "HEAD") return method_head;
  if (method == "POST") return method_post;
  if (method == "PUT") return method_put;
  if (method == "DELETE") return method_delete;
  if (method == "CONNECT") return method_connect;
  if (method == "OPTIONS") return method_options;
  if (method == "TRACE") return method_trace;
  if (method == "PATCH") return method_patch;
  return 0;
}

struct NativeRequestRoots {
  NativeRoot url;
  NativeRoot headers;

  NativeRequestRoots() = default;
  NativeRequestRoots(const NativeRequestRoots&) = delete;
  NativeRequestRoots& operator=(const NativeRequestRoots&) = delete;

  ~NativeRequestRoots() {
    clear();
  }

  void set_url(i32 url_ptr) {
    url.reset((f64)url_ptr, 195);
  }

  void set_headers(i32 headers_ptr) {
    headers.reset((f64)headers_ptr, 72);
  }

  void reset(i32 url_ptr, i32 headers_ptr) {
    set_url(url_ptr);
    set_headers(headers_ptr);
  }

  void clear() {
    url.clear();
    headers.clear();
  }
};

struct PendingRequest {
  bool aborted = false;
  bool finished = false;
  i32 method_ptr = 0;
  i32 url_ptr = 0;
  i32 headers_ptr = 0;
  NativeRequestRoots roots;
  std::string body;
};

static size_t sb_request_body_max(void) {
  static size_t cached = 0;
  if (cached == 0) {
    const char* raw = getenv("SB_REQUEST_BODY_MAX");
    long parsed = raw && *raw ? atol(raw) : 0;
    cached = parsed > 0 ? (size_t)parsed : 1024u * 1024u;
  }
  return cached;
}
#define REQUEST_BODY_MAX_BYTES sb_request_body_max()

// sproutboat: reclaim large idle heaps
static us_timer_t* sb_quiet_gc_timer = nullptr;
static void sb_collect_quiet(struct us_timer_t*) {
  volatile int stack_anchor = 0;
  porf_native_fetch_collect_quiet_from((void*)&stack_anchor);
}
// sproutboat: collect every N requests
// The standalone binary used to collect after every response. A collection costs about the same
// whatever the request made (it marks the live heap), so a cheap request paid it in full: 13 to 15%
// of the CPU of a small API request. It now collects every SB_GC_EVERY requests (default
// 8), and once the server has been quiet for about 50 ms, so a burst's garbage is not held
// past it. A request that needs more heap than is free still collects at allocation time, as before.
// SB_GC_EVERY=1 restores a collection after every request. sproutd has its own host and does not run this.
static u32 sb_gc_every(void) {
  static u32 cached = 0;
  if (cached == 0) {
    const char* raw = getenv("SB_GC_EVERY");
    long parsed = raw && *raw ? atol(raw) : 0;
    cached = parsed > 0 ? (u32)parsed : 8u;
  }
  return cached;
}
// A standalone binary opens its databases in EXCLUSIVE locking mode unless SB_SQLITE_EXCLUSIVE is set
// (SB_SQLITE_EXCLUSIVE=0 opts out). The transport's C reads only that variable, so sproutd and the broker,
// which never run this shim, keep shared locking unless an operator sets it. setenv(..., 0) keeps a value
// already set; it runs before main, so before any database opens.
static void __attribute__((constructor)) sb_default_sqlite_exclusive(void) { setenv("SB_SQLITE_EXCLUSIVE", "1", 0); }
static u32 sb_gc_since = 0;
static u32 sb_gc_idle_seen = 0;
static us_timer_t* sb_gc_idle_timer = nullptr;
static void collect_after_request_now(void);
static void sb_gc_idle_tick(struct us_timer_t* timer) {
  if (sb_gc_since == 0) return;
  if (sb_gc_since != sb_gc_idle_seen) {
    sb_gc_idle_seen = sb_gc_since;
    us_timer_set(timer, sb_gc_idle_tick, 50, 0);
    return;
  }
  collect_after_request_now();
}
static void collect_after_request(void) {
  if (++sb_gc_since < sb_gc_every()) {
    if (sb_gc_since == 1) {
      if (!sb_gc_idle_timer) sb_gc_idle_timer = us_create_timer((struct us_loop_t*)uWS::Loop::get(), 0, 0);
      if (sb_gc_idle_timer) {
        sb_gc_idle_seen = 0;
        us_timer_set(sb_gc_idle_timer, sb_gc_idle_tick, 50, 0);
      }
    }
    return;
  }
  collect_after_request_now();
}
static void collect_after_request_now(void) {
  sb_gc_since = 0;
  volatile int porf_stack_anchor = 0;
  porf_native_fetch_collect_normal_from((void*)&porf_stack_anchor);
  if (porf_native_fetch_needs_quiet_collect()) {
    if (!sb_quiet_gc_timer) sb_quiet_gc_timer = us_create_timer((struct us_loop_t*)uWS::Loop::get(), 0, 0);
    if (sb_quiet_gc_timer) us_timer_set(sb_quiet_gc_timer, sb_collect_quiet, 500, 0);
  }
}

static void respond_with_error(uWS::HttpResponse<false>* res, std::string_view status, std::string_view body, bool close_connection = false) {
  res->cork([res, status, body, close_connection]() {
    res->writeStatus(status);
    res->writeHeader("Content-Type", "text/plain; charset=utf-8");
    res->end(body, close_connection);
  });
}

static bool parse_content_length(std::string_view input, size_t* out) {
  if (input.empty()) return false;

  size_t value = 0;
  for (char c : input) {
    if (c < '0' || c > '9') return false;
    const size_t digit = (size_t)(c - '0');
    if (value > (((std::numeric_limits<size_t>::max)() - digit) / 10u)) {
      value = (std::numeric_limits<size_t>::max)();
      break;
    }
    value = value * 10u + digit;
  }

  *out = value;
  return true;
}

static bool body_would_exceed_limit(size_t current_size, size_t chunk_size) {
  return chunk_size > REQUEST_BODY_MAX_BYTES ||
         current_size > REQUEST_BODY_MAX_BYTES - chunk_size;
}

static bool finish_pending_request(PendingRequest* pending) {
  if (pending->finished) return false;
  pending->finished = true;
  return true;
}

static void release_pending_request(PendingRequest* pending) {
  pending->roots.clear();
  std::string().swap(pending->body);
  collect_after_request();
}

static std::string lookup_status_line(i32 status) {
  switch (status) {
    case 100: return "100 Continue";
    case 101: return "101 Switching Protocols";
    case 201: return "201 Created";
    case 202: return "202 Accepted";
    case 204: return "204 No Content";
    case 301: return "301 Moved Permanently";
    case 302: return "302 Found";
    case 303: return "303 See Other";
    case 304: return "304 Not Modified";
    case 307: return "307 Temporary Redirect";
    case 308: return "308 Permanent Redirect";
    case 400: return "400 Bad Request";
    case 401: return "401 Unauthorized";
    case 403: return "403 Forbidden";
    case 404: return "404 Not Found";
    case 405: return "405 Method Not Allowed";
    case 408: return "408 Request Timeout";
    case 409: return "409 Conflict";
    case 413: return "413 Payload Too Large";
    case 429: return "429 Too Many Requests";
    case 500: return "500 Internal Server Error";
    case 501: return "501 Not Implemented";
    case 502: return "502 Bad Gateway";
    case 503: return "503 Service Unavailable";
    case 504: return "504 Gateway Timeout";
    default: return std::to_string(status) + " Status";
  }
}

// sproutboat: restart without dropping a connection
extern "C" const char* sb_standalone_app_name(void) __attribute__((weak));
#ifdef __linux__
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <cstring>
#include <vector>
#include <string>
extern char** environ;
static int sb_rs_listen_fd = -1;
static bool sb_rs_fd_checked = false;
static int sb_rs_port = 0;
static us_listen_socket_t* sb_rs_listener = nullptr;
static us_timer_t* sb_rs_timer = nullptr;
static volatile sig_atomic_t sb_rs_term = 0, sb_rs_usr2 = 0;
static volatile sig_atomic_t sb_rs_closing = 0;
static volatile sig_atomic_t sb_rs_draining = 0;
static double sb_rs_deadline = 0;
static void sb_rs_tick(struct us_timer_t* timer);
static bool sb_rs_on(void) { return sb_standalone_app_name != nullptr; }
static double sb_rs_now(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1000000.0;
}
static long sb_rs_env(const char* name, long fallback) {
  const char* raw = getenv(name);
  if (!raw || !*raw) return fallback;
  char* end = nullptr;
  long parsed = strtol(raw, &end, 10);
  return end && !*end && parsed >= 0 ? parsed : fallback;
}
static void sb_rs_log(const char* message) { std::fprintf(stderr, "sproutboat: %s\n", message); }
static int sb_rs_local_port(int fd) {
  struct sockaddr_storage address;
  socklen_t length = sizeof(address);
  if (getsockname(fd, (struct sockaddr*)&address, &length)) return 0;
  if (address.ss_family == AF_INET) return ntohs(((struct sockaddr_in*)&address)->sin_port);
  if (address.ss_family == AF_INET6) return ntohs(((struct sockaddr_in6*)&address)->sin6_port);
  return 0;
}
// A successor started by SIGUSR2 waits here, before the runtime exists, until its parent has exited
// (the write end of the gate pipe closes with it) or the parent's drain limit and some grace is over.
static void __attribute__((constructor)) sb_rs_gate(void) {
  const char* raw = getenv("SB_RESTART_GATE_FD");
  if (!raw || !*raw || !sb_rs_on()) return;
  int fd = atoi(raw);
  unsetenv("SB_RESTART_GATE_FD");
  if (fd < 3) return;
  struct pollfd waiting = { fd, POLLIN, 0 };
  int result;
  do result = poll(&waiting, 1, (int)((sb_rs_env("SB_DRAIN_SECONDS", 10) + 20) * 1000));
  while (result < 0 && errno == EINTR);
  close(fd);
}
// uSockets asks this before it binds: fd 3 when LISTEN_PID names this process, as systemd and the
// SIGUSR2 successor both pass it, else -1 and it binds PORT as before.
extern "C" int sb_inherited_listen_fd(const char* host, int port) {
  (void)host;
  (void)port;
  if (sb_rs_on() && !sb_rs_fd_checked) {
    sb_rs_fd_checked = true;
    const char* pid = getenv("LISTEN_PID");
    const char* count = getenv("LISTEN_FDS");
    if (pid && count) {
      const bool mine = strtol(pid, nullptr, 10) == (long)getpid();
      const long given = strtol(count, nullptr, 10);
      unsetenv("LISTEN_PID");
      unsetenv("LISTEN_FDS");
      unsetenv("LISTEN_FDNAMES");
      int accepting = 0;
      socklen_t length = sizeof(accepting);
      if (mine && given >= 1 && !getsockopt(3, SOL_SOCKET, SO_ACCEPTCONN, &accepting, &length) && accepting) {
        fcntl(3, F_SETFD, FD_CLOEXEC);
        fcntl(3, F_SETFL, fcntl(3, F_GETFL, 0) | O_NONBLOCK);
        sb_rs_log("serving on the listening socket it was given (fd 3)");
        return 3;
      }
    }
  }
  return -1;
}
// Is any socket still doing something? Read from the kernel, so it needs no bookkeeping in the server.
static bool sb_rs_busy(void) {
  const long quiet = sb_rs_env("SB_DRAIN_QUIET_MS", 200);
  DIR* dir = opendir("/proc/self/fd");
  if (!dir) return false;
  const int self = dirfd(dir);
  bool busy = false;
  while (!busy) {
    struct dirent* entry = readdir(dir);
    if (!entry) break;
    const int fd = atoi(entry->d_name);
    if (fd < 3 || fd == self) continue;
    int domain = 0, type = 0, accepting = 0;
    socklen_t length = sizeof(int);
    if (getsockopt(fd, SOL_SOCKET, SO_DOMAIN, &domain, &length) || (domain != AF_INET && domain != AF_INET6)) continue;
    length = sizeof(int);
    if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &length) || type != SOCK_STREAM) continue;
    length = sizeof(int);
    if (!getsockopt(fd, SOL_SOCKET, SO_ACCEPTCONN, &accepting, &length) && accepting) continue;
    struct tcp_info info;
    memset(&info, 0, sizeof(info));
    socklen_t info_length = sizeof(info);
    if (getsockopt(fd, IPPROTO_TCP, TCP_INFO, &info, &info_length)) continue;
    if (info.tcpi_state == TCP_SYN_SENT || info.tcpi_state == TCP_SYN_RECV) { busy = true; break; }
    int unread = 0, unsent = 0;
    ioctl(fd, FIONREAD, &unread);
    ioctl(fd, TIOCOUTQ, &unsent);
    if (unread > 0 || unsent > 0) { busy = true; break; }
    const long received = (long)info.tcpi_last_data_recv, sent = (long)info.tcpi_last_data_sent;
    // The last thing on a connection we serve is our answer; on one we opened it is our request.
    if (sb_rs_local_port(fd) == sb_rs_port ? received + 20 < sent : sent + 20 < received) busy = true;
    else if (received < quiet || sent < quiet) busy = true;
  }
  closedir(dir);
  return busy;
}
// Start the binary now on disk as a child that inherits the listening socket. True once it has exec'd.
static bool sb_rs_spawn_successor(void) {
  if (sb_rs_listen_fd < 0) { sb_rs_log("restart: no listening socket to hand over"); return false; }
  char found[4096];
  const char* exe = getenv("SB_EXEC_PATH");
  if (!exe || !*exe) {
    const ssize_t n = readlink("/proc/self/exe", found, sizeof(found) - 1);
    if (n <= 0) { sb_rs_log("restart: cannot find its own executable"); return false; }
    found[n] = 0;
    static const char tail[] = " (deleted)";
    const size_t tail_length = sizeof(tail) - 1;
    if ((size_t)n > tail_length && !strcmp(found + n - tail_length, tail)) found[n - tail_length] = 0;
    exe = found;
  }
  if (access(exe, X_OK)) { std::fprintf(stderr, "sproutboat: restart: cannot execute %s\n", exe); return false; }
  int gate[2], status[2];
  if (pipe2(gate, O_CLOEXEC)) return false;
  if (pipe2(status, O_CLOEXEC)) { close(gate[0]); close(gate[1]); return false; }
  std::vector<std::string> keep;
  for (char** e = environ; *e; ++e) {
    if (!strncmp(*e, "LISTEN_PID=", 11) || !strncmp(*e, "LISTEN_FDS=", 11) || !strncmp(*e, "LISTEN_FDNAMES=", 15) ||
        !strncmp(*e, "SB_RESTART_GATE_FD=", 19)) continue;
    keep.push_back(*e);
  }
  keep.push_back("LISTEN_FDS=1");
  keep.push_back("SB_RESTART_GATE_FD=4");
  keep.push_back("LISTEN_PID=00000000000000000000");
  std::vector<char*> envp;
  for (auto& entry : keep) envp.push_back(const_cast<char*>(entry.c_str()));
  envp.push_back(nullptr);
  char* const pid_digits = envp[envp.size() - 2] + 11;
  char* argv[] = { const_cast<char*>(exe), nullptr };
  const pid_t child = fork();
  if (child < 0) { close(gate[0]); close(gate[1]); close(status[0]); close(status[1]); return false; }
  if (child == 0) {
    long value = (long)getpid();
    for (int at = 19; at >= 0; at--) { pid_digits[at] = (char)('0' + value % 10); value /= 10; }
    const int staying = fcntl(status[1], F_DUPFD_CLOEXEC, 10);
    const int listener = fcntl(sb_rs_listen_fd, F_DUPFD, 10);
    const int held = fcntl(gate[0], F_DUPFD, 10);
    if (staying < 0 || listener < 0 || held < 0 || dup2(listener, 3) < 0 || dup2(held, 4) < 0 || dup3(staying, 5, O_CLOEXEC) < 0) _exit(126);
    #ifdef SYS_close_range
    if (syscall(SYS_close_range, 6, ~0U, 0))
#endif
    { for (int fd = 6; fd < 4096; fd++) close(fd); }
    execve(exe, argv, envp.data());
    const int failure = errno;
    const ssize_t reported = write(5, &failure, sizeof(failure));
    (void)reported;
    _exit(127);
  }
  close(gate[0]);
  close(status[1]);
  int failure = 0;
  ssize_t got;
  do got = read(status[0], &failure, sizeof(failure));
  while (got < 0 && errno == EINTR);
  close(status[0]);
  if (got > 0) {
    waitpid(child, nullptr, 0);
    close(gate[1]);
    std::fprintf(stderr, "sproutboat: restart: cannot execute %s: %s\n", exe, strerror(failure));
    return false;
  }
  // gate[1] stays open for as long as this process lives: its closing is the successor's go signal.
  std::fprintf(stderr, "sproutboat: restart: started %s as pid %d\n", exe, (int)child);
  return true;
}
static void sb_rs_signal(int signal_number) {
  if (signal_number == SIGUSR2) sb_rs_usr2 = 1;
  else {
    if (sb_rs_term) _exit(0);
    sb_rs_term = 1;
  }
  // Once draining, the repeating tick is already running; re-arming it here would end the repeat.
  if (sb_rs_timer && !sb_rs_draining) us_timer_set(sb_rs_timer, sb_rs_tick, 1, 0);
}
static void sb_rs_tick(struct us_timer_t* timer) {
  if (!sb_rs_draining) {
    bool go = false;
    if (sb_rs_term) go = true;
    else if (sb_rs_usr2) { sb_rs_usr2 = 0; go = sb_rs_spawn_successor(); }
    if (!go) {
      us_timer_set(timer, sb_rs_tick, 0, 0);
      if (sb_rs_usr2 || sb_rs_term) us_timer_set(timer, sb_rs_tick, 1, 0);
      return;
    }
    sb_rs_draining = 1;
    sb_rs_closing = 1;
    if (sb_rs_listener) { us_listen_socket_close(0, sb_rs_listener); sb_rs_listener = nullptr; }
    sb_rs_deadline = sb_rs_now() + (double)sb_rs_env("SB_DRAIN_SECONDS", 10) * 1000.0;
    sb_rs_log("draining: no longer accepting");
    us_timer_set(timer, sb_rs_tick, 20, 20);
    return;
  }
  if (sb_rs_now() >= sb_rs_deadline) { sb_rs_log("drain limit reached, exiting"); _exit(0); }
  if (!sb_rs_busy()) { sb_rs_log("drained, exiting"); _exit(0); }
}
// Called from the listen callback, inside the event loop, once the socket is accepting.
static void sb_rs_listening(us_listen_socket_t* token) {
  if (!sb_rs_on() || !token) return;
  sb_rs_listener = token;
  sb_rs_listen_fd = us_poll_fd((struct us_poll_t*)token);
  if (sb_rs_listen_fd >= 0) sb_rs_port = sb_rs_local_port(sb_rs_listen_fd);
  sb_rs_timer = us_create_timer((struct us_loop_t*)uWS::Loop::get(), 1, 0);
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = sb_rs_signal;
  sigemptyset(&action.sa_mask);
  action.sa_flags = SA_RESTART;
  sigaction(SIGTERM, &action, nullptr);
  sigaction(SIGINT, &action, nullptr);
  sigaction(SIGUSR2, &action, nullptr);
}
#else
extern "C" int sb_inherited_listen_fd(const char*, int) { return -1; }
static volatile int sb_rs_closing = 0;
static void sb_rs_listening(us_listen_socket_t*) {}
#endif
static bool is_forbidden_response_header(std::string_view key) {
  return key == "connection" ||
         key == "content-length" ||
         key == "transfer-encoding" ||
         key == "x-sb-raw-body" || // sproutboat #176: internal signal, never sent
         key == "x-sb-stream" || // sproutboat B19: internal signal, never sent
         key == "x-sb-websocket"; // sproutboat: internal signal, never sent
}

// sproutboat: streamed request bodies (request-streaming.ts)
static void sb_reqbody_aborted(uWS::HttpResponse<false>* res);
static void sb_reqbody_responding(uWS::HttpResponse<false>* res);
// sproutboat: WebSockets (websockets.ts)
static u32 sb_ws_response_id(uWS::HttpResponse<false>* res, i32 headers_entries_ptr, bool* upgrade);
static void sb_ws_finish(uWS::HttpResponse<false>* res, u32 id, i32 headers_entries_ptr);
// sproutboat B19: streamed responses
struct SbStream {
  uWS::HttpResponse<false>* res = nullptr;
  std::string pending;
  bool attached = false, ended = false, aborted = false;
};
static std::unordered_map<u32, SbStream> sb_streams;
static u32 sb_stream_next = 1;

extern "C" int sb_stream_supported(void) { return 1; }

extern "C" u32 sb_stream_open(void) {
  const u32 id = sb_stream_next++;
  sb_streams[id] = SbStream();
  return id;
}

extern "C" int sb_stream_write(u32 id, const char* data, size_t len) {
  auto it = sb_streams.find(id);
  if (it == sb_streams.end() || it->second.aborted) return -1;
  SbStream& s = it->second;
  if (!s.attached) { s.pending.append(data, len); return 0; }
  auto* res = s.res;
  res->cork([res, data, len]() { res->write(std::string_view(data, len)); });
  return 0;
}

// Flow-control hooks of the prelude's pump (sproutd's host answers them). The standalone server buffers by
// itself, so it never holds a stream back: nothing is unacknowledged and there is nothing to wait for. They are
// definitions, not weak undefined references in the prelude: Mach-O will not link an undefined weak reference
// without -U, so a macOS standalone build failed to link.
extern "C" size_t sb_stream_pending(u32 id) { (void)id; return 0; }
extern "C" void sb_stream_wait(u32 id, u32 timer) { (void)id; (void)timer; }

extern "C" void sb_stream_end(u32 id) {
  auto it = sb_streams.find(id);
  if (it == sb_streams.end()) return;
  SbStream& s = it->second;
  if (!s.attached && !s.aborted) { s.ended = true; return; }
  if (!s.aborted) {
    auto* res = s.res;
    res->cork([res]() { res->end(); });
  }
  sb_streams.erase(it);
}

static void sb_stream_attach(u32 id, uWS::HttpResponse<false>* res) {
  auto it = sb_streams.find(id);
  if (it == sb_streams.end()) { res->end(); return; }
  SbStream& s = it->second;
  s.res = res;
  s.attached = true;
  res->onAborted([id, res]() {
    sb_reqbody_aborted(res);
    auto found = sb_streams.find(id);
    if (found == sb_streams.end()) return;
    found->second.aborted = true;
    found->second.res = nullptr;
  });
  if (!s.pending.empty()) { res->write(std::string_view(s.pending)); s.pending.clear(); }
  if (s.ended) { res->end(); sb_streams.erase(it); }
}

// sproutboat: WebSockets
#include <deque>
#include <vector>
#include <string>
#include <unordered_map>
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

// sproutboat: a response's ASCII strings are written in place
// porf_native_fetch_read_value turns a bytestring into UTF-8 with a malloc and a per-byte loop, and a
// response runs it for every header name and value (twice) and for the body: 5% of the CPU of a 4 KB
// reply. A bytestring whose bytes are all below 0x80 already is its UTF-8 text, so it is read where it
// lies (valid until the next JS allocation: every use below ends before one). Anything else, a
// UTF-16 string or a byte of 0x80 or more, takes the copying read unchanged.
static inline int sb_read_value_fast(struct jsval value, const char** out_buf, size_t* out_len, char** out_owned) {
  if (value.type == 195 && out_buf && out_len && out_owned) {
    const u32 ptr = (u32)value.val;
    const size_t len = (size_t)*(u32*)(porf_mem + ptr);
    const unsigned char* units = (const unsigned char*)(porf_mem + ptr + 4);
    size_t i = 0;
    unsigned char high = 0;
    for (; i + 8 <= len; i += 8) {
      u64 word;
      memcpy(&word, units + i, 8);
      if (word & 0x8080808080808080ULL) { high = 0x80; break; }
    }
    for (; high < 0x80 && i < len; i++) high |= units[i];
    if (high < 0x80) {
      *out_buf = (const char*)units;
      *out_len = len;
      *out_owned = NULL;
      return 0;
    }
  }
  return porf_native_fetch_read_value(value, out_buf, out_len, out_owned);
}

static void write_response_value(uWS::HttpResponse<false>* res, struct jsval response, bool* aborted) {
  sb_reqbody_responding(res);
  struct NativeFetchResponseParts response_parts;
  porf_native_fetch_finalize_response(response.val, response.type, &response_parts);
  const i32 status = response_parts.status;
  const struct jsval body_value = response_parts.body;
  const i32 headers_entries_ptr = (i32)response_parts.headers.val;

  // sproutboat #176: a reserved x-sb-raw-body header (set by the prelude's
  // assets binding) means the body is already-finished bytes, not a string
  // to UTF-8 encode -- scanned before the body read so it can steer that one
  // call onto porf_native_fetch_read_raw_bytes instead.
  bool raw_body = false;
  u32 stream_id = 0; // sproutboat B19
  u32 sb_ws_id = 0; // sproutboat: WebSockets
  {
    const i32 scan_len = *((i32*)(porf_mem + headers_entries_ptr)) / 2;
    const i32 scan_entries = *((i32*)(porf_mem + headers_entries_ptr + 4));
    for (i32 i = 0; i < scan_len && !raw_body; i++) {
      const struct jsval scan_name = unpack_jsval(*((u64*)(porf_mem + scan_entries + i * 16)));
      const char* scan_buf = nullptr;
      size_t scan_bytes = 0;
      char* scan_owned = nullptr;
      sb_read_value_fast(scan_name, &scan_buf, &scan_bytes, &scan_owned);
      if (std::string_view(scan_buf, scan_bytes) == "x-sb-raw-body") raw_body = true;
      if (std::string_view(scan_buf, scan_bytes) == "x-sb-websocket") {
        const struct jsval ws_value = unpack_jsval(*((u64*)(porf_mem + scan_entries + i * 16 + 8)));
        const char* ws_buf = nullptr;
        size_t ws_len = 0;
        char* ws_owned = nullptr;
        sb_read_value_fast(ws_value, &ws_buf, &ws_len, &ws_owned);
        sb_ws_id = (u32)strtoul(std::string(ws_buf, ws_len).c_str(), nullptr, 10);
        if (ws_owned) free(ws_owned);
      }
      if (std::string_view(scan_buf, scan_bytes) == "x-sb-stream") {
        const struct jsval stream_value = unpack_jsval(*((u64*)(porf_mem + scan_entries + i * 16 + 8)));
        const char* id_buf = nullptr;
        size_t id_len = 0;
        char* id_owned = nullptr;
        sb_read_value_fast(stream_value, &id_buf, &id_len, &id_owned);
        stream_id = (u32)strtoul(std::string(id_buf, id_len).c_str(), nullptr, 10);
        if (id_owned) free(id_owned);
      }
      if (scan_owned) free(scan_owned);
    }
  }

  const char* body_buf = nullptr;
  size_t body_len = 0;
  char* body_owned = nullptr;
  if (raw_body && porf_native_fetch_read_raw_bytes(body_value, &body_buf, &body_len) != 0 && body_value.type == 67) {
    // Raw bytes can also arrive as a UTF-16 string (a fetch() response body parsed
    // from JSON), one byte per unit: narrow each unit, as the R2 upload path does.
    const u32 body_ptr = (u32)body_value.val;
    body_len = (size_t)*((u32*)(porf_mem + body_ptr));
    body_owned = (char*)malloc(body_len + 1);
    const unsigned short* units = (const unsigned short*)(porf_mem + body_ptr + 4);
    for (size_t i = 0; i < body_len; i++) body_owned[i] = (char)(units[i] & 0xff);
    body_buf = body_owned;
  } else if (!raw_body || !body_buf) sb_read_value_fast(body_value, &body_buf, &body_len, &body_owned);

  if (!aborted || !*aborted) {
    res->cork([res, status, headers_entries_ptr, body_buf, body_len, stream_id, sb_ws_id]() {
      if (sb_ws_id || status == 101) { sb_ws_finish(res, sb_ws_id, headers_entries_ptr); return; }
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
        sb_read_value_fast(name_value, &name_buf, &name_len, &name_owned);
        sb_read_value_fast(value_value, &value_buf, &value_len, &value_owned);

        const std::string_view key(name_buf, name_len);
        if (!is_forbidden_response_header(key)) {
          res->writeHeader(key, std::string_view(value_buf, value_len));
        }

        if (name_owned) free(name_owned);
        if (value_owned) free(value_owned);
      }

      if (sb_rs_closing) res->writeHeader("Connection", "close"); // sproutboat: draining
      if (stream_id) sb_stream_attach(stream_id, res); // sproutboat B19: the prelude pumps the body
      else res->end(std::string_view(body_buf, body_len));
    });
  }

  if (body_owned) free(body_owned);
}

struct PendingResponse {
  uWS::HttpResponse<false>* res = nullptr;
  bool aborted = false;
  bool finished = false;
  u32 fulfill_reaction = 0;
  u32 reject_reaction = 0;
  NativeRequestRoots roots;
  NativeRoot body;

  PendingResponse(uWS::HttpResponse<false>* res, i32 url_ptr, i32 headers_ptr, i32 body_ptr) : res(res) {
    roots.reset(url_ptr, headers_ptr);
    if (body_ptr != 0) body.reset((f64)body_ptr, 195);
  }

  void clear() {
    roots.clear();
    body.clear();
  }

  void cancel_reactions() {
    porf_native_fetch_cancel_response_reaction(fulfill_reaction);
    porf_native_fetch_cancel_response_reaction(reject_reaction);
    fulfill_reaction = 0;
    reject_reaction = 0;
  }
};

extern "C" void porf_native_fetch_response_complete(void* raw_pending, f64 value, i32 type, i32 is_reject) {
  auto* pending = (PendingResponse*)raw_pending;
  if (!pending || pending->finished) return;
  pending->finished = true;

  if (!pending->aborted && pending->res) {
    if (is_reject) {
      respond_with_error(pending->res, "500 Internal Server Error", "native fetch promise rejected", true);
    } else {
      write_response_value(pending->res, { value, type }, &pending->aborted);
    }
  }

  pending->clear();
  delete pending;
  collect_after_request();
}

// sproutboat: streamed request bodies
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

static bool handle_request(uWS::HttpResponse<false>* res, i32 method_ptr, i32 url_ptr, i32 headers_ptr, std::string_view request_body, bool* aborted, NativeRequestRoots* roots) {
  if (aborted && *aborted) {
    if (roots) roots->clear();
    return true;
  }

  const i32 body_ptr = request_body.empty() ? 0 : (i32)porf_native_fetch_alloc_bytestring(request_body.data(), request_body.size());

  struct jsval response = porf_native_fetch_call_handler((f64)method_ptr, 195, (f64)url_ptr, 195, (f64)headers_ptr, 72, (f64)body_ptr, 195);
  porf_native_fetch_drain_microtasks();

  const int promise_state = porf_native_fetch_promise_state(response);
  if (promise_state != -1) {
    if (promise_state == 0) {
      auto* pending = new PendingResponse(res, url_ptr, headers_ptr, body_ptr);
      res->onAborted([pending]() {
        if (pending->finished || pending->aborted) return;
        pending->aborted = true;
        sb_reqbody_aborted(pending->res);
        pending->res = nullptr;
        pending->cancel_reactions();
        pending->clear();
        delete pending;
        collect_after_request();
      });
      porf_native_fetch_attach_response(response, pending, &pending->fulfill_reaction, &pending->reject_reaction);
      return false;
    }

    if (promise_state == 2) {
      respond_with_error(res, "500 Internal Server Error", "native fetch promise rejected", true);
      if (roots) roots->clear();
      return true;
    }

    response = porf_native_fetch_promise_result(response);
  }

  write_response_value(res, response, aborted);
  if (roots) roots->clear();
  return true;
}

extern "C" {
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
  const std::string_view method = req->getCaseSensitiveMethod();
  const i32 method_ptr = get_method_ptr(method);
  if (method_ptr == 0) {
    respond_with_error(res, "400 Bad Request", "unsupported method", true);
    collect_after_request();
    return;
  }

  if (try_handle_r2_transfer(res, req, method)) return;
  __porffor_js_enter();
  const i32 url_ptr = alloc_request_url(req);
  const i32 headers_ptr = collect_headers(req, res);

  const std::string_view content_length = req->getHeader("content-length");
  const std::string_view transfer_encoding = req->getHeader("transfer-encoding");
  size_t declared_content_length = 0;

  if (!content_length.empty() && !parse_content_length(content_length, &declared_content_length)) {
    __porffor_js_exit();
    respond_with_error(res, "400 Bad Request", "invalid content-length", true);
    collect_after_request();
    return;
  }

  if (transfer_encoding.empty() && declared_content_length == 0) {
    const bool completed = handle_request(res, method_ptr, url_ptr, headers_ptr, std::string_view(), nullptr, nullptr);
    __porffor_js_exit();
    if (completed) collect_after_request();
    return;
  }

  // sproutboat: streamed request bodies, from compatibility date 2026-10-27
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
  if (declared_content_length > REQUEST_BODY_MAX_BYTES || REQUEST_BODY_MAX_BYTES == 0) {
    __porffor_js_exit();
    respond_with_error(res, "413 Payload Too Large", "request body too large", true);
    collect_after_request();
    return;
  }

  auto pending = std::make_shared<PendingRequest>();
  pending->method_ptr = method_ptr;
  pending->url_ptr = url_ptr;
  pending->headers_ptr = headers_ptr;
  pending->roots.reset(url_ptr, headers_ptr);
  __porffor_js_exit();
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
      __porffor_js_enter();
      const bool completed = handle_request(res, pending->method_ptr, pending->url_ptr, pending->headers_ptr, pending->body, &pending->aborted, &pending->roots);
      __porffor_js_exit();
      (void)completed;
      release_pending_request(pending.get());
    }
  });
}
// sproutboat: async broker exchanges
extern "C" __attribute__((weak)) void sb_async_set_waker(void (*wake)(void)) { (void)wake; }
extern "C" __attribute__((weak)) void sb_async_drain(void) {}
static uWS::Loop* sb_async_loop = nullptr;
static void sb_async_wake(void) {
  sb_async_loop->defer([] {
    __porffor_js_enter();
    sb_async_drain();
    __porffor_js_exit();
  });
}
int main(void) {
  porf_native_fetch_runtime_init();
  porf_native_fetch_static_init();
  sb_async_loop = uWS::Loop::get();
  sb_async_set_waker(sb_async_wake);

  const int port = (int)porf_native_fetch_get_port();
  bool listened = false;
  if (sb_ws_hook == nullptr) sb_ws_hook = sb_ws_host; // sproutboat: this server carries client sockets
  uWS::App().ws<SbWsData>("/*", {
    .maxPayloadLength = (unsigned)SB_WS_MAX_MESSAGE, .idleTimeout = 120, .maxBackpressure = (unsigned)SB_WS_MAX_BACKPRESSURE,
    .upgrade = [](auto* res, auto* req, auto* context) { sb_ws_note_upgrade(res, req, context); on_request(res, req); },
    .open = [](SbWebSocket* ws) { sb_ws_open(ws); },
    .message = [](SbWebSocket* ws, std::string_view message, uWS::OpCode op) { sb_ws_message(ws, message, op); },
    .close = [](SbWebSocket* ws, int code, std::string_view reason) { sb_ws_closed(ws, code, reason); },
  }).any("/*", [](auto* res, auto* req) {
    sb_ws_forget_upgrade(res);
    on_request(res, req);
  }).listen(port, [&listened, port](auto* token) {
    if (token) {
      listened = true;
      sb_rs_listening(token);
      std::fprintf(stderr, "Porffor native fetch server listening on http://127.0.0.1:%d\n", port);
    }
  }).run();

  if (!listened) {
    std::fprintf(stderr, "Failed to bind native fetch server\n");
    return 1;
  }

  return 0;
}