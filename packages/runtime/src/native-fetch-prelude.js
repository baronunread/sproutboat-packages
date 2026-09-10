// Prepended to every handler by tools/compile.ts, before Porffor's native-fetch
// esbuild bundle. Porffor's runtime/fetch-globals.js (checked through alpha-4)
// gives URL (href/origin/pathname/search only) and Response without a static
// json(). This adds, additively, the rest of the WHATWG surface Worker code
// expects: URLSearchParams (read + write), URL.prototype.searchParams and the
// protocol/host/hostname/port/hash accessors, static Response.json,
// crypto.randomUUID / crypto.getRandomValues, and structuredClone. Each is
// feature-detected; delete a block once Porffor ships that global.
// Tracked upstream in patches/UPSTREAM.md.
//
// Declared before it is referenced: a getter body that names a later top-level
// class throws ReferenceError in Porffor (see patches/UPSTREAM.md draft B).

// Duck-typing helpers, `typeof`-free (the repo's anti-slop lint bans `typeof`;
// these express the same spec-mandated checks and are verified under Porffor
// alpha-4 by examples/kitchen-sink/harness.ts).
function __sbIsStr(v) {
  return Object(v) !== v && v === String(v);
}
function __sbIsFn(v) {
  return v instanceof Function;
}
function __sbIsObj(v) {
  return v !== null && Object(v) === v;
}

// #41 — cold-start phase marker. Runs as the first thing in the bundle: writes
// the current wall-clock ms to $SB_STARTUP_FILE so the supervisor can split
// cold-start into "spawn -> JS starts" (process + runtime bootstrap) and
// "JS starts -> listening" (module eval + server bind). No-op when unset.
function __sbStartupMark() {
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __f = getenv("SB_STARTUP_FILE");
    if (__f) {
      struct timespec __ts;
      clock_gettime(CLOCK_REALTIME, &__ts);
      double __ms = (double)__ts.tv_sec * 1000.0 + (double)__ts.tv_nsec / 1000000.0;
      char __buf[32];
      int __n = snprintf(__buf, sizeof(__buf), "%.0f", __ms);
      int __fd = open(__f, O_WRONLY | O_CREAT | O_TRUNC, 0600);
      if (__fd >= 0) { write(__fd, __buf, (size_t)__n); close(__fd); }
    }
  `;
}
__sbStartupMark();

// #28 — process CPU time in ms (CLOCK_PROCESS_CPUTIME_ID). Marshalled back as a
// string via the same primitives as __sbEnv / __sbRandomBytes (proven working),
// then parsed — Porffor's number boxing for a bare inline-C assignment is not
// relied on. `__sbEntry` samples it around the handler for per-invocation CPU.
function __sbCpuMs() {
  let res = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    struct timespec __ts;
    clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &__ts);
    double __ms = (double)__ts.tv_sec * 1000.0 + (double)__ts.tv_nsec / 1000000.0;
    char __b[32];
    int __n = snprintf(__b, sizeof(__b), "%.3f", __ms);
    if (__n > 0) res = porf_box((f64)porf_native_fetch_alloc_bytestring(__b, (size_t)__n), 195);
  `;
  return res === "" ? 0 : parseFloat(res);
}

// #28 — stamp `x-sb-cpu-ms` onto a handler Response. Porffor alpha-4's
// native-fetch serializer only reads headers from the plain object passed to
// `new Response(body, { headers })` — a later `.set()` or a `Headers` instance
// is ignored on the wire — so the metric is carried by rebuilding the Response
// with one extra header. Safe only for a string body (the norm under
// http-sync-v0) with no Set-Cookie to comma-fold; anything else is returned
// untouched and the edge simply omits cpuMs for that request.
function __sbTagCpu(res, t0) {
  const cpu = __sbCpuMs() - t0;
  try {
    const body = res && res.body;
    if (__sbIsStr(body) && !res.headers.has("set-cookie")) {
      const headers = {};
      res.headers.forEach(function (value, name) {
        headers[name] = value;
      });
      headers["x-sb-cpu-ms"] = (cpu >= 0 ? cpu : 0).toFixed(3);
      return new Response(body, { status: res.status, headers: headers });
    }
  } catch {
    /* fall through to the original response */
  }
  return res;
}

class __SproutboatURLSearchParams {
  constructor(init) {
    this._keys = [];
    this._vals = [];
    let raw = init == null ? "" : String(init);
    if (raw.charCodeAt(0) === 63) raw = raw.slice(1); // strip a leading '?'
    if (raw.length === 0) return;
    const pairs = raw.split("&");
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      if (pair.length === 0) continue;
      const eq = pair.indexOf("=");
      const k = eq === -1 ? pair : pair.slice(0, eq);
      const v = eq === -1 ? "" : pair.slice(eq + 1);
      this._keys.push(decodeURIComponent(k.split("+").join(" ")));
      this._vals.push(decodeURIComponent(v.split("+").join(" ")));
    }
  }
  get(name) {
    for (let i = 0; i < this._keys.length; i++) if (this._keys[i] === name) return this._vals[i];
    return null;
  }
  getAll(name) {
    const out = [];
    for (let i = 0; i < this._keys.length; i++) if (this._keys[i] === name) out.push(this._vals[i]);
    return out;
  }
  has(name) {
    for (let i = 0; i < this._keys.length; i++) if (this._keys[i] === name) return true;
    return false;
  }
  forEach(cb) {
    for (let i = 0; i < this._keys.length; i++) cb(this._vals[i], this._keys[i], this);
  }
  // Mutators: standalone `new URLSearchParams()` building works. They do NOT
  // write back into a URL's `search` (Porffor's URL has no setter) — build the
  // string with toString() and assign it yourself.
  append(name, value) {
    this._keys.push(String(name));
    this._vals.push(String(value));
  }
  set(name, value) {
    let found = false;
    for (let i = 0; i < this._keys.length; i++) {
      if (this._keys[i] !== name) continue;
      if (found) {
        this._keys.splice(i, 1);
        this._vals.splice(i, 1);
        i--;
      } else {
        this._vals[i] = String(value);
        found = true;
      }
    }
    if (!found) this.append(name, value);
  }
  delete(name) {
    for (let i = 0; i < this._keys.length; i++)
      if (this._keys[i] === name) {
        this._keys.splice(i, 1);
        this._vals.splice(i, 1);
        i--;
      }
  }
  sort() {
    const idx = this._keys
      .map((_, i) => i)
      .sort((a, b) => (this._keys[a] < this._keys[b] ? -1 : this._keys[a] > this._keys[b] ? 1 : 0));
    this._keys = idx.map((i) => this._keys[i]);
    this._vals = idx.map((i) => this._vals[i]);
  }
  keys() {
    return this._keys.slice();
  }
  values() {
    return this._vals.slice();
  }
  get size() {
    return this._keys.length;
  }
  toString() {
    let out = "";
    for (let i = 0; i < this._keys.length; i++) {
      if (i > 0) out += "&";
      out += encodeURIComponent(this._keys[i]) + "=" + encodeURIComponent(this._vals[i]);
    }
    return out;
  }
}

// URL and Response are always defined by Porffor's fetch-globals.js banner.
if (globalThis.URLSearchParams == null) globalThis.URLSearchParams = __SproutboatURLSearchParams;

if (!("searchParams" in URL.prototype)) {
  Object.defineProperty(URL.prototype, "searchParams", {
    configurable: true,
    get() {
      if (this.__sbSearchParams == null) this.__sbSearchParams = new __SproutboatURLSearchParams(this.search);
      return this.__sbSearchParams;
    },
  });
}

if (Response.json == null) {
  Response.json = function (data, init) {
    const response = new Response(JSON.stringify(data), init);
    if (!response.headers.has("content-type")) response.headers.set("content-type", "application/json;charset=utf-8");
    return response;
  };
}

// Porffor's URL exposes href / origin / pathname / search only. Add the rest of
// the WHATWG read surface, derived from `origin` (scheme://host[:port]).
// `hash` is always '' server-side — browsers strip the fragment before the
// request, so there is nothing to recover. Tracked upstream (patches/UPSTREAM.md).
function __sbDefineURLAccessor(name, get) {
  if (!(name in URL.prototype)) Object.defineProperty(URL.prototype, name, { configurable: true, get });
}
__sbDefineURLAccessor("protocol", function () {
  const i = this.origin.indexOf("://");
  return i === -1 ? "" : this.origin.slice(0, i + 1);
});
__sbDefineURLAccessor("host", function () {
  const i = this.origin.indexOf("://");
  return i === -1 ? "" : this.origin.slice(i + 3);
});
__sbDefineURLAccessor("hostname", function () {
  const h = this.host;
  const c = h.indexOf(":");
  return c === -1 ? h : h.slice(0, c);
});
__sbDefineURLAccessor("port", function () {
  const h = this.host;
  const c = h.indexOf(":");
  return c === -1 ? "" : h.slice(c + 1);
});
__sbDefineURLAccessor("hash", function () {
  return "";
});
__sbDefineURLAccessor("username", function () {
  return "";
});
__sbDefineURLAccessor("password", function () {
  return "";
});

// crypto.randomUUID / getRandomValues are absent in native-fetch. Provide them
// backed by the OS CSPRNG (`__sbRandomBytes` -> inline C -> /dev/urandom), so
// tokens, idempotency keys and UUIDs are unpredictable. Deliberately no insecure
// fallback — a silent downgrade to a weak source is worse than throwing.
if (globalThis.crypto == null) globalThis.crypto = {};
if (globalThis.crypto.getRandomValues == null) {
  globalThis.crypto.getRandomValues = function (view) {
    const n = view.length >>> 0;
    // WebCrypto caps a single call at 65536 bytes.
    if (n > 65536) throw new RangeError("crypto.getRandomValues: byte length exceeds 65536");
    if (n === 0) return view;
    // One CSPRNG byte per element. Correct for Uint8Array (and randomUUID); a
    // wider view gets its low byte filled, matching the previous polyfill's shape.
    const bytes = __sbRandomBytes(String(n));
    if (bytes.length !== n) throw new Error("crypto.getRandomValues: OS entropy source unavailable");
    for (let i = 0; i < n; i++) view[i] = bytes.charCodeAt(i) & 0xff;
    return view;
  };
}
// structuredClone: JSON round-trip. Lossy (no Map/Set/Date/typed arrays), but
// covers the common "deep-copy a plain object" case Worker code relies on.
if (globalThis.structuredClone == null) {
  // The suggested fix (use structuredClone) is circular — this IS the polyfill,
  // and Porffor exposes no other deep-clone primitive.
  // react-doctor-disable-next-line react-doctor/no-json-parse-stringify-clone
  globalThis.structuredClone = function (value) {
    return JSON.parse(JSON.stringify(value));
  };
}

if (globalThis.crypto.randomUUID == null) {
  globalThis.crypto.randomUUID = function () {
    const b = new Uint8Array(16);
    globalThis.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [];
    for (let i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
    return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
  };
}

// ---------------------------------------------------------------------------
// Bindings: env.<KV>, env.<SECRET>, env.<D1>, env.<R2>, and globalThis.fetch,
// backed by a Bun broker on a loopback TCP port. The transport is inline C —
// blocking write/read per call over ONE long-lived connection (http-sync-v0: one
// sprout event-loop turn per request, so a blocking roundtrip is acceptable).
// Wire frame:
//   [u32 LE len][ <token> "\n" <json> ]   reply: [u32 LE len][ <json> ]
// Shared C preamble: the headers, the two Porffor marshalling helpers every
// inline-C block uses, and the CSPRNG. Lives here rather than in a transport so
// both transports — and __sbRandomBytes / __sbEnv below — compile against the
// same declarations.
// oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
Porffor.c`
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <signal.h>
#include <unistd.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <fcntl.h>
#include <errno.h>
#include <time.h>

u32 porf_native_fetch_alloc_bytestring(const char* input, size_t len);
int porf_native_fetch_read_value(jsval value, const char** out_buf, size_t* out_len, char** out_owned);

// Fill buf with n bytes from the OS CSPRNG. /dev/urandom is present on Linux and
// macOS and inside the bubblewrap sandbox; blocking is not a concern after the
// pool is seeded. Returns 0, or -1 if the source could not be read in full.
static int sb_os_random(unsigned char* buf, size_t n) {
  int fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  size_t off = 0;
  while (off < n) {
    long r = read(fd, buf + off, n - off);
    if (r <= 0) {
      if (r < 0 && errno == EINTR) continue;
      close(fd);
      return -1;
    }
    off += (size_t)r;
  }
  close(fd);
  return 0;
}

`;

// TRANSPORT: wrap.ts splices one of transport-broker.js / transport-embedded.js here.

// `nStr` is the decimal byte count as a string (same string-param pattern as
// __sbEnv). Returns a bytestring of that many CSPRNG bytes, or '' on failure.
// oxlint-disable-next-line no-unused-vars -- `nStr` is read inside the RawC block below, not by JS.
function __sbRandomBytes(nStr) {
  let out = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __ns; size_t __nsl; char* __nso = 0;
    porf_native_fetch_read_value(nStr, &__ns, &__nsl, &__nso);
    char __nb[16];
    size_t __k = __nsl < 15 ? __nsl : 15;
    memcpy(__nb, __ns, __k); __nb[__k] = 0;
    if (__nso) free(__nso);
    long __n = atol(__nb);
    if (__n > 0 && __n <= 65536) {
      unsigned char* __b = (unsigned char*)malloc((size_t)__n);
      if (__b) {
        if (sb_os_random(__b, (size_t)__n) == 0)
          out = porf_box((f64)porf_native_fetch_alloc_bytestring((const char*)__b, (size_t)__n), 195);
        free(__b);
      }
    }
  `;
  return out;
}

// #63 — every request carries the protocol version it was built against and an
// id unique to this process. The id is what makes a resend safe: the transport
// retries the *same bytes*, so a broker that already applied the request can
// recognise it and replay its answer instead of applying it twice.
var __sbReqId = 0;

function __sbRpc(op, extra) {
  const req = { v: 1, id: ++__sbReqId, op };
  if (extra) for (const k in extra) req[k] = extra[k];
  const reply = JSON.parse(__sbCall(JSON.stringify(req)));
  if (reply && reply.ok === false) throw new Error(`sproutboat ${op}: ${reply.error || "failed"}`);
  return reply;
}

// D1: a Cloudflare-shaped `env.<DB>` (prepare / bind / all / run / raw / first,
// plus batch and exec). Every call is one broker roundtrip.
function __sbMakeD1(dbName) {
  function stmt(sql, params) {
    const s = {
      __sql: sql,
      __params: params,
      bind() {
        return stmt(sql, Array.prototype.slice.call(arguments));
      },
      all() {
        const r = __sbRpc("d1.query", { db: dbName, sql, params });
        return { results: r.results || [], success: true, meta: r.meta || {} };
      },
      run() {
        return s.all();
      },
      raw() {
        const rows = s.all().results;
        const out = [];
        for (let i = 0; i < rows.length; i++) {
          const cols = [];
          for (const k in rows[i]) cols.push(rows[i][k]);
          out.push(cols);
        }
        return out;
      },
      first(column) {
        const rows = s.all().results;
        if (rows.length === 0) return null;
        return column == null ? rows[0] : rows[0][column];
      },
    };
    return s;
  }
  return {
    prepare(sql) {
      return stmt(String(sql), []);
    },
    batch(statements) {
      const list = [];
      for (let i = 0; i < (statements || []).length; i++)
        list.push({ sql: statements[i].__sql, params: statements[i].__params });
      const r = __sbRpc("d1.batch", { db: dbName, statements: list });
      const out = [];
      for (let i = 0; i < (r.results || []).length; i++)
        out.push({ results: r.results[i].results || [], success: true, meta: r.results[i].meta || {} });
      return out;
    },
    exec(sql) {
      __sbRpc("d1.exec", { db: dbName, sql: String(sql) });
      return { count: (String(sql).match(/;/g) || []).length, duration: 0 };
    },
  };
}

// R2: a Cloudflare-shaped object. When `body` is present the sync accessors
// mirror R2ObjectBody's async ones (a sprout may `await` them harmlessly).
function __sbR2Object(meta, body) {
  const obj = {
    key: meta.key,
    size: meta.size,
    etag: meta.etag,
    httpEtag: '"' + meta.etag + '"',
    uploaded: meta.uploaded,
    httpMetadata: meta.httpMetadata || {},
    customMetadata: meta.customMetadata || {},
  };
  if (body != null) {
    obj.body = body;
    obj.text = function () {
      return body;
    };
    obj.json = function () {
      return JSON.parse(body);
    };
  }
  return obj;
}

// Installed only when the project declares bindings. `env` is the module-scoped
// object from compile.ts (a `const`, but mutable); we add the binding accessors
// to it in place. compile.ts emits `__sbInstallBindings(env, {...})` right after
// the `const env = {...}` line.
globalThis.__sbInstallBindings = function (target, bindings) {
  if (!target) return;

  for (let i = 0; i < (bindings.kv || []).length; i++) {
    const ns = bindings.kv[i];
    target[ns] = {
      get(key) {
        const r = __sbRpc("kv.get", { ns, key: String(key) });
        return r.found ? r.value : null;
      },
      put(key, value) {
        __sbRpc("kv.put", { ns, key: String(key), value: String(value) });
      },
      delete(key) {
        __sbRpc("kv.delete", { ns, key: String(key) });
      },
      list(prefix) {
        return __sbRpc("kv.list", { ns, prefix: prefix == null ? "" : String(prefix) }).keys || [];
      },
    };
  }

  for (let i = 0; i < (bindings.secrets || []).length; i++) {
    const name = bindings.secrets[i];
    // Fetch lazily, then freeze as a data property: a secret is process-lifetime
    // immutable (a new value means a redeploy = a new process), so one broker
    // round-trip on first read, zero after. A getter that RPCs on every access
    // turns `'Bearer ' + env.KEY` in a loop into a syscall storm.
    Object.defineProperty(target, name, {
      configurable: true,
      get() {
        const value = __sbRpc("secret.get", { name }).value;
        Object.defineProperty(target, name, { value, configurable: true, enumerable: true });
        return value;
      },
    });
  }

  for (let i = 0; i < (bindings.d1 || []).length; i++) {
    const name = bindings.d1[i];
    target[name] = __sbMakeD1(name);
  }

  for (let i = 0; i < (bindings.r2 || []).length; i++) {
    const name = bindings.r2[i];
    target[name] = {
      put(key, value, options) {
        const o = options || {};
        // #56 — the body goes out of band where the transport allows it.
        return __sbR2Put(
          name,
          String(key),
          value == null ? "" : String(value),
          o.httpMetadata || {},
          o.customMetadata || {},
        ).object;
      },
      get(key) {
        // #56 — bytes come back out of band on a transport that supports it, so
        // an object body is never JSON-escaped into a frame.
        const r = __sbR2Get(name, String(key));
        return r.found ? __sbR2Object(r.object, r.body == null ? "" : r.body) : null;
      },
      head(key) {
        const r = __sbRpc("r2.head", { bucket: name, key: String(key) });
        return r.found ? __sbR2Object(r.object, null) : null;
      },
      delete(key) {
        __sbRpc("r2.delete", { bucket: name, key: String(key) });
      },
      list(options) {
        const o = options || {};
        const r = __sbRpc("r2.list", {
          bucket: name,
          prefix: o.prefix == null ? "" : String(o.prefix),
          cursor: o.cursor == null ? "" : String(o.cursor),
          limit: o.limit == null ? 1000 : o.limit,
        });
        const objects = [];
        for (let j = 0; j < (r.objects || []).length; j++) objects.push(__sbR2Object(r.objects[j], null));
        return { objects, truncated: !!r.truncated, cursor: r.cursor || undefined };
      },
    };
  }

  for (let i = 0; i < (bindings.queues || []).length; i++) {
    const name = bindings.queues[i];
    target[name] = {
      send(body, options) {
        const o = options || {};
        __sbRpc("queue.send", {
          queue: name,
          body: __sbIsStr(body) ? body : JSON.stringify(body),
          delaySeconds: o.delaySeconds || 0,
        });
      },
      sendBatch(messages) {
        const list = [];
        for (let j = 0; j < (messages || []).length; j++) {
          const m = messages[j];
          list.push({ body: __sbIsStr(m.body) ? m.body : JSON.stringify(m.body), delaySeconds: m.delaySeconds || 0 });
        }
        __sbRpc("queue.send_batch", { queue: name, messages: list });
      },
    };
  }

  for (let i = 0; i < (bindings.analytics || []).length; i++) {
    const name = bindings.analytics[i];
    target[name] = {
      writeDataPoint(event) {
        const e = event || {};
        __sbRpc("ae.write", {
          dataset: name,
          indexes: e.indexes || [],
          blobs: e.blobs || [],
          doubles: e.doubles || [],
        });
      },
      // Sproutboat extension (Cloudflare AE is write-only from a Worker — you
      // query it via the SQL API). Returns { count, rows }.
      query(options) {
        const o = options || {};
        return __sbRpc("ae.query", { dataset: name, limit: o.limit || 20 });
      },
    };
  }

  for (let i = 0; i < (bindings.do || []).length; i++) {
    const b = bindings.do[i];
    target[b.binding] = __sbMakeDONamespace(b.binding, b.className);
  }

  // Static assets: env.<ASSETS>.fetch(request) -> broker `assets.get`. The edge
  // already serves matching files directly; the sprout only calls this for paths
  // it wants to own (SPA fallback, auth-gated files). The transport keeps the
  // body byte-preserving for binary assets.
  if (bindings.assets) {
    target[bindings.assets] = {
      fetch(input) {
        let path = __sbIsStr(input) ? input : String((input && input.url) || "/");
        try {
          path = new URL(path, "http://a").pathname;
        } catch {
          /* use as-is */
        }
        const r = globalThis.__sbAssetsGet(path);
        const headers = {};
        if (r.type) headers["content-type"] = r.type;
        if (r.found) headers["etag"] = '"' + r.hash + '"';
        return new Response(r.body == null ? "" : r.body, { status: r.status || (r.found ? 200 : 404), headers });
      },
    };
  }

  // #48 — worker-to-worker. Same wire shape as outbound fetch, but the broker
  // resolves the target itself and forwards it internally, so this is not
  // egress and is not subject to the outbound allowlist.
  for (let i = 0; i < (bindings.services || []).length; i++) {
    const binding = bindings.services[i].binding;
    target[binding] = {
      fetch(input, init) {
        const url = __sbIsStr(input) ? input : String((input && input.url) || "https://service/");
        const opts = init || (!__sbIsStr(input) && input) || {};
        const headers = [];
        if (opts.headers) {
          if (__sbIsFn(opts.headers.forEach)) opts.headers.forEach((v, k) => headers.push([k, v]));
          else for (const k in opts.headers) headers.push([k, opts.headers[k]]);
        }
        const r = __sbRpc("service.fetch", {
          binding,
          url,
          method: opts.method || "GET",
          headers,
          body: opts.body == null ? null : String(opts.body),
        });
        const respHeaders = new Headers();
        for (let j = 0; j < (r.headers || []).length; j++) respHeaders.set(r.headers[j][0], r.headers[j][1]);
        return new Response(r.body == null ? "" : r.body, { status: r.status || 502, headers: respHeaders });
      },
    };
  }

  if ((bindings.outbound || []).length > 0) {
    globalThis.fetch = function (input, init) {
      const url = __sbIsStr(input) ? input : String(input.url);
      const opts = init || {};
      const headers = [];
      if (opts.headers) {
        if (__sbIsFn(opts.headers.forEach)) opts.headers.forEach((v, k) => headers.push([k, v]));
        else for (const k in opts.headers) headers.push([k, opts.headers[k]]);
      }
      const r = __sbRpc("fetch", {
        url,
        method: opts.method || "GET",
        headers,
        body: opts.body == null ? null : String(opts.body),
      });
      const respHeaders = new Headers();
      for (let j = 0; j < (r.headers || []).length; j++) respHeaders.set(r.headers[j][0], r.headers[j][1]);
      return new Response(r.body == null ? "" : r.body, { status: r.status || 502, headers: respHeaders });
    };
  }
};

// ---------------------------------------------------------------------------
// Durable Objects. The class runs here in the sandboxed sprout. There is exactly
// one sprout process per deployment (the supervisor model) and the native-fetch
// runtime processes one turn at a time, so calls to a given object id are
// already serialized — `env.<NS>.get(id).fetch()` invokes the instance directly,
// no round-trip. Only `state.storage.*` goes to the broker (so object state
// outlives a sprout restart), scoped to (class, id).
// ponytail: serialization relies on the single sprout process; a multi-sprout
// deployment needs the broker to hold a per-id lock (cloud). Storage ops are one
// key at a time; blockConcurrencyWhile just runs the fn.

function __sbMakeDONamespace(binding, className) {
  return {
    idFromName(name) {
      return {
        toString() {
          return "name:" + String(name);
        },
        name: String(name),
      };
    },
    idFromString(hex) {
      return {
        toString() {
          return String(hex);
        },
      };
    },
    newUniqueId() {
      return {
        toString() {
          return "uid:" + crypto.randomUUID();
        },
      };
    },
    get(id) {
      const idStr = __sbIsStr(id) ? id : id.toString();
      return {
        fetch(input, init) {
          let req;
          if (__sbIsObj(input) && __sbIsStr(input.url) && !init) {
            req = input;
          } else {
            const url = __sbIsStr(input) ? input : String((input && input.url) || "https://do/");
            const opts = init || {};
            const headers = new Headers();
            if (opts.headers) {
              if (__sbIsFn(opts.headers.forEach)) opts.headers.forEach((v, k) => headers.set(k, v));
              else for (const k in opts.headers) headers.set(k, opts.headers[k]);
            }
            req = new Request(url, { method: opts.method || "GET", headers });
            if (opts.body != null) req.body = String(opts.body);
          }
          return __sbGetDOInstance(className, idStr).fetch(req);
        },
      };
    },
  };
}

const __sbDOClasses = {};
const __sbDOInstances = {};
globalThis.__sbRegisterDO = function (map) {
  for (const k in map) __sbDOClasses[k] = map[k];
};

function __sbGetDOInstance(cls, id) {
  const Ctor = __sbDOClasses[cls];
  if (!Ctor) throw new Error("no such Durable Object class: " + cls);
  const cacheKey = cls + " " + id;
  let inst = __sbDOInstances[cacheKey];
  if (!inst) {
    const state = {
      id: {
        toString() {
          return id;
        },
      },
      storage: __sbDOStorage(cls, id),
      blockConcurrencyWhile(fn) {
        return fn();
      },
      waitUntil() {},
    };
    inst = new Ctor(state, globalThis.env);
    __sbDOInstances[cacheKey] = inst;
  }
  return inst;
}

function __sbDOStorage(cls, id) {
  return {
    get(key) {
      if (Array.isArray(key)) {
        const out = new Map();
        for (let i = 0; i < key.length; i++) {
          const r = __sbRpc("do.storage.get", { cls, id, key: String(key[i]) });
          if (r.found) out.set(key[i], JSON.parse(r.value));
        }
        return out;
      }
      const r = __sbRpc("do.storage.get", { cls, id, key: String(key) });
      return r.found ? JSON.parse(r.value) : undefined;
    },
    put(key, value) {
      if (key != null && __sbIsObj(key)) {
        for (const k in key) __sbRpc("do.storage.put", { cls, id, key: String(k), value: JSON.stringify(key[k]) });
        return;
      }
      __sbRpc("do.storage.put", { cls, id, key: String(key), value: JSON.stringify(value) });
    },
    delete(key) {
      if (Array.isArray(key)) {
        let n = 0;
        for (let i = 0; i < key.length; i++)
          n += __sbRpc("do.storage.delete", { cls, id, key: String(key[i]) }).deleted ? 1 : 0;
        return n;
      }
      return !!__sbRpc("do.storage.delete", { cls, id, key: String(key) }).deleted;
    },
    deleteAll() {
      __sbRpc("do.storage.delete_all", { cls, id });
    },
    // #125 — alarms. Cloudflare takes a Date or epoch ms; at most one is
    // pending per object, so setting one replaces any earlier alarm.
    setAlarm(when) {
      const at = when instanceof Date ? when.getTime() : Number(when);
      __sbRpc("do.alarm.set", { cls, id, at: at });
    },
    getAlarm() {
      const r = __sbRpc("do.alarm.get", { cls, id });
      return r.at == null ? null : r.at;
    },
    deleteAlarm() {
      __sbRpc("do.alarm.delete", { cls, id });
    },
    list(options) {
      const o = options || {};
      const r = __sbRpc("do.storage.list", {
        cls,
        id,
        prefix: o.prefix == null ? "" : String(o.prefix),
        limit: o.limit == null ? 1000 : o.limit,
      });
      const out = new Map();
      for (let i = 0; i < (r.entries || []).length; i++) out.set(r.entries[i][0], JSON.parse(r.entries[i][1]));
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Trigger dispatch. The compiled server only ever calls `fetch(request)`; this
// routes the internal `x-sb-trigger` requests (sent by the broker, authenticated
// with SB_BROKER_TOKEN) to the right user handler, and everything else to
// `handlers.fetch`.

// oxlint-disable-next-line no-unused-vars -- `name` is read inside the RawC block below, not by JS.
function __sbEnv(name) {
  let res = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __n; size_t __nl; char* __no = 0;
    porf_native_fetch_read_value(name, &__n, &__nl, &__no);
    char __key[128];
    size_t __kn = __nl < 127 ? __nl : 127;
    memcpy(__key, __n, __kn); __key[__kn] = 0;
    if (__no) free(__no);
    const char* __v = getenv(__key);
    if (__v) res = porf_box((f64)porf_native_fetch_alloc_bytestring(__v, strlen(__v)), 195);
  `;
  return res;
}

function __sbTriggerAuthed(request) {
  const want = __sbEnv("SB_BROKER_TOKEN");
  // No token configured means no caller can be trusted to send one, so refuse
  // rather than wave the request through. Every path that legitimately delivers
  // a trigger over HTTP sets SB_BROKER_TOKEN — the supervisor per deployment,
  // `sproutboat dev`, the standalone launcher. The one build that has no token
  // is the embedded binary (#15), which fires its own triggers in-process and
  // is also the one most likely to be listening on a public interface: exactly
  // where "anyone may invoke scheduled()" would be a hole.
  if (!want) return false;
  return request.headers.get("x-sb-token") === want;
}

globalThis.__sbEntry = function (handlers, request) {
  const trigger = request.headers.get("x-sb-trigger");
  if (!trigger) {
    // #28 — per-invocation CPU time. One fetch turn per process (serial), so the
    // process CPU delta across the handler is this invocation's CPU.
    // ponytail: serial-turn assumption; revisit if the profile ever allows
    // concurrent in-process requests.
    //
    // Sync handlers only. An async handler's promise is handed straight back:
    // Porffor alpha-4's native-fetch server resolves the promise the handler
    // itself returned, but never one derived from `.then()`, so chaining the
    // tag on hangs the request forever. cpuMs is documented as absent for
    // async handlers (see LogEvent in services/edge) — that is this.
    const __t0 = __sbCpuMs();
    const __res = handlers.fetch(request);
    if (__res && __sbIsFn(__res.then)) return __res;
    return __sbTagCpu(__res, __t0);
  }
  if (!__sbTriggerAuthed(request)) return new Response("forbidden", { status: 403 });

  if (trigger === "scheduled") {
    if (!__sbIsFn(handlers.scheduled)) return new Response("no scheduled handler", { status: 404 });
    const body = __sbReadJson(request);
    handlers.scheduled({ cron: body.cron || "", scheduledTime: body.scheduledTime || Date.now(), noRetry() {} });
    return new Response("", { status: 204 });
  }

  if (trigger === "queue") {
    if (!__sbIsFn(handlers.queue)) return new Response("no queue handler", { status: 404 });
    const result = __sbRunQueueBatch(handlers, __sbReadJson(request));
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
  }

  if (trigger === "alarm") {
    const body = __sbReadJson(request);
    const inst = __sbGetDOInstance(String(body.cls || ""), String(body.id || ""));
    if (!__sbIsFn(inst.alarm)) return new Response("no alarm handler", { status: 404 });
    inst.alarm();
    return new Response("", { status: 204 });
  }

  return new Response("unknown trigger", { status: 400 });
};

/**
 * Run one queue batch through the handler and report what it acked.
 *
 * Shared so the two ways a batch can arrive agree: over HTTP from the broker
 * (deployed, and the phase-0 standalone launcher), or straight from the local
 * timer in an embedded binary that has no broker to be delivered from.
 */
function __sbRunQueueBatch(handlers, body) {
  const acked = [];
  const retried = [];
  const raw = body.messages || [];
  const messages = [];
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i];
    const msg = {
      id: m.id,
      timestamp: m.timestamp,
      attempts: m.attempts || 1,
      body: __sbTryParse(m.body),
      ack() {
        if (acked.indexOf(m.id) === -1) acked.push(m.id);
      },
      retry() {
        if (retried.indexOf(m.id) === -1) retried.push(m.id);
      },
    };
    messages.push(msg);
  }
  const batch = {
    queue: body.queue || "",
    messages,
    ackAll() {
      for (let i = 0; i < messages.length; i++) messages[i].ack();
    },
    retryAll() {
      for (let i = 0; i < messages.length; i++) messages[i].retry();
    },
  };
  handlers.queue(batch);
  // default: any message neither acked nor retried is treated as acked
  for (let i = 0; i < messages.length; i++) {
    if (acked.indexOf(messages[i].id) === -1 && retried.indexOf(messages[i].id) === -1) acked.push(messages[i].id);
  }
  return { ack: acked, retry: retried };
}

function __sbReadJson(request) {
  try {
    return JSON.parse(request.body == null ? "{}" : String(request.body));
  } catch {
    return {};
  }
}
function __sbTryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
