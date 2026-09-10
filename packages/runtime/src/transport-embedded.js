/**
 * The embedded transport: SQLite compiled into the sprout, no broker at all.
 *
 * Same contract as transport-broker.js — `__sbCall(reqJson) -> replyJson` — so
 * every binding shim above it is unchanged and the conformance suite is the
 * proof that the swap changed no behaviour.
 *
 * The split is deliberate: C does only what JS cannot (open a database, bind
 * parameters, step a statement, encode a row), and every op — which SQL, which
 * partition key, what shape comes back — stays in JS, mirroring broker.ts. That
 * keeps the second implementation of the binding ops as small as it can be,
 * which is the whole worry with having one at all.
 *
 * Paths come from __sbEnv: the launcher-free binary is told its data directory
 * through SB_DATA_DIR, the same way it learns its port.
 */

// oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
Porffor.c`
#include <stdint.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <netdb.h>
#include <strings.h>
#include <sys/time.h>
#include <bearssl.h>

// sqlite3 is linked in via SB_EXTRA_LINK (see patch-porffor.ts). Declared here
// rather than including sqlite3.h so the build needs no include path.
typedef struct sqlite3 sqlite3;
typedef struct sqlite3_stmt sqlite3_stmt;
extern int sqlite3_open(const char*, sqlite3**);
extern int sqlite3_exec(sqlite3*, const char*, void*, void*, char**);
extern int sqlite3_prepare_v2(sqlite3*, const char*, int, sqlite3_stmt**, const char**);
extern int sqlite3_step(sqlite3_stmt*);
extern int sqlite3_finalize(sqlite3_stmt*);
extern int sqlite3_reset(sqlite3_stmt*);
extern int sqlite3_column_count(sqlite3_stmt*);
extern int sqlite3_column_type(sqlite3_stmt*, int);
extern const unsigned char* sqlite3_column_text(sqlite3_stmt*, int);
extern int sqlite3_column_bytes(sqlite3_stmt*, int);
extern double sqlite3_column_double(sqlite3_stmt*, int);
extern const char* sqlite3_column_name(sqlite3_stmt*, int);
extern int sqlite3_bind_null(sqlite3_stmt*, int);
extern int sqlite3_bind_double(sqlite3_stmt*, int, double);
extern int sqlite3_bind_text(sqlite3_stmt*, int, const char*, int, void*);
extern int sqlite3_bind_blob(sqlite3_stmt*, int, const void*, int, void*);
extern int sqlite3_bind_int64(sqlite3_stmt*, int, int64_t);
extern const void* sqlite3_column_blob(sqlite3_stmt*, int);
extern int sqlite3_changes(sqlite3*);
extern int64_t sqlite3_last_insert_rowid(sqlite3*);
extern const char* sqlite3_errmsg(sqlite3*);

#define SB_SQLITE_ROW 100
#define SB_SQLITE_DONE 101
#define SB_SQLITE_TRANSIENT ((void*)-1)
// SQLITE_STATIC: "this buffer is yours to read and outlives the statement".
// Worth using for an object body — the alternative is sqlite copying it.
#define SB_SQLITE_STATIC ((void*)0)
#define SB_MAX_DB 16

static sqlite3* sb_dbs[SB_MAX_DB];
static char sb_db_names[SB_MAX_DB][256];
static int sb_db_count = 0;

// One handle per path, opened once and kept for the process lifetime — the same
// lifetime the broker gives a Database. Returns an index, or -1.
// Create every parent directory of path, like mkdir -p. A standalone binary
// has no launcher to prepare its data directory, and sqlite3_open creates files
// but never the directories above them.
static void sb_mkdirs(const char* path) {
  char tmp[1024];
  size_t n = strlen(path);
  if (n == 0 || n >= sizeof(tmp)) return;
  memcpy(tmp, path, n + 1);
  for (char* p = tmp + 1; *p; p++) {
    if (*p != '/') continue;
    *p = 0;
    mkdir(tmp, 0700);
    *p = '/';
  }
}

static int sb_db_for(const char* path) {
  for (int i = 0; i < sb_db_count; i++) {
    if (strcmp(sb_db_names[i], path) == 0) return i;
  }
  if (sb_db_count >= SB_MAX_DB) return -1;
  sqlite3* db = 0;
  sb_mkdirs(path);
  if (sqlite3_open(path, &db) != 0) return -1;
  // No mmap_size on purpose: mapping the database makes every page a read
  // touches count toward RSS, and measured on Linux that cost more than the
  // copy it saves once the file holds a few large objects. The page cache is
  // capped instead, and journal_size_limit stops the WAL staying huge after one
  // big write.
  sqlite3_exec(db,
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;"
    "PRAGMA cache_size=-2000; PRAGMA journal_size_limit=16777216;",
    0, 0, 0);
  sb_dbs[sb_db_count] = db;
  snprintf(sb_db_names[sb_db_count], 256, "%s", path);
  return sb_db_count++;
}

// --- a growable output buffer, for building the reply JSON ------------------
typedef struct { char* p; size_t len; size_t cap; } sb_buf;
static void sb_buf_need(sb_buf* b, size_t extra) {
  if (b->len + extra + 1 <= b->cap) return;
  size_t cap = b->cap ? b->cap * 2 : 1024;
  while (cap < b->len + extra + 1) cap *= 2;
  b->p = (char*)realloc(b->p, cap);
  b->cap = cap;
}
static void sb_put(sb_buf* b, const char* s, size_t n) {
  sb_buf_need(b, n);
  memcpy(b->p + b->len, s, n);
  b->len += n;
  b->p[b->len] = 0;
}
static void sb_puts(sb_buf* b, const char* s) { sb_put(b, s, strlen(s)); }
static void sb_putjson(sb_buf* b, const char* s, size_t n) {
  sb_put(b, "\"", 1);
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    if (c == '"' || c == '\\') { char e[2] = { '\\', (char)c }; sb_put(b, e, 2); }
    else if (c == '\n') sb_put(b, "\\n", 2);
    else if (c == '\r') sb_put(b, "\\r", 2);
    else if (c == '\t') sb_put(b, "\\t", 2);
    else if (c < 0x20) { char e[8]; int k = snprintf(e, 8, "\\u%04x", c); sb_put(b, e, (size_t)k); }
    else sb_put(b, (const char*)&c, 1);
  }
  sb_put(b, "\"", 1);
}

// --- the narrow JSON reader: a flat array of null | number | string ----------
// Only ever fed __sbSql's own params, which JS builds; anything unexpected
// binds as NULL rather than guessing.
static const char* sb_skip_ws(const char* p) { while (*p == ' ' || *p == '\n' || *p == '\t' || *p == '\r') p++; return p; }

static int sb_bind_params(sqlite3_stmt* st, const char* json) {
  const char* p = sb_skip_ws(json);
  if (*p != '[') return 0;
  p++;
  int index = 1;
  while (1) {
    p = sb_skip_ws(p);
    if (*p == ']' || *p == 0) break;
    if (*p == ',') { p++; continue; }
    if (*p == 'n') { sqlite3_bind_null(st, index++); p += 4; continue; }
    if (*p == '"') {
      p++;
      char* out = (char*)malloc(strlen(p) + 1);
      size_t n = 0;
      while (*p && *p != '"') {
        if (*p == '\\' && p[1]) {
          p++;
          char c = *p++;
          if (c == 'n') out[n++] = '\n';
          else if (c == 't') out[n++] = '\t';
          else if (c == 'r') out[n++] = '\r';
          // \b and \f are the two escapes JSON.stringify emits that are easy to
          // forget. Without them the fallthrough below writes the letter, so a
          // stored byte 0x08 came back as 'b' and 0x0c as 'f' — the only two
          // values in 0..255 that R2 could not round-trip.
          else if (c == 'b') out[n++] = 8;
          else if (c == 'f') out[n++] = 12;
          else if (c == 'u') {
            unsigned int cp = 0;
            for (int k = 0; k < 4 && *p; k++) {
              char h = *p++;
              cp = cp * 16 + (unsigned int)(h >= 'a' ? h - 'a' + 10 : (h >= 'A' ? h - 'A' + 10 : h - '0'));
            }
            // Encode as UTF-8; surrogate halves are passed through as-is.
            if (cp < 0x80) out[n++] = (char)cp;
            else if (cp < 0x800) { out[n++] = (char)(0xC0 | (cp >> 6)); out[n++] = (char)(0x80 | (cp & 0x3F)); }
            else { out[n++] = (char)(0xE0 | (cp >> 12)); out[n++] = (char)(0x80 | ((cp >> 6) & 0x3F)); out[n++] = (char)(0x80 | (cp & 0x3F)); }
          } else out[n++] = c;
        } else out[n++] = *p++;
      }
      if (*p == '"') p++;
      sqlite3_bind_text(st, index++, out, (int)n, SB_SQLITE_TRANSIENT);
      free(out);
      continue;
    }
    // number (or true/false, bound as 1/0)
    if (*p == 't') { sqlite3_bind_double(st, index++, 1); p += 4; continue; }
    if (*p == 'f') { sqlite3_bind_double(st, index++, 0); p += 5; continue; }
    {
      char* endp = 0;
      double v = strtod(p, &endp);
      if (endp == p) break; // not something we understand; stop rather than spin
      sqlite3_bind_double(st, index++, v);
      p = endp;
    }
  }
  return 0;
}

// --- R2 bodies, without the JSON detour -------------------------------------
// An object's bytes never enter a JSON frame: they arrive as their own string
// parameter and go straight into a BLOB column. That matters for size as much
// as correctness — escaping a binary body inflates it several times over, and
// the arena grows to fit the biggest thing it ever had to hold.

static void sb_hex32(const unsigned char* in, char* out) {
  static const char* d = "0123456789abcdef";
  for (int i = 0; i < 32; i++) { out[i * 2] = d[in[i] >> 4]; out[i * 2 + 1] = d[in[i] & 15]; }
  out[64] = 0;
}

// sha256 of the body, matching what the broker records as the etag.
static void sb_sha256_hex(const char* data, size_t len, char* out65) {
  br_sha256_context ctx;
  br_sha256_init(&ctx);
  br_sha256_update(&ctx, data, len);
  unsigned char digest[32];
  br_sha256_out(&ctx, digest);
  sb_hex32(digest, out65);
}

static void sb_iso_now(char* out, size_t cap) {
  time_t now = time(0);
  struct tm g;
  gmtime_r(&now, &g);
  strftime(out, cap, "%Y-%m-%dT%H:%M:%S.000Z", &g);
}

// Returns malloc'd JSON metadata; the body itself is never serialised.
static char* sb_r2_put_c(const char* path, const char* bucket, const char* key, const char* body, size_t bodylen,
                         const char* http_json, const char* custom_json) {
  sb_buf out = { 0, 0, 0 };
  int idx = sb_db_for(path);
  if (idx < 0) { sb_puts(&out, "{\"ok\":false,\"error\":\"cannot open database\"}"); return out.p; }
  sqlite3* db = sb_dbs[idx];

  char etag[65];
  sb_sha256_hex(body, bodylen, etag);
  char uploaded[40];
  sb_iso_now(uploaded, sizeof(uploaded));

  sqlite3_stmt* st = 0;
  const char* sql =
    "INSERT INTO r2 (bucket, key, body, size, etag, uploaded, http_json, custom_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) "
    "ON CONFLICT (bucket, key) DO UPDATE SET body=?3, size=?4, etag=?5, uploaded=?6, http_json=?7, custom_json=?8";
  if (sqlite3_prepare_v2(db, sql, -1, &st, 0) != 0 || !st) {
    sb_puts(&out, "{\"ok\":false,\"error\":");
    const char* m = sqlite3_errmsg(db);
    sb_putjson(&out, m, strlen(m));
    sb_puts(&out, "}");
    return out.p;
  }
  sqlite3_bind_text(st, 1, bucket, -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 2, key, -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_blob(st, 3, body, (int)bodylen, SB_SQLITE_STATIC);
  sqlite3_bind_int64(st, 4, (int64_t)bodylen);
  sqlite3_bind_text(st, 5, etag, -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 6, uploaded, -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 7, http_json && *http_json ? http_json : "{}", -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 8, custom_json && *custom_json ? custom_json : "{}", -1, SB_SQLITE_TRANSIENT);
  int rc = sqlite3_step(st);
  sqlite3_finalize(st);
  if (rc != SB_SQLITE_DONE) { sb_puts(&out, "{\"ok\":false,\"error\":\"r2 put failed\"}"); return out.p; }

  char head[256];
  int k = snprintf(head, sizeof(head), "{\"ok\":true,\"etag\":\"%s\",\"size\":%zu,\"uploaded\":\"%s\"}", etag, bodylen, uploaded);
  sb_put(&out, head, (size_t)k);
  return out.p;
}

// Body bytes straight into a Porffor bytestring.
//
// The allocation happens while the statement is still open, so sqlite's own
// buffer is the source and there is no intermediate copy: one 8 MB object means
// one 8 MB allocation, not two. Returns the bytestring pointer, or 0.
static u32 sb_r2_get_c(const char* path, const char* bucket, const char* key, int* found) {
  *found = 0;
  int idx = sb_db_for(path);
  if (idx < 0) return 0;
  sqlite3_stmt* st = 0;
  if (sqlite3_prepare_v2(sb_dbs[idx], "SELECT body FROM r2 WHERE bucket = ? AND key = ?", -1, &st, 0) != 0 || !st) return 0;
  sqlite3_bind_text(st, 1, bucket, -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 2, key, -1, SB_SQLITE_TRANSIENT);
  u32 out = 0;
  if (sqlite3_step(st) == SB_SQLITE_ROW) {
    int n = sqlite3_column_bytes(st, 0);
    const void* blob = sqlite3_column_blob(st, 0);
    out = porf_native_fetch_alloc_bytestring((const char*)(blob ? blob : ""), (size_t)(n > 0 ? n : 0));
    *found = 1;
  }
  sqlite3_finalize(st);
  return out;
}

// Run a script: one or more statements separated by semicolons. sqlite3_exec
// handles the whole string, which prepare/step does not — it compiles the first
// statement and silently ignores the rest, so a schema built from one exec call
// would come out with only its first table.
static char* sb_sql_script(const char* path, const char* sql) {
  sb_buf b = { 0, 0, 0 };
  int idx = sb_db_for(path);
  if (idx < 0) { sb_puts(&b, "{\"ok\":false,\"error\":\"cannot open database\"}"); return b.p; }
  char* err = 0;
  if (sqlite3_exec(sb_dbs[idx], sql, 0, 0, &err) != 0) {
    sb_puts(&b, "{\"ok\":false,\"error\":");
    sb_putjson(&b, err ? err : "exec failed", err ? strlen(err) : 11);
    sb_puts(&b, "}");
    return b.p;
  }
  sb_puts(&b, "{\"ok\":true}");
  return b.p;
}

// Run one statement. Returns malloc'd JSON:
//   {"ok":true,"cols":[...],"rows":[[...]],"changes":n,"rowid":n}
// or {"ok":false,"error":"..."}.
static char* sb_sql_run(const char* path, const char* sql, const char* params) {
  sb_buf b = { 0, 0, 0 };
  int idx = sb_db_for(path);
  if (idx < 0) { sb_puts(&b, "{\"ok\":false,\"error\":\"cannot open database\"}"); return b.p; }
  sqlite3* db = sb_dbs[idx];
  sqlite3_stmt* st = 0;
  if (sqlite3_prepare_v2(db, sql, -1, &st, 0) != 0 || !st) {
    sb_puts(&b, "{\"ok\":false,\"error\":");
    const char* m = sqlite3_errmsg(db);
    sb_putjson(&b, m, strlen(m));
    sb_puts(&b, "}");
    return b.p;
  }
  if (params && *params) sb_bind_params(st, params);

  sb_puts(&b, "{\"ok\":true,\"cols\":[");
  int ncol = sqlite3_column_count(st);
  for (int i = 0; i < ncol; i++) {
    if (i) sb_puts(&b, ",");
    const char* name = sqlite3_column_name(st, i);
    sb_putjson(&b, name ? name : "", name ? strlen(name) : 0);
  }
  sb_puts(&b, "],\"rows\":[");
  int rc, first = 1;
  while ((rc = sqlite3_step(st)) == SB_SQLITE_ROW) {
    if (!first) sb_puts(&b, ",");
    first = 0;
    sb_puts(&b, "[");
    for (int i = 0; i < ncol; i++) {
      if (i) sb_puts(&b, ",");
      int t = sqlite3_column_type(st, i);
      if (t == 5) { sb_puts(&b, "null"); continue; }             // SQLITE_NULL
      if (t == 1 || t == 2) {                                     // INTEGER / FLOAT
        char num[40];
        int k = snprintf(num, 40, "%.17g", sqlite3_column_double(st, i));
        sb_put(&b, num, (size_t)k);
        continue;
      }
      const unsigned char* txt = sqlite3_column_text(st, i);
      int n = sqlite3_column_bytes(st, i);
      sb_putjson(&b, txt ? (const char*)txt : "", txt ? (size_t)n : 0);
    }
    sb_puts(&b, "]");
  }
  char tail[96];
  int k = snprintf(tail, 96, "],\"changes\":%d,\"rowid\":%lld}", sqlite3_changes(db), (long long)sqlite3_last_insert_rowid(db));
  sb_put(&b, tail, (size_t)k);
  sqlite3_finalize(st);
  if (rc != SB_SQLITE_DONE && rc != SB_SQLITE_ROW) {
    free(b.p);
    sb_buf e = { 0, 0, 0 };
    sb_puts(&e, "{\"ok\":false,\"error\":");
    const char* m = sqlite3_errmsg(db);
    sb_putjson(&e, m, strlen(m));
    sb_puts(&e, "}");
    return e.p;
  }
  return b.p;
}

// --- outbound HTTP + HTTPS ---------------------------------------------------
// Plain sockets for http, BearSSL for https, with the Mozilla root set compiled
// in (see src/bearssl.ts). Both directions share the request builder and the
// response parser: the only thing that differs is how bytes move.

// #56 — an outbound response is held whole in memory, and its size is chosen by
// the remote host, not by us. Without a cap one allowlisted upstream can drive a
// sprout out of memory: a 100 MB body measured at 321 MB resident. 32 MiB by
// default, raisable for a deployment that knowingly fetches something bigger.
static size_t sb_fetch_max(void) {
  static size_t cached = 0;
  if (cached == 0) {
    const char* raw = getenv("SB_FETCH_MAX_BYTES");
    long parsed = raw && *raw ? atol(raw) : 0;
    cached = parsed > 0 ? (size_t)parsed : 32u * 1024u * 1024u;
  }
  return cached;
}

static int sb_tcp_connect(const char* host, int port) {
  struct addrinfo hints, *res = 0, *it;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  char portstr[16];
  snprintf(portstr, sizeof(portstr), "%d", port);
  if (getaddrinfo(host, portstr, &hints, &res) != 0 || !res) return -1;
  int fd = -1;
  for (it = res; it; it = it->ai_next) {
    fd = socket(it->ai_family, it->ai_socktype, it->ai_protocol);
    if (fd < 0) continue;
    struct timeval tv; tv.tv_sec = 30; tv.tv_usec = 0;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    if (connect(fd, it->ai_addr, it->ai_addrlen) == 0) break;
    close(fd);
    fd = -1;
  }
  freeaddrinfo(res);
  return fd;
}

static void sb_build_request(sb_buf* req, const char* host, const char* path, const char* method,
                             const char* headers, const char* body) {
  sb_puts(req, method); sb_puts(req, " "); sb_puts(req, path); sb_puts(req, " HTTP/1.1\r\n");
  sb_puts(req, "Host: "); sb_puts(req, host); sb_puts(req, "\r\n");
  sb_puts(req, "Connection: close\r\n");
  sb_puts(req, "Accept-Encoding: identity\r\n");
  if (headers && *headers) sb_puts(req, headers);
  size_t blen = body ? strlen(body) : 0;
  if (blen) {
    char cl[64];
    int k = snprintf(cl, sizeof(cl), "Content-Length: %zu\r\n", blen);
    sb_put(req, cl, (size_t)k);
  }
  sb_puts(req, "\r\n");
  if (blen) sb_put(req, body, blen);
}

// Turn a whole raw response into the reply frame. Returns malloc'd JSON.
static char* sb_parse_response(sb_buf* raw) {
  sb_buf out = { 0, 0, 0 };
  const char* head_end = raw->p ? strstr(raw->p, "\r\n\r\n") : 0;
  if (!head_end) {
    sb_puts(&out, "{\"ok\":false,\"error\":\"malformed response\"}");
    return out.p;
  }
  int status = 0;
  {
    const char* sp = strchr(raw->p, ' ');
    if (sp) status = atoi(sp + 1);
  }

  int chunked = 0;
  long content_length = -1;
  sb_buf hdrs = { 0, 0, 0 };
  sb_puts(&hdrs, "[");
  {
    const char* line = strstr(raw->p, "\r\n");
    int first = 1;
    while (line && line + 2 < head_end) {
      line += 2;
      const char* eol = strstr(line, "\r\n");
      if (!eol || eol > head_end) break;
      const char* colon = memchr(line, ':', (size_t)(eol - line));
      if (colon) {
        const char* vs = colon + 1;
        while (vs < eol && (*vs == ' ' || *vs == 9)) vs++;
        size_t klen = (size_t)(colon - line);
        if (!first) sb_puts(&hdrs, ",");
        first = 0;
        sb_puts(&hdrs, "[");
        sb_putjson(&hdrs, line, klen);
        sb_puts(&hdrs, ",");
        sb_putjson(&hdrs, vs, (size_t)(eol - vs));
        sb_puts(&hdrs, "]");
        if (klen == 17 && strncasecmp(line, "transfer-encoding", 17) == 0 && strncasecmp(vs, "chunked", 7) == 0)
          chunked = 1;
        if (klen == 14 && strncasecmp(line, "content-length", 14) == 0) content_length = atol(vs);
      }
      line = eol;
    }
  }
  sb_puts(&hdrs, "]");

  const char* bodyp = head_end + 4;
  size_t bodylen = raw->len - (size_t)(bodyp - raw->p);

  sb_buf decoded = { 0, 0, 0 };
  if (chunked) {
    const char* p = bodyp;
    const char* end = bodyp + bodylen;
    while (p < end) {
      char* stop = 0;
      long size = strtol(p, &stop, 16);
      if (!stop || size <= 0) break;
      p = strstr(stop, "\r\n");
      if (!p) break;
      p += 2;
      if (p + size > end) break;
      sb_put(&decoded, p, (size_t)size);
      p += size + 2;
    }
    bodyp = decoded.p ? decoded.p : "";
    bodylen = decoded.len;
  }

  char head[96];
  int k = snprintf(head, sizeof(head), "{\"ok\":true,\"status\":%d,\"complete\":%d,\"headers\":",
                   status, (content_length < 0 || (long)bodylen >= content_length) ? 1 : 0);
  sb_put(&out, head, (size_t)k);
  sb_put(&out, hdrs.p, hdrs.len);
  sb_puts(&out, ",\"body\":");
  sb_putjson(&out, bodyp, bodylen);
  sb_puts(&out, "}");
  free(hdrs.p);
  free(decoded.p);
  return out.p;
}

static char* sb_error_json(const char* prefix, const char* detail) {
  sb_buf out = { 0, 0, 0 };
  sb_puts(&out, "{\"ok\":false,\"error\":");
  sb_buf msg = { 0, 0, 0 };
  sb_puts(&msg, prefix);
  if (detail) { sb_puts(&msg, detail); }
  sb_putjson(&out, msg.p ? msg.p : "", msg.len);
  sb_puts(&out, "}");
  free(msg.p);
  return out.p;
}

static char* sb_http_plain(const char* host, int port, const char* path, const char* method,
                           const char* headers, const char* body) {
  int fd = sb_tcp_connect(host, port);
  if (fd < 0) return sb_error_json("could not connect to ", host);

  sb_buf req = { 0, 0, 0 };
  sb_build_request(&req, host, path, method, headers, body);
  size_t sent = 0;
  while (sent < req.len) {
    long n = write(fd, req.p + sent, req.len - sent);
    if (n <= 0) { if (n < 0 && errno == EINTR) continue; break; }
    sent += (size_t)n;
  }
  free(req.p);

  sb_buf raw = { 0, 0, 0 };
  char chunk[8192];
  int too_big = 0;
  while (1) {
    long n = read(fd, chunk, sizeof(chunk));
    if (n > 0) {
      if (raw.len + (size_t)n > sb_fetch_max()) { too_big = 1; break; }
      sb_put(&raw, chunk, (size_t)n);
      continue;
    }
    if (n < 0 && errno == EINTR) continue;
    break;
  }
  close(fd);
  if (too_big) { free(raw.p); return sb_error_json("response exceeds SB_FETCH_MAX_BYTES from ", host); }
  char* out = sb_parse_response(&raw);
  free(raw.p);
  return out;
}

// --- TLS ---------------------------------------------------------------------
// Trust anchors come from src/bearssl.ts: the Mozilla root set, compiled in.
extern const br_x509_trust_anchor sb_trust_anchors[];
extern const size_t sb_trust_anchor_count;

// SB_CA_BUNDLE: extra roots, read at run time.
//
// Adds trust, never removes it — the compiled-in Mozilla set stays in force, so
// pointing at a file with one corporate CA cannot silently stop public
// certificates from validating. Nothing here can disable verification.
//
// Adapted from BearSSL's own tools/certs.c (same MIT licence), which is the
// reference for turning a DER certificate into a trust anchor.
static br_x509_trust_anchor* sb_ca_extra = 0;
static size_t sb_ca_extra_count = 0;
static const br_x509_trust_anchor* sb_all_anchors = 0;
static size_t sb_all_anchor_count = 0;

static void sb_buf_append(void* ctx, const void* buf, size_t len) {
  sb_put((sb_buf*)ctx, (const char*)buf, len);
}

static unsigned char* sb_blobdup(const void* src, size_t len) {
  unsigned char* out = (unsigned char*)malloc(len ? len : 1);
  if (out && len) memcpy(out, src, len);
  return out;
}

// One DER certificate -> one appended trust anchor. Returns 0 on success.
static int sb_add_anchor(const unsigned char* der, size_t len) {
  br_x509_decoder_context dc;
  sb_buf dn = { 0, 0, 0 };
  br_x509_decoder_init(&dc, sb_buf_append, &dn);
  br_x509_decoder_push(&dc, der, len);
  br_x509_pkey* pk = br_x509_decoder_get_pkey(&dc);
  if (!pk) { free(dn.p); return -1; }

  br_x509_trust_anchor ta;
  memset(&ta, 0, sizeof(ta));
  ta.dn.data = (unsigned char*)dn.p;
  ta.dn.len = dn.len;
  ta.flags = br_x509_decoder_isCA(&dc) ? BR_X509_TA_CA : 0;
  if (pk->key_type == BR_KEYTYPE_RSA) {
    ta.pkey.key_type = BR_KEYTYPE_RSA;
    ta.pkey.key.rsa.n = sb_blobdup(pk->key.rsa.n, pk->key.rsa.nlen);
    ta.pkey.key.rsa.nlen = pk->key.rsa.nlen;
    ta.pkey.key.rsa.e = sb_blobdup(pk->key.rsa.e, pk->key.rsa.elen);
    ta.pkey.key.rsa.elen = pk->key.rsa.elen;
  } else if (pk->key_type == BR_KEYTYPE_EC) {
    ta.pkey.key_type = BR_KEYTYPE_EC;
    ta.pkey.key.ec.curve = pk->key.ec.curve;
    ta.pkey.key.ec.q = sb_blobdup(pk->key.ec.q, pk->key.ec.qlen);
    ta.pkey.key.ec.qlen = pk->key.ec.qlen;
  } else {
    free(dn.p);
    return -1; // a key type BearSSL cannot verify with
  }

  br_x509_trust_anchor* grown =
    (br_x509_trust_anchor*)realloc(sb_ca_extra, (sb_ca_extra_count + 1) * sizeof(br_x509_trust_anchor));
  if (!grown) { free(dn.p); return -1; }
  sb_ca_extra = grown;
  sb_ca_extra[sb_ca_extra_count++] = ta;
  return 0;
}

// Read every CERTIFICATE block out of a PEM file and add it.
static void sb_load_ca_bundle(const char* path) {
  FILE* f = fopen(path, "rb");
  if (!f) {
    fprintf(stderr, "sproutboat: SB_CA_BUNDLE %s could not be opened; using the built-in roots only\n", path);
    return;
  }
  sb_buf pem = { 0, 0, 0 };
  char chunk[8192];
  size_t n;
  while ((n = fread(chunk, 1, sizeof(chunk), f)) > 0) sb_put(&pem, chunk, n);
  fclose(f);

  br_pem_decoder_context pc;
  br_pem_decoder_init(&pc);
  sb_buf der = { 0, 0, 0 };
  int in_cert = 0, added = 0;
  size_t off = 0;
  while (off < pem.len) {
    size_t used = br_pem_decoder_push(&pc, pem.p + off, pem.len - off);
    off += used;
    switch (br_pem_decoder_event(&pc)) {
      case BR_PEM_BEGIN_OBJ: {
        const char* name = br_pem_decoder_name(&pc);
        in_cert = name && (strcmp(name, "CERTIFICATE") == 0 || strcmp(name, "X509 CERTIFICATE") == 0);
        der.len = 0;
        if (in_cert) br_pem_decoder_setdest(&pc, sb_buf_append, &der);
        else br_pem_decoder_setdest(&pc, 0, 0);
        break;
      }
      case BR_PEM_END_OBJ:
        if (in_cert && der.len && sb_add_anchor((const unsigned char*)der.p, der.len) == 0) added++;
        der.len = 0;
        in_cert = 0;
        break;
      case BR_PEM_ERROR:
        fprintf(stderr, "sproutboat: SB_CA_BUNDLE %s is not valid PEM\n", path);
        off = pem.len;
        break;
      default:
        break;
    }
    if (used == 0 && br_pem_decoder_event(&pc) == 0) break; // no progress, no event
  }
  free(pem.p);
  free(der.p);
  if (added == 0) fprintf(stderr, "sproutboat: SB_CA_BUNDLE %s held no usable certificates\n", path);
}

// The anchor set every handshake verifies against: built in, plus SB_CA_BUNDLE.
static void sb_init_anchors(void) {
  if (sb_all_anchors) return;
  const char* path = getenv("SB_CA_BUNDLE");
  if (path && *path) sb_load_ca_bundle(path);
  if (sb_ca_extra_count == 0) {
    sb_all_anchors = sb_trust_anchors;
    sb_all_anchor_count = sb_trust_anchor_count;
    return;
  }
  size_t total = sb_trust_anchor_count + sb_ca_extra_count;
  br_x509_trust_anchor* all = (br_x509_trust_anchor*)malloc(total * sizeof(br_x509_trust_anchor));
  if (!all) {
    sb_all_anchors = sb_trust_anchors;
    sb_all_anchor_count = sb_trust_anchor_count;
    return;
  }
  memcpy(all, sb_trust_anchors, sb_trust_anchor_count * sizeof(br_x509_trust_anchor));
  memcpy(all + sb_trust_anchor_count, sb_ca_extra, sb_ca_extra_count * sizeof(br_x509_trust_anchor));
  sb_all_anchors = all;
  sb_all_anchor_count = total;
}

static int sb_sock_read(void* ctx, unsigned char* buf, size_t len) {
  for (;;) {
    ssize_t n = read(*(int*)ctx, buf, len);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return -1;
    return (int)n;
  }
}
static int sb_sock_write(void* ctx, const unsigned char* buf, size_t len) {
  for (;;) {
    ssize_t n = write(*(int*)ctx, buf, len);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return -1;
    return (int)n;
  }
}

static char* sb_https(const char* host, int port, const char* path, const char* method,
                      const char* headers, const char* body) {
  int fd = sb_tcp_connect(host, port);
  if (fd < 0) return sb_error_json("could not connect to ", host);

  br_ssl_client_context* sc = (br_ssl_client_context*)malloc(sizeof(br_ssl_client_context));
  br_x509_minimal_context* xc = (br_x509_minimal_context*)malloc(sizeof(br_x509_minimal_context));
  unsigned char* iobuf = (unsigned char*)malloc(BR_SSL_BUFSIZE_BIDI);
  if (!sc || !xc || !iobuf) {
    free(sc); free(xc); free(iobuf); close(fd);
    return sb_error_json("out of memory setting up TLS for ", host);
  }
  br_sslio_context ioc;
  sb_init_anchors();
  br_ssl_client_init_full(sc, xc, sb_all_anchors, sb_all_anchor_count);
  br_ssl_engine_set_buffer(&sc->eng, iobuf, BR_SSL_BUFSIZE_BIDI, 1);
  br_ssl_client_reset(sc, host, 0);
  br_sslio_init(&ioc, &sc->eng, sb_sock_read, &fd, sb_sock_write, &fd);

  sb_buf req = { 0, 0, 0 };
  sb_build_request(&req, host, path, method, headers, body);
  int wrote = br_sslio_write_all(&ioc, req.p, req.len);
  free(req.p);
  if (wrote != 0) {
    char detail[96];
    snprintf(detail, sizeof(detail), "%s (tls error %d)", host, br_ssl_engine_last_error(&sc->eng));
    free(sc); free(xc); free(iobuf); close(fd);
    return sb_error_json("TLS handshake failed for ", detail);
  }
  br_sslio_flush(&ioc);

  sb_buf raw = { 0, 0, 0 };
  char chunk[8192];
  int rc, too_big = 0;
  while ((rc = br_sslio_read(&ioc, chunk, sizeof(chunk))) > 0) {
    if (raw.len + (size_t)rc > sb_fetch_max()) { too_big = 1; break; }
    sb_put(&raw, chunk, (size_t)rc);
  }
  int err = br_ssl_engine_last_error(&sc->eng);
  free(sc); free(xc); free(iobuf);
  close(fd);
  if (too_big) { free(raw.p); return sb_error_json("response exceeds SB_FETCH_MAX_BYTES from ", host); }

  // BR_ERR_IO here means the peer closed without close_notify, which is what
  // most servers do on Connection: close. It is indistinguishable from a
  // truncation attack on its own, so the reply carries "complete" (whether the
  // body satisfied Content-Length) and the JS side decides.
  char* out = sb_parse_response(&raw);
  free(raw.p);
  if (err != 0 && err != BR_ERR_IO) {
    free(out);
    char detail[64];
    snprintf(detail, sizeof(detail), "tls error %d", err);
    return sb_error_json("", detail);
  }
  if (err == BR_ERR_IO) {
    // Mark it so JS can refuse a body that was cut short.
    char* marked = (char*)malloc(strlen(out) + 32);
    if (marked) {
      size_t n = strlen(out);
      memcpy(marked, out, n - 1);
      memcpy(marked + n - 1, ",\"unclean\":true}", 17);
      free(out);
      return marked;
    }
  }
  return out;
}

static char* sb_http_request(const char* host, int port, const char* path, const char* method,
                             const char* headers, const char* body, int tls) {
  return tls ? sb_https(host, port, path, method, headers, body)
             : sb_http_plain(host, port, path, method, headers, body);
}
`;

// R2 put: the body is its own parameter, so it never gets escaped.
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbR2PutRaw(path, bucket, key, body, httpJson, customJson) {
  let res = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __p; size_t __pl; char* __po = 0;
    porf_native_fetch_read_value(path, &__p, &__pl, &__po);
    char* __path = (char*)malloc(__pl + 1); memcpy(__path, __p, __pl); __path[__pl] = 0;
    if (__po) free(__po);

    const char* __bk; size_t __bkl; char* __bko = 0;
    porf_native_fetch_read_value(bucket, &__bk, &__bkl, &__bko);
    char* __bucket = (char*)malloc(__bkl + 1); memcpy(__bucket, __bk, __bkl); __bucket[__bkl] = 0;
    if (__bko) free(__bko);

    const char* __k; size_t __kl; char* __ko = 0;
    porf_native_fetch_read_value(key, &__k, &__kl, &__ko);
    char* __key = (char*)malloc(__kl + 1); memcpy(__key, __k, __kl); __key[__kl] = 0;
    if (__ko) free(__ko);

    const char* __h; size_t __hl; char* __ho = 0;
    porf_native_fetch_read_value(httpJson, &__h, &__hl, &__ho);
    char* __http = (char*)malloc(__hl + 1); memcpy(__http, __h, __hl); __http[__hl] = 0;
    if (__ho) free(__ho);

    const char* __c; size_t __cl; char* __co = 0;
    porf_native_fetch_read_value(customJson, &__c, &__cl, &__co);
    char* __custom = (char*)malloc(__cl + 1); memcpy(__custom, __c, __cl); __custom[__cl] = 0;
    if (__co) free(__co);

    // The body is read in place and handed straight to sqlite3_bind_blob: no
    // copy beyond what the binding needs, and no escaping at all.
    const char* __b; size_t __bl; char* __bo = 0;
    porf_native_fetch_read_value(body, &__b, &__bl, &__bo);
    char* __out = sb_r2_put_c(__path, __bucket, __key, __b, __bl, __http, __custom);
    if (__bo) free(__bo);

    free(__path); free(__bucket); free(__key); free(__http); free(__custom);
    if (__out) {
      res = porf_box((f64)porf_native_fetch_alloc_bytestring(__out, strlen(__out)), 195);
      free(__out);
    }
  `;
  return res;
}

// R2 get: the bytes come back as a bytestring, not inside a reply frame.
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbR2GetRaw(path, bucket, key) {
  let res = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __p; size_t __pl; char* __po = 0;
    porf_native_fetch_read_value(path, &__p, &__pl, &__po);
    char* __path = (char*)malloc(__pl + 1); memcpy(__path, __p, __pl); __path[__pl] = 0;
    if (__po) free(__po);

    const char* __bk; size_t __bkl; char* __bko = 0;
    porf_native_fetch_read_value(bucket, &__bk, &__bkl, &__bko);
    char* __bucket = (char*)malloc(__bkl + 1); memcpy(__bucket, __bk, __bkl); __bucket[__bkl] = 0;
    if (__bko) free(__bko);

    const char* __k; size_t __kl; char* __ko = 0;
    porf_native_fetch_read_value(key, &__k, &__kl, &__ko);
    char* __key = (char*)malloc(__kl + 1); memcpy(__key, __k, __kl); __key[__kl] = 0;
    if (__ko) free(__ko);

    int __found = 0;
    u32 __bs = sb_r2_get_c(__path, __bucket, __key, &__found);
    free(__path); free(__bucket); free(__key);
    if (__found) res = porf_box((f64)__bs, 195);
  `;
  return res;
}

// Multi-statement exec. Same string-param pattern as __sbSqlRaw.
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbSqlScriptRaw(path, sql) {
  let res = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __p; size_t __pl; char* __po = 0;
    porf_native_fetch_read_value(path, &__p, &__pl, &__po);
    char* __path = (char*)malloc(__pl + 1); memcpy(__path, __p, __pl); __path[__pl] = 0;
    if (__po) free(__po);

    const char* __s; size_t __sl; char* __so = 0;
    porf_native_fetch_read_value(sql, &__s, &__sl, &__so);
    char* __sql = (char*)malloc(__sl + 1); memcpy(__sql, __s, __sl); __sql[__sl] = 0;
    if (__so) free(__so);

    char* __out = sb_sql_script(__path, __sql);
    free(__path); free(__sql);
    if (__out) {
      res = porf_box((f64)porf_native_fetch_alloc_bytestring(__out, strlen(__out)), 195);
      free(__out);
    }
  `;
  return res;
}

// Outbound HTTP. String params so C can read each directly; the JS side has
// already split the URL and enforced the allowlist. `tlsFlag` is "1" or "0" —
// a string like the rest, so the marshalling stays uniform.
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbHttpRaw(host, portStr, path, method, headersText, body, tlsFlag) {
  let res = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __h; size_t __hl; char* __ho = 0;
    porf_native_fetch_read_value(host, &__h, &__hl, &__ho);
    char* __host = (char*)malloc(__hl + 1); memcpy(__host, __h, __hl); __host[__hl] = 0;
    if (__ho) free(__ho);

    const char* __pt; size_t __ptl; char* __pto = 0;
    porf_native_fetch_read_value(portStr, &__pt, &__ptl, &__pto);
    char __portbuf[16]; size_t __ptk = __ptl < 15 ? __ptl : 15;
    memcpy(__portbuf, __pt, __ptk); __portbuf[__ptk] = 0;
    if (__pto) free(__pto);

    const char* __pa; size_t __pal; char* __pao = 0;
    porf_native_fetch_read_value(path, &__pa, &__pal, &__pao);
    char* __path = (char*)malloc(__pal + 1); memcpy(__path, __pa, __pal); __path[__pal] = 0;
    if (__pao) free(__pao);

    const char* __m; size_t __ml; char* __mo = 0;
    porf_native_fetch_read_value(method, &__m, &__ml, &__mo);
    char* __method = (char*)malloc(__ml + 1); memcpy(__method, __m, __ml); __method[__ml] = 0;
    if (__mo) free(__mo);

    const char* __hd; size_t __hdl; char* __hdo = 0;
    porf_native_fetch_read_value(headersText, &__hd, &__hdl, &__hdo);
    char* __hdrs = (char*)malloc(__hdl + 1); memcpy(__hdrs, __hd, __hdl); __hdrs[__hdl] = 0;
    if (__hdo) free(__hdo);

    const char* __b; size_t __bl; char* __bo = 0;
    porf_native_fetch_read_value(body, &__b, &__bl, &__bo);
    char* __body = (char*)malloc(__bl + 1); memcpy(__body, __b, __bl); __body[__bl] = 0;
    if (__bo) free(__bo);

    const char* __t; size_t __tl; char* __to = 0;
    porf_native_fetch_read_value(tlsFlag, &__t, &__tl, &__to);
    int __tls = (__tl > 0 && __t[0] == '1') ? 1 : 0;
    if (__to) free(__to);

    char* __out = sb_http_request(__host, atoi(__portbuf), __path, __method, __hdrs, __body, __tls);
    free(__host); free(__path); free(__method); free(__hdrs); free(__body);
    if (__out) {
      res = porf_box((f64)porf_native_fetch_alloc_bytestring(__out, strlen(__out)), 195);
      free(__out);
    }
  `;
  return res;
}

// One statement in, one JSON reply out. `path`, `sql` and `paramsJson` are
// parameters so the generated C names them directly.
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbSqlRaw(path, sql, paramsJson) {
  let res = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __p; size_t __pl; char* __po = 0;
    porf_native_fetch_read_value(path, &__p, &__pl, &__po);
    char* __path = (char*)malloc(__pl + 1); memcpy(__path, __p, __pl); __path[__pl] = 0;
    if (__po) free(__po);

    const char* __s; size_t __sl; char* __so = 0;
    porf_native_fetch_read_value(sql, &__s, &__sl, &__so);
    char* __sql = (char*)malloc(__sl + 1); memcpy(__sql, __s, __sl); __sql[__sl] = 0;
    if (__so) free(__so);

    const char* __a; size_t __al; char* __ao = 0;
    porf_native_fetch_read_value(paramsJson, &__a, &__al, &__ao);
    char* __args = (char*)malloc(__al + 1); memcpy(__args, __a, __al); __args[__al] = 0;
    if (__ao) free(__ao);

    char* __out = sb_sql_run(__path, __sql, __args);
    free(__path); free(__sql); free(__args);
    if (__out) {
      res = porf_box((f64)porf_native_fetch_alloc_bytestring(__out, strlen(__out)), 195);
      free(__out);
    } else {
      res = porf_box((f64)porf_native_fetch_alloc_bytestring("{\"ok\":false,\"error\":\"no result\"}", 38), 195);
    }
  `;
  return res;
}

// --- the op dispatch, in JS -------------------------------------------------
// Deliberately the same SQL and the same partition keys as broker.ts. When one
// changes the other has to, and the conformance suite is what says so.

// The allowlist is baked into the module by wrap.ts; read it lazily so the
// dispatch has no import-order dependency on __sbInstallBindings.
function bindingsOutbound() {
  return globalThis.__sbOutbound || [];
}

var __sbDataDir = "";
function __sbDir() {
  // SB_DATA_DIR, then SPROUTBOAT_DATA, then <name>.data relative to the working
  // directory. Environment only: a native-fetch binary never sees argv, because
  // Porffor's runtime init calls porf_init(0, NULL). Resolved once — the answer
  // cannot change mid-run.
  if (!__sbDataDir) {
    __sbDataDir = __sbEnv("SB_DATA_DIR") || __sbEnv("SPROUTBOAT_DATA") || (globalThis.__sbAppName || "app") + ".data";
  }
  return __sbDataDir;
}
function __sbStore() {
  return __sbDir() + "/store.sqlite";
}
function __sbD1Path(name) {
  return __sbDir() + "/d1/" + name + ".sqlite";
}

function __sbSql(path, sql, params) {
  const reply = JSON.parse(__sbSqlRaw(path, sql, params == null ? "[]" : JSON.stringify(params)));
  if (reply.ok === false) throw new Error("sqlite: " + reply.error);
  return reply;
}

var __sbSchemaReady = false;
function __sbEnsureSchema() {
  if (__sbSchemaReady) return;
  __sbSchemaReady = true;
  const s = __sbStore();
  __sbSql(
    s,
    "CREATE TABLE IF NOT EXISTS kv (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (ns, key))",
  );
  __sbSql(
    s,
    "CREATE TABLE IF NOT EXISTS r2 (bucket TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, size INTEGER NOT NULL, " +
      "etag TEXT NOT NULL, uploaded TEXT NOT NULL, http_json TEXT NOT NULL DEFAULT '{}', custom_json TEXT NOT NULL DEFAULT '{}', " +
      "PRIMARY KEY (bucket, key))",
  );
  __sbSql(
    s,
    "CREATE TABLE IF NOT EXISTS mq (queue TEXT NOT NULL, id TEXT PRIMARY KEY, body TEXT NOT NULL, " +
      "visible_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, dead INTEGER NOT NULL DEFAULT 0)",
  );
  // Additive: old standalone store.sqlite files gain the poll index on open.
  __sbSql(s, "CREATE INDEX IF NOT EXISTS mq_due ON mq (queue, dead, visible_at)", []);
  __sbSql(
    s,
    "CREATE TABLE IF NOT EXISTS do_storage (cls TEXT NOT NULL, id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (cls, id, key))",
  );
  __sbSql(
    s,
    "CREATE TABLE IF NOT EXISTS do_alarm (cls TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (cls, id))",
  );
  __sbSql(s, "CREATE INDEX IF NOT EXISTS do_alarm_due ON do_alarm (at)", []);
  __sbSql(
    s,
    "CREATE TABLE IF NOT EXISTS ae (dataset TEXT NOT NULL, ts INTEGER NOT NULL, indexes_json TEXT NOT NULL, blobs_json TEXT NOT NULL, doubles_json TEXT NOT NULL)",
  );
}

function __sbHex(n) {
  let out = "";
  const bytes = __sbRandomBytes(String(n));
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes.charCodeAt(i).toString(16);
    out += h.length === 1 ? "0" + h : h;
  }
  return out;
}

function __sbEmbeddedDispatch(msg) {
  __sbEnsureSchema();
  const store = __sbStore();
  const op = msg.op;

  if (op === "ping") return { ok: true, op: "pong", echo: msg.msg };

  if (op === "kv.get") {
    const r = __sbSql(store, "SELECT value FROM kv WHERE ns = ? AND key = ?", [msg.ns, msg.key]);
    return r.rows.length ? { ok: true, found: true, value: r.rows[0][0] } : { ok: true, found: false, value: null };
  }
  if (op === "kv.put") {
    __sbSql(store, "INSERT INTO kv (ns, key, value) VALUES (?1,?2,?3) ON CONFLICT (ns, key) DO UPDATE SET value = ?3", [
      msg.ns,
      msg.key,
      msg.value,
    ]);
    return { ok: true };
  }
  if (op === "kv.delete") {
    __sbSql(store, "DELETE FROM kv WHERE ns = ? AND key = ?", [msg.ns, msg.key]);
    return { ok: true };
  }
  if (op === "kv.list") {
    const r = __sbSql(store, "SELECT key FROM kv WHERE ns = ? AND key LIKE ? || '%' ORDER BY key", [
      msg.ns,
      msg.prefix || "",
    ]);
    const keys = [];
    for (let i = 0; i < r.rows.length; i++) keys.push(r.rows[i][0]);
    return { ok: true, keys };
  }

  if (op === "assets.get") {
    // Assets are baked into the module by the build (wrap.ts), so a standalone
    // binary serves them with nothing beside it on disk. Same resolution rules
    // as src/assets.ts and the same reply shape as the broker.
    const bundle = globalThis.__sbAssets;
    if (!bundle) throw new Error("assets not bound");
    const files = bundle.files || {};
    const meta = (bundle.manifest && bundle.manifest.files) || {};
    let path = String(msg.path || "/");
    if (path.charAt(0) !== "/") path = "/" + path;

    let key = null;
    if (path.charAt(path.length - 1) === "/") {
      const index = path + "index.html";
      if (files[index] != null) key = index;
    } else if (files[path] != null) {
      key = path;
    } else {
      const base = path.slice(path.lastIndexOf("/") + 1);
      if (base.indexOf(".") === -1) {
        if (files[path + ".html"] != null) key = path + ".html";
        else if (files[path + "/index.html"] != null) key = path + "/index.html";
      }
    }
    if (key != null) {
      const info = meta[key] || {};
      return { ok: true, found: true, status: 200, type: info.type, hash: info.hash, body: files[key] };
    }
    const nfh = (bundle.manifest && bundle.manifest.notFound) || "none";
    if (nfh === "single-page-application" && files["/index.html"] != null) {
      const info = meta["/index.html"] || {};
      return { ok: true, found: true, status: 200, type: info.type, hash: info.hash, body: files["/index.html"] };
    }
    if (nfh === "404-page" && files["/404.html"] != null) {
      const info = meta["/404.html"] || {};
      return { ok: true, found: false, status: 404, type: info.type, body: files["/404.html"] };
    }
    return { ok: true, found: false, status: 404, body: "Not Found" };
  }

  if (op === "fetch") {
    const url = new URL(String(msg.url));
    const tls = url.protocol === "https:";
    if (!tls && url.protocol !== "http:") throw new Error("unsupported protocol: " + url.protocol);
    const allow = bindingsOutbound();
    if (allow.indexOf(url.host) === -1) throw new Error("host not in outbound allowlist: " + url.host);
    let headerText = "";
    const pairs = msg.headers || [];
    for (let i = 0; i < pairs.length; i++) {
      const key = String(pairs[i][0]).toLowerCase();
      // Host, Connection and Content-Length are ours to set.
      if (key === "host" || key === "connection" || key === "content-length") continue;
      headerText += pairs[i][0] + ": " + pairs[i][1] + "\r\n";
    }
    const port = url.port ? url.port : tls ? "443" : "80";
    const reply = JSON.parse(
      __sbHttpRaw(
        url.hostname,
        port,
        url.pathname + url.search,
        String(msg.method || "GET").toUpperCase(),
        headerText,
        msg.body == null ? "" : String(msg.body),
        tls ? "1" : "0",
      ),
    );
    if (reply.ok === false) throw new Error(reply.error);
    // A TLS peer that closed without close_notify is normal on Connection:
    // close, and also what a truncation attack looks like. Accept it only when
    // Content-Length says the body arrived whole.
    if (reply.unclean && !reply.complete) {
      throw new Error("connection closed before the response was complete");
    }
    return { ok: true, status: reply.status, headers: reply.headers, body: reply.body };
  }

  if (op === "secret.get") {
    // Secrets reach a standalone binary through the environment, the same
    // channel the launcher and the supervisor use; there is nothing to decrypt.
    const value = __sbEnv(String(msg.name));
    if (!value) throw new Error("secret not set: " + msg.name);
    return { ok: true, value };
  }

  if (op === "d1.query" || op === "d1.exec" || op === "d1.batch") {
    const path = __sbD1Path(String(msg.db));
    if (op === "d1.exec") {
      // exec() takes a script; a single prepare would run only its first
      // statement and quietly drop the rest.
      const reply = JSON.parse(__sbSqlScriptRaw(path, String(msg.sql)));
      if (reply.ok === false) throw new Error("sqlite: " + reply.error);
      return { ok: true };
    }
    if (op === "d1.batch") {
      const results = [];
      const list = msg.statements || [];
      for (let i = 0; i < list.length; i++) results.push(__sbD1Run(path, list[i].sql, list[i].params));
      return { ok: true, results };
    }
    const one = __sbD1Run(path, msg.sql, msg.params);
    return { ok: true, results: one.results, meta: one.meta, success: true };
  }

  if (op === "r2.put") {
    const body = String(msg.body == null ? "" : msg.body);
    const etag = __sbHex(16);
    __sbSql(
      store,
      "INSERT INTO r2 (bucket, key, body, size, etag, uploaded, http_json, custom_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) " +
        "ON CONFLICT (bucket, key) DO UPDATE SET body=?3, size=?4, etag=?5, uploaded=?6, http_json=?7, custom_json=?8",
      [
        msg.bucket,
        msg.key,
        body,
        body.length,
        etag,
        new Date().toISOString(),
        JSON.stringify(msg.httpMetadata || {}),
        JSON.stringify(msg.customMetadata || {}),
      ],
    );
    return {
      ok: true,
      object: { key: msg.key, size: body.length, etag, uploaded: new Date().toISOString() },
    };
  }
  if (op === "r2.get" || op === "r2.head") {
    // head must not select `body`: reading an 8 MB blob only to drop it costs
    // the read, the text conversion, and a full JSON escape of the row.
    const wantsBody = op === "r2.get";
    const r = __sbSql(
      store,
      wantsBody
        ? "SELECT body, size, etag, uploaded, http_json, custom_json FROM r2 WHERE bucket = ? AND key = ?"
        : "SELECT '', size, etag, uploaded, http_json, custom_json FROM r2 WHERE bucket = ? AND key = ?",
      [msg.bucket, msg.key],
    );
    if (!r.rows.length) return { ok: true, found: false };
    const row = r.rows[0];
    // Shape must match the broker's exactly: the shim reads `r.object`.
    return {
      ok: true,
      found: true,
      object: {
        key: msg.key,
        size: Number(row[1]),
        etag: row[2],
        uploaded: row[3],
        httpMetadata: JSON.parse(row[4] || "{}"),
        customMetadata: JSON.parse(row[5] || "{}"),
      },
      body: wantsBody ? row[0] : undefined,
    };
  }
  if (op === "r2.delete") {
    __sbSql(store, "DELETE FROM r2 WHERE bucket = ? AND key = ?", [msg.bucket, msg.key]);
    return { ok: true };
  }
  if (op === "r2.list") {
    const r = __sbSql(
      store,
      "SELECT key, size, etag, uploaded FROM r2 WHERE bucket = ? AND key LIKE ? || '%' ORDER BY key",
      [msg.bucket, msg.prefix || ""],
    );
    const objects = [];
    for (let i = 0; i < r.rows.length; i++) {
      objects.push({
        key: r.rows[i][0],
        size: Number(r.rows[i][1]),
        etag: r.rows[i][2],
        uploaded: r.rows[i][3],
        httpMetadata: {},
        customMetadata: {},
      });
    }
    return { ok: true, objects };
  }

  if (op === "queue.send" || op === "queue.send_batch") {
    const items = op === "queue.send" ? [msg.body] : msg.messages || [];
    for (let i = 0; i < items.length; i++) {
      __sbSql(store, "INSERT INTO mq (queue, id, body, visible_at, attempts, dead) VALUES (?1,?2,?3,?4,0,0)", [
        msg.queue,
        __sbHex(12),
        String(items[i]),
        Date.now(),
      ]);
    }
    return { ok: true };
  }

  if (op === "do.storage.get") {
    const r = __sbSql(store, "SELECT value FROM do_storage WHERE cls = ? AND id = ? AND key = ?", [
      msg.cls,
      msg.id,
      msg.key,
    ]);
    return r.rows.length ? { ok: true, found: true, value: r.rows[0][0] } : { ok: true, found: false };
  }
  if (op === "do.storage.put") {
    __sbSql(
      store,
      "INSERT INTO do_storage (cls, id, key, value) VALUES (?1,?2,?3,?4) ON CONFLICT (cls, id, key) DO UPDATE SET value = ?4",
      [msg.cls, msg.id, msg.key, msg.value],
    );
    return { ok: true };
  }
  if (op === "do.storage.delete") {
    const r = __sbSql(store, "DELETE FROM do_storage WHERE cls = ? AND id = ? AND key = ?", [msg.cls, msg.id, msg.key]);
    return { ok: true, deleted: r.changes > 0 };
  }
  if (op === "do.storage.delete_all") {
    __sbSql(store, "DELETE FROM do_storage WHERE cls = ? AND id = ?", [msg.cls, msg.id]);
    return { ok: true };
  }
  if (op === "do.storage.list") {
    const r = __sbSql(
      store,
      // Same clamp as the broker: an unbounded list builds the whole result in
      // memory before the caller sees any of it.
      "SELECT key, value FROM do_storage WHERE cls = ? AND id = ? AND key LIKE ? || '%' ORDER BY key LIMIT ?",
      [msg.cls, msg.id, msg.prefix || "", Math.min(Math.max(Number(msg.limit) || 1000, 1), 10000)],
    );
    const entries = [];
    for (let i = 0; i < r.rows.length; i++) entries.push([r.rows[i][0], r.rows[i][1]]);
    return { ok: true, entries };
  }
  if (op === "do.alarm.set") {
    __sbSql(
      store,
      "INSERT INTO do_alarm (cls, id, at, attempts) VALUES (?1,?2,?3,0) ON CONFLICT (cls, id) DO UPDATE SET at = ?3, attempts = 0",
      [msg.cls, msg.id, Math.trunc(Number(msg.at) || 0)],
    );
    return { ok: true };
  }
  if (op === "do.alarm.get") {
    const r = __sbSql(store, "SELECT at FROM do_alarm WHERE cls = ? AND id = ?", [msg.cls, msg.id]);
    return { ok: true, at: r.rows.length ? Number(r.rows[0][0]) : null };
  }
  if (op === "do.alarm.delete") {
    const r = __sbSql(store, "DELETE FROM do_alarm WHERE cls = ? AND id = ?", [msg.cls, msg.id]);
    return { ok: true, deleted: r.changes > 0 };
  }

  if (op === "ae.write") {
    __sbSql(store, "INSERT INTO ae (dataset, ts, indexes_json, blobs_json, doubles_json) VALUES (?1,?2,?3,?4,?5)", [
      msg.dataset,
      Date.now(),
      JSON.stringify(msg.indexes || []),
      JSON.stringify(msg.blobs || []),
      JSON.stringify(msg.doubles || []),
    ]);
    return { ok: true };
  }
  if (op === "ae.query") {
    // Reply must match the broker's: { count, rows: [{timestamp, indexes, blobs, doubles}] }.
    const limit = Math.min(Math.max(Number(msg.limit) || 20, 1), 200);
    const r = __sbSql(
      store,
      "SELECT ts, indexes_json, blobs_json, doubles_json FROM ae WHERE dataset = ? ORDER BY ts DESC, rowid DESC LIMIT ?",
      [msg.dataset, limit],
    );
    const total = __sbSql(store, "SELECT count(*) FROM ae WHERE dataset = ?", [msg.dataset]);
    const rows = [];
    for (let i = 0; i < r.rows.length; i++) {
      rows.push({
        timestamp: Number(r.rows[i][0]),
        indexes: JSON.parse(r.rows[i][1]),
        blobs: JSON.parse(r.rows[i][2]),
        doubles: JSON.parse(r.rows[i][3]),
      });
    }
    return { ok: true, count: total.rows.length ? Number(total.rows[0][0]) : 0, rows };
  }

  throw new Error("unknown op: " + op);
}

/** One D1 statement, shaped like the broker's d1Run. */
function __sbD1Run(path, sql, params) {
  const r = __sbSql(path, String(sql), params || []);
  const results = [];
  for (let i = 0; i < r.rows.length; i++) {
    const row = {};
    for (let c = 0; c < r.cols.length; c++) row[r.cols[c]] = r.rows[i][c];
    results.push(row);
  }
  return { results, meta: { changes: r.changes, last_row_id: r.rowid, rows_read: r.rows.length } };
}

/**
 * R2 object bodies, out of band (#56).
 *
 * The core shim calls these instead of putting an object body in a frame. The
 * broker transport defines the same two names in terms of __sbRpc, so the shim
 * itself does not know which backend it is on.
 */
globalThis.__sbR2Put = function (bucket, key, body, httpMetadata, customMetadata) {
  __sbEnsureSchema();
  const reply = JSON.parse(
    __sbR2PutRaw(
      __sbStore(),
      String(bucket),
      String(key),
      body == null ? "" : String(body),
      JSON.stringify(httpMetadata || {}),
      JSON.stringify(customMetadata || {}),
    ),
  );
  if (reply.ok === false) throw new Error("sproutboat r2.put: " + reply.error);
  return { object: { key: String(key), size: reply.size, etag: reply.etag, uploaded: reply.uploaded } };
};

globalThis.__sbR2Get = function (bucket, key) {
  // Metadata through the normal path (small), bytes through their own.
  const meta = __sbEmbeddedDispatch({ op: "r2.head", bucket, key });
  if (!meta.found) return { found: false };
  return { found: true, object: meta.object, body: __sbR2GetRaw(__sbStore(), String(bucket), String(key)) };
};

globalThis.__sbAssetsGet = function (path) {
  return __sbEmbeddedDispatch({ op: "assets.get", path });
};

/** The transport contract: one request string in, one reply string out. */
function __sbCall(reqJson) {
  try {
    return JSON.stringify(__sbEmbeddedDispatch(JSON.parse(reqJson)));
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}

// --- local triggers ---------------------------------------------------------
// A deployed sprout is driven by the broker: it POSTs x-sb-trigger for cron
// ticks, queue batches and DO alarms. An embedded binary has no broker, so the
// same work runs on timers in this process and calls the handler directly.
// Porffor's native-fetch runtime provides setInterval, so this needs no C.

/** 5-field cron match (min hour dom month dow, UTC) — the same rules broker.ts applies. */
function __sbCronMatches(expr, when) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const fields = [
    when.getUTCMinutes(),
    when.getUTCHours(),
    when.getUTCDate(),
    when.getUTCMonth() + 1,
    when.getUTCDay(),
  ];
  for (let i = 0; i < 5; i++) {
    const spec = parts[i];
    const value = fields[i];
    const tokens = spec.split(",");
    let hit = false;
    for (let t = 0; t < tokens.length; t++) {
      const token = tokens[t];
      if (token === "*") {
        hit = true;
        break;
      }
      if (token.indexOf("*/") === 0) {
        const step = Number(token.slice(2));
        if (step && value % step === 0) {
          hit = true;
          break;
        }
        continue;
      }
      const range = token.split("-");
      if (range.length === 2) {
        if (value >= Number(range[0]) && value <= Number(range[1])) {
          hit = true;
          break;
        }
        continue;
      }
      if (Number(token) === value) {
        hit = true;
        break;
      }
    }
    if (!hit) return false;
  }
  return true;
}

var __sbLastCronTick = "";

/**
 * Start the timers an embedded binary needs. Called from the generated module
 * once the handler object exists; the broker transport defines a no-op of the
 * same name, so the generated code is identical either way.
 */
globalThis.__sbStartLocalTriggers = function (handlers, bindings) {
  const crons = bindings.crons || [];
  const queues = bindings.queues || [];
  const dos = bindings.do || [];
  const store = __sbStore();

  if (crons.length > 0 && __sbIsFn(handlers.scheduled)) {
    setInterval(function () {
      const now = new Date();
      const stamp =
        now.getUTCFullYear() +
        "-" +
        now.getUTCMonth() +
        "-" +
        now.getUTCDate() +
        "-" +
        now.getUTCHours() +
        "-" +
        now.getUTCMinutes();
      if (stamp === __sbLastCronTick) return; // once a minute, like the broker
      __sbLastCronTick = stamp;
      for (let i = 0; i < crons.length; i++) {
        if (__sbCronMatches(crons[i], now)) {
          handlers.scheduled({ cron: crons[i], scheduledTime: now.getTime(), noRetry() {} });
        }
      }
    }, 15000);
  }

  if (queues.length > 0 && __sbIsFn(handlers.queue)) {
    setInterval(function () {
      __sbEnsureSchema();
      const now = Date.now();
      for (let q = 0; q < queues.length; q++) {
        const name = queues[q];
        const due = __sbSql(
          store,
          "SELECT id, body, attempts FROM mq WHERE queue = ? AND dead = 0 AND visible_at <= ? ORDER BY visible_at LIMIT 10",
          [name, now],
        );
        if (due.rows.length === 0) continue;
        // Hide the batch first, so a slow handler cannot have it delivered twice.
        const messages = [];
        for (let i = 0; i < due.rows.length; i++) {
          const row = due.rows[i];
          __sbSql(store, "UPDATE mq SET visible_at = ? WHERE id = ?", [now + 30000, row[0]]);
          messages.push({ id: row[0], body: row[1], timestamp: now, attempts: Number(row[2]) + 1 });
        }
        const result = __sbRunQueueBatch(handlers, { queue: name, messages });
        for (let i = 0; i < result.ack.length; i++) {
          __sbSql(store, "DELETE FROM mq WHERE id = ?", [result.ack[i]]);
        }
        for (let i = 0; i < result.retry.length; i++) {
          __sbSql(
            store,
            "UPDATE mq SET attempts = attempts + 1, visible_at = ?, dead = CASE WHEN attempts + 1 >= 5 THEN 1 ELSE 0 END WHERE id = ?",
            [Date.now() + 5000, result.retry[i]],
          );
        }
      }
    }, 500);
  }

  if (dos.length > 0) {
    setInterval(function () {
      __sbEnsureSchema();
      const now = Date.now();
      const due = __sbSql(store, "SELECT cls, id, at, attempts FROM do_alarm WHERE at <= ? ORDER BY at LIMIT 10", [
        now,
      ]);
      for (let i = 0; i < due.rows.length; i++) {
        const cls = due.rows[i][0];
        const id = due.rows[i][1];
        // Claim before running: alarm() may schedule the next one, and deleting
        // afterwards would erase it. Same rule as the broker (#125).
        __sbSql(store, "DELETE FROM do_alarm WHERE cls = ? AND id = ?", [cls, id]);
        const instance = __sbGetDOInstance(cls, id);
        if (__sbIsFn(instance.alarm)) instance.alarm();
      }
    }, 500);
  }
};
