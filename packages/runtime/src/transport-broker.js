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
// ponytail: text values only; still AF_INET loopback, not AF_UNIX. A failed
// exchange reconnects and resends once — a broker crash between "request applied"
// and "reply read" can double-apply a non-idempotent op (queue.send, INSERT);
// the old fresh-connection-per-call path just failed the call there instead.
// Binary values + AF_UNIX = v2.

// oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
Porffor.c`
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

static int sb_broker_connect(void) {
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
  sb_broker_fd = fd;
  return 0;
}

// Send one framed request, read one framed reply, on the persistent fd.
// Send one payload verbatim and read one reply. The caller owns the payload's
// shape: a v0 exchange prepends the token line, a v1 one carries the token in
// its JSON and must reach the broker byte for byte — prefixing it would leave
// the marker in the wrong place and the frame would read as v0.
static int sb_broker_exchange_raw(const char* body, size_t body_len, char** resp_out, size_t* resp_len_out) {
  unsigned char* frame = (unsigned char*)malloc(4 + body_len);
  if (!frame) return -5;
  frame[0] = (unsigned char)(body_len & 0xff);
  frame[1] = (unsigned char)((body_len >> 8) & 0xff);
  frame[2] = (unsigned char)((body_len >> 16) & 0xff);
  frame[3] = (unsigned char)((body_len >> 24) & 0xff);
  if (body_len) memcpy(frame + 4, body, body_len);
  int wr = sb_io_all(sb_broker_fd, frame, 4 + body_len, 1);
  free(frame);
  if (wr != 0) return -3;

  unsigned char rhdr[4];
  if (sb_io_all(sb_broker_fd, rhdr, 4, 0) != 0) return -4;
  size_t rlen = (size_t)rhdr[0] | ((size_t)rhdr[1] << 8) | ((size_t)rhdr[2] << 16) | ((size_t)rhdr[3] << 24);

  char* buf = (char*)malloc(rlen ? rlen : 1);
  if (!buf) return -5;
  if (rlen && sb_io_all(sb_broker_fd, (unsigned char*)buf, rlen, 0) != 0) { free(buf); return -6; }

  *resp_out = buf;
  *resp_len_out = rlen;
  return 0;
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

// A v1 exchange: marker, json length, json, then the body bytes. The reply is
// split the same way, its JSON returned and its bytes stashed for __sbTakeBin.
static int sb_broker_roundtrip_v1(const char* json, size_t json_len, const char* body, size_t body_len,
                                  char** resp_out, size_t* resp_len_out) {
  size_t req_len = 1 + 4 + json_len + body_len;
  char* req = (char*)malloc(req_len);
  if (!req) return -4;
  req[0] = 1;
  unsigned int jl = (unsigned int)json_len;
  memcpy(req + 1, &jl, 4);
  memcpy(req + 5, json, json_len);
  if (body_len) memcpy(req + 5 + json_len, body, body_len);

  char* resp = 0; size_t resp_len = 0;
  int rc = -3;
  for (int attempt = 0; attempt < 4; attempt++) {
    sb_backoff(attempt);
    if (sb_broker_fd < 0) {
      int c = sb_broker_connect();
      if (c != 0) { rc = c; continue; }
    }
    rc = sb_broker_exchange_raw(req, req_len, &resp, &resp_len);
    if (rc == 0) break;
    close(sb_broker_fd);
    sb_broker_fd = -1;
  }
  free(req);
  if (rc != 0) return rc;

  if (sb_bin_reply) { free(sb_bin_reply); sb_bin_reply = 0; sb_bin_reply_len = 0; }
  if (resp_len >= 5 && (unsigned char)resp[0] == 1) {
    unsigned int rjl = 0;
    memcpy(&rjl, resp + 1, 4);
    if (5 + (size_t)rjl <= resp_len) {
      size_t bin_len = resp_len - 5 - rjl;
      if (bin_len) {
        sb_bin_reply = (char*)malloc(bin_len);
        if (sb_bin_reply) { memcpy(sb_bin_reply, resp + 5 + rjl, bin_len); sb_bin_reply_len = bin_len; }
      }
      char* json_only = (char*)malloc(rjl + 1);
      if (!json_only) { free(resp); return -4; }
      memcpy(json_only, resp + 5, rjl);
      json_only[rjl] = 0;
      free(resp);
      *resp_out = json_only;
      *resp_len_out = rjl;
      return 0;
    }
  }
  // A broker that answered v0 to a v1 request predates this: pass its reply
  // through so the error it wrote is what the handler sees.
  *resp_out = resp;
  *resp_len_out = resp_len;
  return 0;
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
    if (__reqowned) free(__reqowned);
    if (__rc == 0) {
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
    const char* __b; size_t __bl; char* __bo = 0;
    porf_native_fetch_read_value(body, &__b, &__bl, &__bo);
    char* __resp = 0; size_t __resplen = 0;
    int __rc = sb_broker_roundtrip_v1(__j, __jl, __b, __bl, &__resp, &__resplen);
    if (__jo) free(__jo);
    if (__bo) free(__bo);
    if (__rc == 0) {
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

/** Static asset metadata stays JSON; the response body uses the v1 byte tail. */
globalThis.__sbAssetsGet = function (path) {
  const token = __sbEnv("SB_BROKER_TOKEN");
  const reply = JSON.parse(__sbCallBin(JSON.stringify({ v: 1, token, op: "assets.get", path }), ""));
  if (reply.ok === false) throw new Error("sproutboat assets.get: " + (reply.error || "failed"));
  reply.body = __sbTakeBin();
  return reply;
};
