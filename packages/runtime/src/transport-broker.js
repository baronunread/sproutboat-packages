/**
 * The broker transport: one long-lived loopback connection to the per-deployment
 * binding broker, `[u32 LE length][payload]` frames both ways.
 *
 * This is what a deployed sprout uses, and what `sproutboat dev` and a phase-0
 * standalone binary use. The embedded transport (transport-embedded.js) is the
 * same `__sbCall(reqJson) -> replyJson` contract with SQLite compiled in
 * instead of a broker on the other end — everything above __sbCall is shared.
 */
// SB_BROKER_PORT / SB_BROKER_TOKEN are set by the supervisor next to $PORT.
// If SB_BROKER_PORT is unset the shims below are never installed (compile.ts
// only emits the __sbInstallBindings call when the project declares bindings),
// so a plain sprout is byte-for-byte unchanged.
// ponytail: still AF_INET loopback, not AF_UNIX. A failed v0 exchange reconnects
// and resends; the broker deduplicates its writes (queue.send, INSERT) by request
// id. v1 exchanges (fetch, service.fetch, R2) resend only when the broker cannot
// have acted: the request never fully left, or a reused connection had gone
// stale. On a host with an event loop, fetch and service.fetch run off it, on
// one I/O thread (sb_async_submit_v1).

// oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
Porffor.c`
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <time.h>

// baronunread/sproutboat#176 — defined in render.js, alongside
// porf_native_fetch_read_value (which every inline-C block below already
// calls with no forward declaration of its own — that one gets one from
// Porffor's own generated prototypes, this one doesn't, since it's a local
// patch addition, not something Porffor knows to prototype early).
extern int porf_native_fetch_read_raw_bytes(jsval value, const char** out_buf, size_t* out_len);

static int sb_io_all(int fd, unsigned char* buf, size_t len, int writing) {
  size_t done = 0;
  while (done < len) {
    long n = writing ? write(fd, buf + done, len - done) : read(fd, buf + done, len - done);
    if (n <= 0) {
      if (n < 0 && errno == EINTR) continue;
      return -1;
    }
    done += (size_t)n;
  }
  return 0;
}

// One long-lived loopback connection to the broker, reused across every binding
// call. The broker frames each request/reply independently and keeps the socket
// open, so the steady-state per-call cost is just write + read — no socket(),
// connect() handshake or close() each time. -1 = not connected.
static int sb_broker_fd = -1;

// A new connection to the broker: its fd, or a negative code.
static int sb_broker_open(void) {
  const char* port_s = getenv("SB_BROKER_PORT");
  if (!port_s) return -10;
  signal(SIGPIPE, SIG_IGN); // a dead broker must yield EPIPE, not kill the sprout
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  int one = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons((unsigned short)atoi(port_s));
  addr.sin_addr.s_addr = htonl(0x7f000001u); // 127.0.0.1
  if (connect(fd, (struct sockaddr*)&addr, sizeof(addr)) != 0) { close(fd); return -2; }
  return fd;
}

static int sb_broker_connect(void) {
  int fd = sb_broker_open();
  if (fd < 0) return fd;
  sb_broker_fd = fd;
  return 0;
}

// Send one payload verbatim on fd and read one reply. The caller owns the
// payload's shape: a v0 exchange prepends the token line, a v1 one carries the
// token in its JSON and must reach the broker byte for byte — prefixing it would
// leave the marker in the wrong place and the frame would read as v0.
// -3 and -5 mean the broker never had the whole request; -4 and -6 mean it did,
// and may have acted on it.
static int sb_broker_exchange_fd(int fd, const char* body, size_t body_len, char** resp_out, size_t* resp_len_out) {
  unsigned char* frame = (unsigned char*)malloc(4 + body_len);
  if (!frame) return -5;
  frame[0] = (unsigned char)(body_len & 0xff);
  frame[1] = (unsigned char)((body_len >> 8) & 0xff);
  frame[2] = (unsigned char)((body_len >> 16) & 0xff);
  frame[3] = (unsigned char)((body_len >> 24) & 0xff);
  if (body_len) memcpy(frame + 4, body, body_len);
  int wr = sb_io_all(fd, frame, 4 + body_len, 1);
  free(frame);
  if (wr != 0) return -3;

  unsigned char rhdr[4];
  if (sb_io_all(fd, rhdr, 4, 0) != 0) return -4;
  size_t rlen = (size_t)rhdr[0] | ((size_t)rhdr[1] << 8) | ((size_t)rhdr[2] << 16) | ((size_t)rhdr[3] << 24);

  char* buf = (char*)malloc(rlen ? rlen : 1);
  if (!buf) return -5;
  if (rlen && sb_io_all(fd, (unsigned char*)buf, rlen, 0) != 0) { free(buf); return -6; }

  *resp_out = buf;
  *resp_len_out = rlen;
  return 0;
}

// The same exchange on the persistent connection.
static int sb_broker_exchange_raw(const char* body, size_t body_len, char** resp_out, size_t* resp_len_out) {
  return sb_broker_exchange_fd(sb_broker_fd, body, body_len, resp_out, resp_len_out);
}

// #63 — the binary reply from the last v1 exchange, handed to JS on request.
// Stashed rather than returned inline so an 8 MB object body is one allocation
// in the Porffor heap, not a substring of a bigger one.
static char* sb_bin_reply = 0;
static size_t sb_bin_reply_len = 0;

// v0: token line, then the JSON.
static int sb_broker_exchange(const char* req, size_t req_len, char** resp_out, size_t* resp_len_out) {
  const char* tok = getenv("SB_BROKER_TOKEN");
  size_t tok_len = tok ? strlen(tok) : 0;
  size_t body_len = tok_len + 1 + req_len;
  char* body = (char*)malloc(body_len);
  if (!body) return -5;
  if (tok_len) memcpy(body, tok, tok_len);
  body[tok_len] = '\n';
  if (req_len) memcpy(body + tok_len + 1, req, req_len);
  int rc = sb_broker_exchange_raw(body, body_len, resp_out, resp_len_out);
  free(body);
  return rc;
}

// Backoff between attempts: 0, 5, 25, then 100 ms.
static void sb_backoff(int attempt) {
  static const long ms[4] = { 0, 5, 25, 100 };
  long wait = ms[attempt < 4 ? attempt : 3];
  if (wait <= 0) return;
  struct timespec ts;
  ts.tv_sec = wait / 1000;
  ts.tv_nsec = (wait % 1000) * 1000000L;
  nanosleep(&ts, 0);
}

static int sb_broker_roundtrip(const char* req, size_t req_len, char** resp_out, size_t* resp_len_out) {
  *resp_out = NULL;
  *resp_len_out = 0;
  // Four tries with backoff. One retry was tuned for "systemd restarted it in
  // 20 ms"; a broker being upgraded, or a shared one restarting, is every
  // deployment's binding calls failing inside that window. Retrying the same
  // bytes is safe because each request carries an id the broker deduplicates.
  int rc = -3;
  for (int attempt = 0; attempt < 4; attempt++) {
    sb_backoff(attempt);
    if (sb_broker_fd < 0) {
      int c = sb_broker_connect();
      if (c != 0) { rc = c; continue; }
    }
    rc = sb_broker_exchange(req, req_len, resp_out, resp_len_out);
    if (rc == 0) return 0;
    close(sb_broker_fd);
    sb_broker_fd = -1;
  }
  return rc;
}

// baronunread/sproutboat#189 -- the broker writes its reply JSON as UTF-8,
// but it reaches JS as a bytestring, one char per byte, so any non-ASCII text
// (a D1 row, a KV value, a cached body) came back as Latin-1 mojibake. Non-ASCII
// bytes only ever sit inside JSON strings, so rewriting each UTF-8 sequence as
// \uXXXX gives the same JSON in pure ASCII, and JSON.parse rebuilds the real
// strings. A byte that starts no valid sequence passes through as \u00XX.
// Returns a malloc'd copy, or 0 when the reply is already ASCII.
static char* sb_json_ascii(const char* s, size_t n, size_t* out_len) {
  size_t high = 0;
  for (size_t i = 0; i < n; i++) if ((unsigned char)s[i] >= 0x80) high++;
  if (!high) return 0;
  char* out = (char*)malloc(n + high * 12 + 1);
  if (!out) return 0;
  size_t o = 0;
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    if (c < 0x80) { out[o++] = (char)c; continue; }
    unsigned int cp = 0, min = 0;
    size_t len = 0;
    if ((c & 0xe0) == 0xc0) { cp = c & 0x1f; len = 2; min = 0x80; }
    else if ((c & 0xf0) == 0xe0) { cp = c & 0x0f; len = 3; min = 0x800; }
    else if ((c & 0xf8) == 0xf0) { cp = c & 0x07; len = 4; min = 0x10000; }
    int ok = len > 0 && i + len <= n;
    for (size_t k = 1; ok && k < len; k++) {
      unsigned char cc = (unsigned char)s[i + k];
      if ((cc & 0xc0) != 0x80) ok = 0;
      else cp = (cp << 6) | (cc & 0x3f);
    }
    if (ok && (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))) ok = 0;
    if (!ok) { o += (size_t)sprintf(out + o, "\\u%04x", c); continue; }
    if (cp >= 0x10000) {
      cp -= 0x10000;
      o += (size_t)sprintf(out + o, "\\u%04x\\u%04x", 0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      o += (size_t)sprintf(out + o, "\\u%04x", cp);
    }
    i += len - 1;
  }
  out[o] = 0;
  *out_len = o;
  return out;
}

// fetch and service.fetch are the exception: their body is the upstream's
// bytes, which the prelude keeps one char per byte (x-sb-raw-body) and decodes
// itself. __sbRpc always writes {"v":1,"id":N,"op":... first, so the op is a
// fixed-position prefix, not a search through user data.
static int sb_req_is_fetch(const char* req, size_t n) {
  const char* head = "{\"v\":1,\"id\":";
  size_t hl = strlen(head);
  if (n < hl || memcmp(req, head, hl) != 0) return 0;
  size_t i = hl;
  while (i < n && req[i] >= '0' && req[i] <= '9') i++;
  const char* a = ",\"op\":\"fetch\"";
  const char* b = ",\"op\":\"service.fetch\"";
  if (n - i >= strlen(a) && memcmp(req + i, a, strlen(a)) == 0) return 1;
  if (n - i >= strlen(b) && memcmp(req + i, b, strlen(b)) == 0) return 1;
  return 0;
}

// A v1 request: marker, json length, json, then the body bytes. malloc'd.
static char* sb_v1_request(const char* json, size_t json_len, const char* body, size_t body_len, size_t* out_len) {
  size_t req_len = 1 + 4 + json_len + body_len;
  char* req = (char*)malloc(req_len);
  if (!req) return 0;
  req[0] = 1;
  unsigned int jl = (unsigned int)json_len;
  memcpy(req + 1, &jl, 4);
  memcpy(req + 5, json, json_len);
  if (body_len) memcpy(req + 5 + json_len, body, body_len);
  *out_len = req_len;
  return req;
}

// Splits a v1 reply, which it takes ownership of, into its JSON (returned,
// NUL-terminated, malloc'd) and its bytes (*bin, malloc'd, or 0 when there are
// none). A broker that answered v0 to a v1 request predates this: its reply is
// returned whole, so the error it wrote is what the handler sees. 0 on OOM.
static char* sb_v1_split(char* resp, size_t resp_len, size_t* json_len, char** bin, size_t* bin_len) {
  *bin = 0;
  *bin_len = 0;
  if (resp_len >= 5 && (unsigned char)resp[0] == 1) {
    unsigned int rjl = 0;
    memcpy(&rjl, resp + 1, 4);
    if (5 + (size_t)rjl <= resp_len) {
      size_t n = resp_len - 5 - rjl;
      if (n) {
        *bin = (char*)malloc(n);
        if (*bin) { memcpy(*bin, resp + 5 + rjl, n); *bin_len = n; }
      }
      char* json = (char*)malloc(rjl + 1);
      if (json) { memcpy(json, resp + 5, rjl); json[rjl] = 0; *json_len = rjl; }
      free(resp);
      return json;
    }
  }
  *json_len = resp_len;
  return resp;
}

// One v1 exchange on *fd (-1 = connect first), with up to four tries. A failure
// before the broker had the whole request is always retried. One after it is
// retried only on a connection that had served an earlier exchange, which may
// simply have gone stale (a broker restart); on a fresh one the broker may have
// acted on it, and fetch and service.fetch are not deduplicated by id.
static int sb_v1_send(int* fd, const char* req, size_t req_len, char** resp, size_t* resp_len) {
  int rc = -3;
  for (int attempt = 0; attempt < 4; attempt++) {
    sb_backoff(attempt);
    int reused = *fd >= 0;
    if (!reused) {
      int c = sb_broker_open();
      if (c < 0) { rc = c; continue; }
      *fd = c;
    }
    rc = sb_broker_exchange_fd(*fd, req, req_len, resp, resp_len);
    if (rc == 0) return 0;
    close(*fd);
    *fd = -1;
    if (!reused && rc != -3 && rc != -5) return rc;
  }
  return rc;
}

// A v1 exchange on the persistent connection. The reply's JSON is returned and
// its bytes stashed for __sbTakeBin.
static int sb_broker_roundtrip_v1(const char* json, size_t json_len, const char* body, size_t body_len,
                                  char** resp_out, size_t* resp_len_out) {
  size_t req_len = 0;
  char* req = sb_v1_request(json, json_len, body, body_len, &req_len);
  if (!req) return -4;
  char* resp = 0; size_t resp_len = 0;
  int rc = sb_v1_send(&sb_broker_fd, req, req_len, &resp, &resp_len);
  free(req);
  if (rc != 0) return rc;
  if (sb_bin_reply) { free(sb_bin_reply); sb_bin_reply = 0; sb_bin_reply_len = 0; }
  char* json_only = sb_v1_split(resp, resp_len, resp_len_out, &sb_bin_reply, &sb_bin_reply_len);
  if (!json_only) return -4;
  *resp_out = json_only;
  return 0;
}

// Async exchanges, for a host with an event loop (the standalone server). The
// host installs a waker with sb_async_set_waker(); fetch() and service bindings
// then hand each exchange to one I/O thread and return at once, so the sprout
// keeps serving while calls are in flight — including the calls back into itself
// that recursion makes, however deep. The I/O thread multiplexes non-blocking
// broker connections with poll(), one per exchange in flight, and keeps a few
// idle ones for reuse. A finished exchange is queued and the waker called; the
// host then runs sb_async_drain() on its loop, which fires the JS callback
// registered under the request's timer id. The thread touches only malloc'd jobs,
// never the JS heap. The same contract as the embedded transport's B18, which
// signals a pipe.
void porf_native_fetch_fire_timer(u32 id);
void porf_native_fetch_timer_clear(u32 id);
typedef struct sb_async_job {
  struct sb_async_job* next;
  u32 id;
  // The framed request ([u32 LE length][v1 payload]) and how much of it is sent.
  unsigned char* out; size_t out_len, out_off;
  // The reply: its length prefix, then its payload.
  unsigned char hdr[4]; size_t hdr_got;
  char* in; size_t in_len, in_got;
  int fd, reused, attempt, connecting;
  long long retry_at;  // ms; 0 = not waiting to retry
  char* json; size_t json_len;
  char* bin; size_t bin_len;
} sb_async_job;
// Idle connections kept for the next exchanges.
#define SB_IO_IDLE 8
static pthread_mutex_t sb_async_lock = PTHREAD_MUTEX_INITIALIZER;
static sb_async_job *sb_async_queue = 0, *sb_async_done = 0, *sb_async_current = 0;
static int sb_io_started = 0, sb_io_wake[2] = { -1, -1 };
static void (*sb_async_waker)(void) = 0;

void sb_async_set_waker(void (*wake)(void)) { sb_async_waker = wake; }
int sb_async_enabled(void) { return sb_async_waker != 0; }

static long long sb_now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void sb_async_error(sb_async_job* j, int rc) {
  char e[48];
  int n = snprintf(e, sizeof(e), "{\"ok\":false,\"error\":\"broker rc %d\"}", rc);
  j->json = (char*)malloc((size_t)n + 1);
  if (!j->json) abort();
  memcpy(j->json, e, (size_t)n + 1);
  j->json_len = (size_t)n;
}

// Hands a finished job (json set) back to the loop.
static void sb_async_finish(sb_async_job* j) {
  free(j->out); j->out = 0;
  free(j->in); j->in = 0;
  pthread_mutex_lock(&sb_async_lock);
  j->next = sb_async_done;
  sb_async_done = j;
  pthread_mutex_unlock(&sb_async_lock);
  sb_async_waker();
}

static void sb_io_nonblock(int fd) { fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK); fcntl(fd, F_SETFD, FD_CLOEXEC); }

// Starts (or restarts) a job: an idle connection if there is one, else a new one.
static void sb_io_begin(sb_async_job* j, int* idle, int* idle_n) {
  j->out_off = 0; j->hdr_got = 0; j->in_got = 0; j->in_len = 0;
  free(j->in); j->in = 0;
  j->retry_at = 0; j->connecting = 0;
  if (*idle_n > 0) { j->fd = idle[--*idle_n]; j->reused = 1; return; }
  j->reused = 0;
  const char* port_s = getenv("SB_BROKER_PORT");
  int fd = port_s ? socket(AF_INET, SOCK_STREAM, 0) : -1;
  if (fd < 0) { j->fd = -1; return; }
  int one = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
  sb_io_nonblock(fd);
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons((unsigned short)atoi(port_s));
  addr.sin_addr.s_addr = htonl(0x7f000001u);
  if (connect(fd, (struct sockaddr*)&addr, sizeof(addr)) != 0) {
    if (errno != EINPROGRESS) { close(fd); j->fd = -1; return; }
    j->connecting = 1;
  }
  j->fd = fd;
}

// A failed attempt. Retried (after a backoff) when the broker never had the whole
// request, or the connection was a reused one that may have gone stale; failed
// otherwise, since fetch and service.fetch are not deduplicated by id.
static int sb_io_failed(sb_async_job* j, int rc) {
  if (j->fd >= 0) { close(j->fd); j->fd = -1; }
  int unsent = j->out_off < j->out_len;
  if ((unsent || j->reused) && ++j->attempt < 4) {
    static const long ms[4] = { 0, 5, 25, 100 };
    j->retry_at = sb_now_ms() + ms[j->attempt];
    return 0;
  }
  sb_async_error(j, rc);
  return 1;
}

// Moves a job along as far as its socket allows. 1 = done (json set), 0 = not yet.
static int sb_io_step(sb_async_job* j, int* idle, int* idle_n) {
  if (j->connecting) {
    int err = 0; socklen_t len = sizeof(err);
    if (getsockopt(j->fd, SOL_SOCKET, SO_ERROR, &err, &len) != 0 || err != 0) return sb_io_failed(j, -2);
    j->connecting = 0;
  }
  while (j->out_off < j->out_len) {
    long n = write(j->fd, j->out + j->out_off, j->out_len - j->out_off);
    if (n > 0) { j->out_off += (size_t)n; continue; }
    if (n < 0 && errno == EINTR) continue;
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
    return sb_io_failed(j, -3);
  }
  while (j->hdr_got < 4) {
    long n = read(j->fd, j->hdr + j->hdr_got, 4 - j->hdr_got);
    if (n > 0) { j->hdr_got += (size_t)n; continue; }
    if (n < 0 && errno == EINTR) continue;
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
    return sb_io_failed(j, -4);
  }
  if (!j->in) {
    j->in_len = (size_t)j->hdr[0] | ((size_t)j->hdr[1] << 8) | ((size_t)j->hdr[2] << 16) | ((size_t)j->hdr[3] << 24);
    j->in = (char*)malloc(j->in_len ? j->in_len : 1);
    if (!j->in) abort();
  }
  while (j->in_got < j->in_len) {
    long n = read(j->fd, j->in + j->in_got, j->in_len - j->in_got);
    if (n > 0) { j->in_got += (size_t)n; continue; }
    if (n < 0 && errno == EINTR) continue;
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
    return sb_io_failed(j, -6);
  }
  if (*idle_n < SB_IO_IDLE) idle[(*idle_n)++] = j->fd; else close(j->fd);
  j->fd = -1;
  char* resp = j->in; j->in = 0;
  j->json = sb_v1_split(resp, j->in_len, &j->json_len, &j->bin, &j->bin_len);
  size_t al = 0;
  char* ascii = j->json ? sb_json_ascii(j->json, j->json_len, &al) : 0;
  if (ascii) { free(j->json); j->json = ascii; j->json_len = al; }
  if (!j->json) sb_async_error(j, -4);
  return 1;
}

static void* sb_io_thread(void* unused) {
  (void)unused;
  sb_async_job* active = 0;
  int idle[SB_IO_IDLE], idle_n = 0;
  struct pollfd* fds = 0;
  sb_async_job** owners = 0;
  size_t cap = 0;
  for (;;) {
    // New jobs.
    pthread_mutex_lock(&sb_async_lock);
    sb_async_job* fresh = sb_async_queue;
    sb_async_queue = 0;
    pthread_mutex_unlock(&sb_async_lock);
    while (fresh) {
      sb_async_job* j = fresh;
      fresh = j->next;
      sb_io_begin(j, idle, &idle_n);
      j->next = active;
      active = j;
    }
    // Retries that are due restart; a job with no socket fails, or waits to retry.
    long long now = sb_now_ms();
    for (sb_async_job** link = &active; *link;) {
      sb_async_job* j = *link;
      if (j->retry_at && j->retry_at <= now) sb_io_begin(j, idle, &idle_n);
      if (!j->retry_at && j->fd < 0 && sb_io_failed(j, -2)) {
        *link = j->next;
        sb_async_finish(j);
        continue;
      }
      link = &j->next;
    }
    long long soonest = 0;
    size_t count = 0;
    for (sb_async_job* j = active; j; j = j->next) {
      if (!j->retry_at) count++;
      else if (!soonest || j->retry_at < soonest) soonest = j->retry_at;
    }
    if (count + 1 > cap) {
      cap = (count + 1) * 2;
      fds = (struct pollfd*)realloc(fds, cap * sizeof(struct pollfd));
      owners = (sb_async_job**)realloc(owners, cap * sizeof(sb_async_job*));
      if (!fds || !owners) abort();
    }
    fds[0].fd = sb_io_wake[0]; fds[0].events = POLLIN; fds[0].revents = 0;
    size_t n = 1;
    for (sb_async_job* j = active; j; j = j->next) {
      if (j->retry_at) continue;
      fds[n].fd = j->fd;
      fds[n].events = j->connecting || j->out_off < j->out_len ? POLLOUT : POLLIN;
      fds[n].revents = 0;
      owners[n++] = j;
    }
    int timeout = soonest ? (int)(soonest > now ? soonest - now : 0) : -1;
    if (poll(fds, (nfds_t)n, timeout) < 0 && errno != EINTR) continue;
    if (fds[0].revents) { char buf[64]; while (read(sb_io_wake[0], buf, sizeof(buf)) > 0) {} }
    for (size_t i = 1; i < n; i++) {
      if (!fds[i].revents) continue;
      sb_async_job* j = owners[i];
      if (!sb_io_step(j, idle, &idle_n)) continue;
      // Done: unlink and hand back.
      sb_async_job** link = &active;
      while (*link != j) link = &(*link)->next;
      *link = j->next;
      sb_async_finish(j);
    }
  }
  return 0;
}

// The inline C of __sbCallAsync calls this by prototype: Porffor may emit a
// function's body before this block.
void sb_async_submit_v1(u32 id, const char* json, size_t json_len, const char* body, size_t body_len) {
  sb_async_job* j = (sb_async_job*)calloc(1, sizeof(sb_async_job));
  if (!j) abort();
  j->id = id;
  j->fd = -1;
  size_t req_len = 0;
  char* req = sb_v1_request(json, json_len, body, body_len, &req_len);
  if (!req) abort();
  j->out = (unsigned char*)malloc(4 + req_len);
  if (!j->out) abort();
  for (int k = 0; k < 4; k++) j->out[k] = (unsigned char)((req_len >> (8 * k)) & 0xff);
  memcpy(j->out + 4, req, req_len);
  free(req);
  j->out_len = 4 + req_len;
  pthread_mutex_lock(&sb_async_lock);
  int start = !sb_io_started;
  if (start) {
    signal(SIGPIPE, SIG_IGN);  // a dead broker must yield EPIPE, not kill the sprout
    if (pipe(sb_io_wake) != 0) abort();
    sb_io_nonblock(sb_io_wake[0]);
    sb_io_nonblock(sb_io_wake[1]);
    sb_io_started = 1;
  }
  j->next = sb_async_queue;
  sb_async_queue = j;
  pthread_mutex_unlock(&sb_async_lock);
  if (start) {
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    pthread_attr_setstacksize(&attr, 256 * 1024);
    pthread_t thread;
    int failed = pthread_create(&thread, &attr, sb_io_thread, 0);
    pthread_attr_destroy(&attr);
    // No thread (a pids limit): every async call fails; the sync path still works.
    if (failed) {
      pthread_mutex_lock(&sb_async_lock);
      sb_async_job* orphans = sb_async_queue;
      sb_async_queue = 0;
      sb_io_started = 0;
      close(sb_io_wake[0]); close(sb_io_wake[1]);
      sb_io_wake[0] = sb_io_wake[1] = -1;
      pthread_mutex_unlock(&sb_async_lock);
      while (orphans) {
        sb_async_job* q = orphans;
        orphans = q->next;
        sb_async_error(q, -7);
        sb_async_finish(q);
      }
      return;
    }
  }
  char one = 1;
  while (write(sb_io_wake[1], &one, 1) < 0 && errno == EINTR) {}
}

const char* sb_async_reply_json(u32 id, size_t* len) {
  if (!sb_async_current || sb_async_current->id != id) return 0;
  *len = sb_async_current->json_len;
  return sb_async_current->json;
}

// Host, on its loop: fires each finished exchange's callback, oldest first. Its
// bytes go where __sbTakeBin reads them.
void sb_async_drain(void) {
  pthread_mutex_lock(&sb_async_lock);
  sb_async_job* done = sb_async_done;
  sb_async_done = 0;
  pthread_mutex_unlock(&sb_async_lock);
  sb_async_job* oldest = 0;
  while (done) {
    sb_async_job* next = done->next;
    done->next = oldest;
    oldest = done;
    done = next;
  }
  while (oldest) {
    sb_async_job* j = oldest;
    oldest = j->next;
    porf_native_fetch_timer_clear(j->id);  // the placeholder timer
    if (sb_bin_reply) free(sb_bin_reply);
    sb_bin_reply = j->bin;
    sb_bin_reply_len = j->bin_len;
    j->bin = 0;
    sb_async_current = j;  // read by __sbHttpAsyncResult in the callback
    porf_native_fetch_fire_timer(j->id);
    sb_async_current = 0;
    free(j->json);
    free(j);
  }
}
`;

// One request string in, one reply string out. `reqJson` is a parameter, so the
// generated C names it directly in the RawC block below.
// oxlint-disable-next-line no-unused-vars -- `reqJson` is read inside the RawC block below, not by JS.
function __sbCall(reqJson) {
  let res = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __req; size_t __reqlen; char* __reqowned = 0;
    porf_native_fetch_read_value(reqJson, &__req, &__reqlen, &__reqowned);
    char* __resp = 0; size_t __resplen = 0;
    int __rc = sb_broker_roundtrip(__req, __reqlen, &__resp, &__resplen);
    int __raw = sb_req_is_fetch(__req, __reqlen);
    if (__reqowned) free(__reqowned);
    if (__rc == 0) {
      size_t __al = 0;
      char* __ascii = __raw ? 0 : sb_json_ascii(__resp, __resplen, &__al);
      if (__ascii) { free(__resp); __resp = __ascii; __resplen = __al; }
      res = porf_box((f64)porf_native_fetch_alloc_bytestring(__resp, __resplen), 195);
      free(__resp);
    } else {
      char __e[40];
      int __n = snprintf(__e, sizeof(__e), "{\"ok\":false,\"error\":\"broker rc %d\"}", __rc);
      res = porf_box((f64)porf_native_fetch_alloc_bytestring(__e, (size_t)__n), 195);
    }
  `;
  return res;
}

/**
 * No-op: a deployed sprout's cron ticks, queue batches and DO alarms are
 * delivered by the broker over x-sb-trigger. The embedded transport defines the
 * real one, so the generated module can call this unconditionally.
 */
globalThis.__sbStartLocalTriggers = function () {};

// #63 — a v1 exchange carrying a body. Returns the reply JSON; any bytes in the
// reply wait in __sbTakeBin.
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbCallBin(reqJson, body) {
  let res = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __j; size_t __jl; char* __jo = 0;
    porf_native_fetch_read_value(reqJson, &__j, &__jl, &__jo);
    // baronunread/sproutboat#184 -- the only real (non-empty) body this ever
    // carries today is an R2 put(); read raw, not through read_value's
    // bytestring branch, which always UTF-8-encodes (right for text, wrong
    // for opaque bytes off a raw HTTP upload). A genuine multi-byte JS string
    // isn't a bytestring, so it falls back to the encoding path unaffected.
    const char* __b; size_t __bl; char* __bo = 0;
    if (porf_native_fetch_read_raw_bytes(body, &__b, &__bl) != 0) {
      porf_native_fetch_read_value(body, &__b, &__bl, &__bo);
    }
    char* __resp = 0; size_t __resplen = 0;
    int __rc = sb_broker_roundtrip_v1(__j, __jl, __b, __bl, &__resp, &__resplen);
    if (__jo) free(__jo);
    if (__bo) free(__bo);
    if (__rc == 0) {
      size_t __al = 0;
      char* __ascii = sb_json_ascii(__resp, __resplen, &__al);
      if (__ascii) { free(__resp); __resp = __ascii; __resplen = __al; }
      res = porf_box((f64)porf_native_fetch_alloc_bytestring(__resp, __resplen), 195);
      free(__resp);
    } else {
      char __e[40];
      int __n = snprintf(__e, sizeof(__e), "{\"ok\":false,\"error\":\"broker rc %d\"}", __rc);
      res = porf_box((f64)porf_native_fetch_alloc_bytestring(__e, (size_t)__n), 195);
    }
  `;
  return res;
}

/** The bytes from the last v1 reply, if it carried any. Clears the stash. */
function __sbTakeBin() {
  let out = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    if (sb_bin_reply && sb_bin_reply_len) {
      out = porf_box((f64)porf_native_fetch_alloc_bytestring(sb_bin_reply, sb_bin_reply_len), 195);
    }
    if (sb_bin_reply) { free(sb_bin_reply); sb_bin_reply = 0; sb_bin_reply_len = 0; }
  `;
  return out;
}

/** #63 — R2 bodies as bytes rather than escaped into the frame. */
globalThis.__sbR2Put = function (bucket, key, body, httpMetadata, customMetadata) {
  const token = __sbEnv("SB_BROKER_TOKEN");
  const reply = JSON.parse(
    __sbCallBin(
      JSON.stringify({ v: 1, token, op: "r2.put", bucket, key, httpMetadata, customMetadata }),
      body == null ? "" : String(body),
    ),
  );
  if (reply.ok === false) throw new Error("sproutboat r2.put: " + (reply.error || "failed"));
  return reply;
};

globalThis.__sbR2Get = function (bucket, key) {
  const token = __sbEnv("SB_BROKER_TOKEN");
  const reply = JSON.parse(__sbCallBin(JSON.stringify({ v: 1, token, op: "r2.get", bucket, key }), ""));
  if (reply.ok === false) throw new Error("sproutboat r2.get: " + (reply.error || "failed"));
  if (!reply.found) return { found: false };
  return { found: true, object: reply.object, body: __sbTakeBin() };
};

globalThis.__sbR2MultipartPut = function (bucket, key, uploadId, partNumber, body) {
  const token = __sbEnv("SB_BROKER_TOKEN");
  const reply = JSON.parse(
    __sbCallBin(
      JSON.stringify({
        v: 1,
        id: ++__sbReqId,
        token,
        op: "r2.multipart.put",
        bucket,
        key,
        uploadId,
        partNumber,
      }),
      body == null ? "" : String(body),
    ),
  );
  if (reply.ok === false) throw new Error("sproutboat r2.multipart.put: " + (reply.error || "failed"));
  return reply;
};

/**
 * #232 — outbound / service fetch over a v1 frame, so the body arrives as the
 * upstream's raw bytes (one char per byte) instead of UTF-8-decoded text. A
 * broker that predates this answers v1 fetch with the body still in its JSON:
 * re-encode that to bytes so it matches today's behaviour rather than breaking.
 */
globalThis.__sbFetchUpstream = function (op, msg) {
  const req = { v: 1, id: ++__sbReqId, token: __sbEnv("SB_BROKER_TOKEN"), op };
  for (const k in msg) req[k] = msg[k];
  // Queued (async host); the reply reaches the callback registered under asyncId.
  if (msg.asyncId > 0) {
    __sbCallAsync(JSON.stringify(req), "", msg.asyncId);
    return { ok: true, pending: true };
  }
  const reply = JSON.parse(__sbCallBin(JSON.stringify(req), ""));
  if (reply.ok === false) throw new Error("sproutboat " + op + ": " + (reply.error || "failed"));
  const bytes = __sbTakeBin();
  reply.body = reply.body != null ? __sbToBytes(reply.body) : bytes;
  return reply;
};

// Queues one v1 exchange for the async threads, under timer id `asyncId`.
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbCallAsync(reqJson, body, asyncId) {
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    void sb_async_submit_v1(u32, const char*, size_t, const char*, size_t);
    const char* __j; size_t __jl; char* __jo = 0;
    porf_native_fetch_read_value(reqJson, &__j, &__jl, &__jo);
    const char* __b; size_t __bl; char* __bo = 0;
    if (porf_native_fetch_read_raw_bytes(body, &__b, &__bl) != 0) {
      porf_native_fetch_read_value(body, &__b, &__bl, &__bo);
    }
    if (asyncId.type == 1 && asyncId.val > 0) sb_async_submit_v1((u32)asyncId.val, __j, __jl, __b, __bl);
    if (__jo) free(__jo);
    if (__bo) free(__bo);
  `;
}

// Whether the host runs exchanges off its loop (it installed a waker).
function __sbHttpAsyncEnabled() {
  let res = false;
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    int sb_async_enabled(void);
    if (sb_async_enabled()) res = porf_box(1, 2);
  `;
  return res;
}

// The reply JSON of the async exchange now firing its callback, or "".
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbHttpAsyncResult(asyncId) {
  let res = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* sb_async_reply_json(u32, size_t*);
    size_t __n = 0;
    const char* __r = asyncId.type == 1 ? sb_async_reply_json((u32)asyncId.val, &__n) : 0;
    if (__r) res = porf_box((f64)porf_native_fetch_alloc_bytestring(__r, __n), 195);
  `;
  return res;
}

// An async exchange's reply JSON -> the fetch op's result, its bytes as the body.
function __sbFetchReply(raw) {
  const reply = JSON.parse(raw);
  if (reply.ok === false) throw new Error(reply.error || "failed");
  const bytes = __sbTakeBin();
  reply.body = reply.body != null ? __sbToBytes(reply.body) : bytes;
  return reply;
}

/** Static asset metadata stays JSON; the response body uses the v1 byte tail. */
globalThis.__sbAssetsGet = function (path) {
  const token = __sbEnv("SB_BROKER_TOKEN");
  const reply = JSON.parse(__sbCallBin(JSON.stringify({ v: 1, token, op: "assets.get", path }), ""));
  if (reply.ok === false) throw new Error("sproutboat assets.get: " + (reply.error || "failed"));
  reply.body = __sbTakeBin();
  return reply;
};
