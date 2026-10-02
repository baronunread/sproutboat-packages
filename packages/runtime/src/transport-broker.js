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
  const reply = JSON.parse(__sbCallBin(JSON.stringify(req), ""));
  if (reply.ok === false) throw new Error("sproutboat " + op + ": " + (reply.error || "failed"));
  const bytes = __sbTakeBin();
  reply.body = reply.body != null ? __sbToBytes(reply.body) : bytes;
  return reply;
};

/** Static asset metadata stays JSON; the response body uses the v1 byte tail. */
globalThis.__sbAssetsGet = function (path) {
  const token = __sbEnv("SB_BROKER_TOKEN");
  const reply = JSON.parse(__sbCallBin(JSON.stringify({ v: 1, token, op: "assets.get", path }), ""));
  if (reply.ok === false) throw new Error("sproutboat assets.get: " + (reply.error || "failed"));
  reply.body = __sbTakeBin();
  return reply;
};
