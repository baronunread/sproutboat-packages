// Prepended to every handler by tools/compile.ts, before Porffor's native-fetch
// esbuild bundle. Porffor's runtime/fetch-globals.js (checked through alpha-4)
// gives URL (href/origin/pathname/search only) and Response without a static
// json(). This adds, additively, the rest of the WHATWG surface Worker code
// expects: URLSearchParams (read + write), URL.prototype.searchParams and the
// protocol/host/hostname/port/hash accessors, static Response.json,
// crypto.randomUUID / crypto.getRandomValues, crypto.subtle (digest + HMAC
// sign/verify, #133), structuredClone, and FormData + Request/Response
// formData()/bytes() (#60). Each is feature-detected; delete a block once
// Porffor ships that global. crypto.scryptVerify (#153) is a Sproutboat
// extension, not WHATWG, and stays.
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

// #60 — Porffor's Request/Response give text()/json()/arrayBuffer()/blob()
// synchronously (buffered body, fine under http-sync-v0) but no FormData at
// all. Parses the same buffered body, synchronously, into a FormData-like
// object; url-encoded via the URLSearchParams shim above, multipart by hand
// (RFC 7578: boundary-delimited parts, each a header block then a blank line
// then the part body — one pass, no nested multipart).
if (globalThis.FormData == null) {
  class __SproutboatFormData {
    constructor() {
      this._entries = [];
    }
    append(name, value, filename) {
      this._entries.push([String(name), value, filename]);
    }
    set(name, value, filename) {
      name = String(name);
      let replaced = false;
      this._entries = this._entries.filter((e) => {
        if (e[0] !== name) return true;
        if (replaced) return false;
        e[1] = value;
        e[2] = filename;
        replaced = true;
        return true;
      });
      if (!replaced) this.append(name, value, filename);
    }
    get(name) {
      for (let i = 0; i < this._entries.length; i++) if (this._entries[i][0] === name) return this._entries[i][1];
      return null;
    }
    getAll(name) {
      const out = [];
      for (let i = 0; i < this._entries.length; i++) if (this._entries[i][0] === name) out.push(this._entries[i][1]);
      return out;
    }
    has(name) {
      for (let i = 0; i < this._entries.length; i++) if (this._entries[i][0] === name) return true;
      return false;
    }
    delete(name) {
      this._entries = this._entries.filter((e) => e[0] !== name);
    }
    forEach(cb) {
      for (let i = 0; i < this._entries.length; i++) cb(this._entries[i][1], this._entries[i][0], this);
    }
    keys() {
      return this._entries.map((e) => e[0]);
    }
    values() {
      return this._entries.map((e) => e[1]);
    }
    entries() {
      return this._entries.map((e) => [e[0], e[1]]);
    }
  }
  globalThis.FormData = __SproutboatFormData;
}

function __sbParseUrlencodedFormData(text) {
  const fd = new FormData();
  // forEach, not keys()/values() — those are spec'd as iterators, not
  // arrays, and this shim's own URLSearchParams.keys()/values() return
  // arrays as an implementation shortcut, so relying on either shape here
  // would break against whichever kind actually ends up installed.
  new URLSearchParams(text).forEach((value, key) => fd.append(key, value));
  return fd;
}

function __sbParseMultipartFormData(text, boundary) {
  const fd = new FormData();
  const delim = "--" + boundary;
  const segments = text.split(delim);
  // segments[0] is the preamble, the last is the closing "--" epilogue.
  for (let i = 1; i < segments.length - 1; i++) {
    let part = segments[i];
    if (part.slice(0, 2) === "\r\n") part = part.slice(2);
    if (part.slice(-2) === "\r\n") part = part.slice(0, -2);
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headerText = part.slice(0, headerEnd);
    const body = part.slice(headerEnd + 4);
    const nameMatch = /name="([^"]*)"/i.exec(headerText);
    if (!nameMatch) continue;
    const filenameMatch = /filename="([^"]*)"/i.exec(headerText);
    if (filenameMatch) fd.append(nameMatch[1], new Blob([body]), filenameMatch[1]);
    else fd.append(nameMatch[1], body);
  }
  return fd;
}

function __sbFormDataFromBody(headers, text) {
  const contentType = headers.get("content-type") || "";
  if (contentType.indexOf("multipart/form-data") !== -1) {
    const boundaryMatch = /boundary=(?:"([^"]*)"|([^;]+))/i.exec(contentType);
    const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]).trim() : null;
    if (!boundary) throw new TypeError("multipart/form-data body has no boundary");
    return __sbParseMultipartFormData(text, boundary);
  }
  return __sbParseUrlencodedFormData(text);
}

if (!("formData" in Request.prototype)) {
  Request.prototype.formData = function () {
    return __sbFormDataFromBody(this.headers, this.text());
  };
}
if (!("formData" in Response.prototype)) {
  Response.prototype.formData = function () {
    return __sbFormDataFromBody(this.headers, this.text());
  };
}
// #60 — the newer Uint8Array shorthand, trivial on top of arrayBuffer().
if (!("bytes" in Request.prototype)) {
  Request.prototype.bytes = function () {
    return new Uint8Array(this.arrayBuffer());
  };
}
if (!("bytes" in Response.prototype)) {
  Response.prototype.bytes = function () {
    return new Uint8Array(this.arrayBuffer());
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

// #133 — a WebCrypto subset: crypto.subtle.digest (SHA-256/384/512) and HMAC
// sign/verify over a raw key. Enough for JWTs and hand-rolled sessions; not a
// complete SubtleCrypto (no ECDSA, no AES, no key wrapping). The surface is
// exactly standard so it can be deleted when Porffor ships Web Crypto
// (CanadaHonk/porffor#347). Backed by the inline-C SHA-2 above, not a link
// dependency, so it works on the broker transport too.
function __sbHashBits(algo) {
  const n = String((algo && algo.name) || algo || "").toUpperCase();
  if (n === "SHA-256" || n === "SHA256") return "256";
  if (n === "SHA-384" || n === "SHA384") return "384";
  if (n === "SHA-512" || n === "SHA512") return "512";
  return "";
}
// Where __sbToBytes stops growing one string and starts a new window. 512 is
// where the two costs cross on a `porf native` build; the curve is flat either
// side of it, so this is a plateau, not a tuned constant.
const __SB_BYTES_WINDOW = 512;
// -> a latin1 string, one char per byte. Strings are UTF-8 encoded (matching
// TextEncoder); ArrayBuffer / typed-array input is copied byte for byte.
function __sbToBytes(input) {
  if (input == null) return "";
  // Windowed accumulation (#180, then #181). Plain `s +=` in a loop is O(n^2)
  // here, since Porffor's strings have no rope/cons optimization and every
  // append copies the whole accumulated string -- that's #180, a 43KB body
  // taking ~52ms to encode. But 0.6.4's unconditional array-push-then-join
  // regressed the common case badly: a real app hashing ~150-byte inputs per
  // request lost 64% of its throughput and gained 41% RSS (#181), far more
  // than the per-call cost of the array ops measures in isolation.
  //
  // So: append into a window, and only once a window fills does an array come
  // into existence to hold it. An input below __SB_BYTES_WINDOW allocates no
  // array at all and runs exactly like the pre-#180 code; a large one caps the
  // quadratic copy at one window and joins the windows once. Measured on a
  // `porf native` build, this ties `+=` at 100-512 bytes and ties array+join
  // at 8-43KB, with no threshold branch to keep in sync.
  //
  // Both branches flush only on a complete character, never mid-sequence, so a
  // surrogate pair can't be split across two windows.
  if (__sbIsStr(input)) {
    let out = null;
    let s = "";
    for (let i = 0; i < input.length; i++) {
      const c = input.charCodeAt(i);
      if (c < 0x80) s += String.fromCharCode(c);
      else if (c < 0x800) s += String.fromCharCode(0xc0 | (c >> 6)) + String.fromCharCode(0x80 | (c & 0x3f));
      else if (c >= 0xd800 && c < 0xdc00 && i + 1 < input.length) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (input.charCodeAt(++i) - 0xdc00);
        s +=
          String.fromCharCode(0xf0 | (cp >> 18)) +
          String.fromCharCode(0x80 | ((cp >> 12) & 0x3f)) +
          String.fromCharCode(0x80 | ((cp >> 6) & 0x3f)) +
          String.fromCharCode(0x80 | (cp & 0x3f));
      } else
        s +=
          String.fromCharCode(0xe0 | (c >> 12)) +
          String.fromCharCode(0x80 | ((c >> 6) & 0x3f)) +
          String.fromCharCode(0x80 | (c & 0x3f));
      if (s.length >= __SB_BYTES_WINDOW) {
        if (out === null) out = [];
        out.push(s);
        s = "";
      }
    }
    if (out === null) return s;
    if (s.length > 0) out.push(s);
    return out.join("");
  }
  const view = input.length !== undefined && input.buffer !== undefined ? input : new Uint8Array(input);
  let out = null;
  let s = "";
  for (let i = 0; i < view.length; i++) {
    s += String.fromCharCode(view[i] & 0xff);
    if (s.length >= __SB_BYTES_WINDOW) {
      if (out === null) out = [];
      out.push(s);
      s = "";
    }
  }
  if (out === null) return s;
  if (s.length > 0) out.push(s);
  return out.join("");
}
function __sbBufFrom(latin1) {
  const b = new Uint8Array(latin1.length);
  for (let i = 0; i < latin1.length; i++) b[i] = latin1.charCodeAt(i) & 0xff;
  return b.buffer;
}
// The reverse of __sbToBytes: a latin1 string holding raw UTF-8 bytes (one
// byte per char) -> a real JS string, decoding multi-byte sequences into
// single characters. Validates each continuation byte (10xxxxxx) before
// consuming it, so a lead byte with no valid continuation -- the common case
// for genuine Latin-1 text, e.g. a lone "é" -- passes through unchanged
// rather than swallowing following characters into a garbage code point.
// Used only where sproutboat's own glue knows for certain the string is
// opaque bytes off the wire (the `x-sb-raw-body` producers below), never on
// a generic string a handler might have built -- Porffor represents any
// string whose chars are all <= 0xff as this same "bytestring" shape
// regardless of whether it holds real Latin-1 text or raw bytes, so this
// decode is only safe where the caller already knows which one it has.
function __sbFromUtf8(bytes) {
  // Collected into an array and joined once at the end, not built with
  // repeated `out +=` -- Porffor's strings have no rope/cons optimization, so
  // `+=` in a loop copies the whole accumulated string on every append,
  // making the naive version O(n^2). Measured on the real 43KB homepage
  // (dynamic, wire-sourced content, not a compile-time constant): each
  // successive 8000-character chunk took visibly longer than the last, ~2.8s
  // total -- a real, shipped performance regression on sproutboat.com.
  // `Array.prototype.join` builds the result in one pass.
  const out = [];
  const len = bytes.length;
  const cont = (j) => {
    const b = bytes.charCodeAt(j) & 0xff;
    return (b & 0xc0) == 0x80 ? b & 0x3f : -1;
  };
  for (let i = 0; i < len; i++) {
    const b0 = bytes.charCodeAt(i) & 0xff;
    if (b0 < 0x80) {
      out.push(String.fromCharCode(b0));
      continue;
    }
    if ((b0 & 0xe0) == 0xc0 && i + 1 < len) {
      const c1 = cont(i + 1);
      if (c1 >= 0) {
        out.push(String.fromCharCode(((b0 & 0x1f) << 6) | c1));
        i += 1;
        continue;
      }
    } else if ((b0 & 0xf0) == 0xe0 && i + 2 < len) {
      const c1 = cont(i + 1);
      const c2 = cont(i + 2);
      if (c1 >= 0 && c2 >= 0) {
        out.push(String.fromCharCode(((b0 & 0x0f) << 12) | (c1 << 6) | c2));
        i += 2;
        continue;
      }
    } else if ((b0 & 0xf8) == 0xf0 && i + 3 < len) {
      const c1 = cont(i + 1);
      const c2 = cont(i + 2);
      const c3 = cont(i + 3);
      if (c1 >= 0 && c2 >= 0 && c3 >= 0) {
        let cp = ((b0 & 0x07) << 18) | (c1 << 12) | (c2 << 6) | c3;
        cp -= 0x10000;
        out.push(String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)));
        i += 3;
        continue;
      }
    }
    // no lead byte matched, or its continuation bytes weren't 10xxxxxx:
    // pass the single byte through rather than guessing
    out.push(String.fromCharCode(b0));
  }
  return out.join("");
}
// sproutboat #181 — wrap a Response built from raw wire bytes (the assets
// binding, outbound fetch(), service-binding fetch(): the three `x-sb-raw-
// body` producers) so a handler calling `.text()`/`.json()` on it gets the
// bytes properly UTF-8-decoded. The wire write path already handles the
// C-level byte-for-byte passthrough via that same header (#176) -- this is
// the separate, missing half: Porffor's own `Response.prototype.text()`
// returns a `bytestring` body verbatim instead of decoding it (it can't tell
// "opaque bytes" from "a handler's own Latin-1-range string" apart, so it
// safely can't decode by default). Overriding just these three instances,
// which sproutboat itself builds and knows are bytes, fixes the read side
// without touching Porffor's generic Response/Request classes at all.
// Decoded lazily, on first .text()/.json() call, and memoized after that --
// most raw-body responses (a static asset, a proxied fetch()) are handed
// straight back to the client and never read as text at all, and Porffor's
// strings have no rope/cons optimization: `+=`-building a decoded copy costs
// real time proportional to the body size (measured ~116ms for a 44KB
// all-ASCII body). Decoding unconditionally at construction paid that cost
// on every asset request regardless of whether anything used it -- this was
// a real, shipped performance regression on sproutboat.com, caught after
// the fact by unexpectedly slow page loads.
function __sbRawBodyResponse(body, init) {
  const resp = new Response(body == null ? "" : body, init);
  if (body != null) {
    let decoded = null;
    resp.text = () => {
      if (decoded === null) decoded = __sbFromUtf8(body);
      return decoded;
    };
    resp.json = () => JSON.parse(resp.text());
  }
  return resp;
}
// Constant-time compare of two latin1 byte strings.
function __sbEqCt(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
// An even-length all-hex string -> its bytes; anything else -> its raw bytes.
function __sbHexOrBytes(value) {
  if (__sbIsStr(value) && value.length > 0 && value.length % 2 === 0) {
    // The high nibble waits in a local until its pair arrives, instead of the
    // old `out = out.slice(0, -1) + ...` rewrite, which copied the whole
    // accumulated string a second time per byte. Deliberately still `+=` and
    // not __sbToBytes' windowing: this decodes an HMAC signature, which is
    // tens of bytes, and #181 showed array allocation is the expensive part at
    // that size. ponytail: O(n^2) above a few KB, window it like __sbToBytes
    // if a caller ever passes something that big.
    let out = "";
    let hi = 0;
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      const d = c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1;
      if (d < 0) return __sbToBytes(value);
      if (i % 2 === 0) hi = d << 4;
      else out += String.fromCharCode(hi | d);
    }
    return out;
  }
  return __sbToBytes(value);
}

if (globalThis.crypto.subtle == null) {
  globalThis.crypto.subtle = {
    async digest(algo, data) {
      const bits = __sbHashBits(algo);
      if (!bits) throw new Error("crypto.subtle.digest: unsupported algorithm");
      const out = __sbDigestRaw(bits, __sbToBytes(data));
      if (!out) throw new Error("crypto.subtle.digest failed");
      return __sbBufFrom(out);
    },
    async importKey(format, keyData, algo, extractable, usages) {
      if (format !== "raw") throw new Error("crypto.subtle.importKey: only format 'raw' is supported");
      const name = String((algo && algo.name) || algo || "").toUpperCase();
      if (name !== "HMAC") throw new Error("crypto.subtle.importKey: only HMAC keys are supported");
      const bits = __sbHashBits((algo && algo.hash) || "SHA-256");
      if (!bits) throw new Error("crypto.subtle.importKey: unsupported hash");
      return {
        type: "secret",
        extractable: !!extractable,
        algorithm: { name: "HMAC", hash: { name: "SHA-" + bits } },
        usages: usages || [],
        __sbKey: __sbToBytes(keyData),
        __sbBits: bits,
      };
    },
    async sign(algo, key, data) {
      if (!key || key.__sbKey == null) throw new Error("crypto.subtle.sign: only HMAC keys from importKey are supported");
      const out = __sbHmacRaw(key.__sbBits, key.__sbKey, __sbToBytes(data));
      if (!out) throw new Error("crypto.subtle.sign failed");
      return __sbBufFrom(out);
    },
    async verify(algo, key, signature, data) {
      if (!key || key.__sbKey == null) throw new Error("crypto.subtle.verify: only HMAC keys are supported");
      const mac = __sbHmacRaw(key.__sbBits, key.__sbKey, __sbToBytes(data));
      if (!mac) return false;
      return __sbEqCt(mac, __sbToBytes(signature));
    },
  };
}

// #153 — scrypt verification, for migrating password hashes made elsewhere
// (Node/Bun `scrypt`, N/r/p). Not on WebCrypto; deliberately verify-only, so it
// is a migration tool rather than a KDF blessed for new credentials — new
// credentials should use HMAC/PBKDF2 via crypto.subtle. `expected` is the stored
// hash: a hex string, or bytes (ArrayBuffer / Uint8Array).
if (globalThis.crypto.scryptVerify == null) {
  globalThis.crypto.scryptVerify = function (password, salt, expected, params) {
    const p = params || {};
    const N = p.N || p.cost || 16384;
    const r = p.r || p.blockSize || 8;
    const par = p.p || p.parallelization || 1;
    const want = __sbHexOrBytes(expected);
    if (want.length === 0) return false;
    const dk = __sbScryptRaw(
      __sbToBytes(password),
      __sbToBytes(salt),
      String(N),
      String(r),
      String(par),
      String(want.length),
    );
    return dk.length === want.length && __sbEqCt(dk, want);
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
#include <stdint.h>

u32 porf_native_fetch_alloc_bytestring(const char* input, size_t len);
int porf_native_fetch_read_value(jsval value, const char** out_buf, size_t* out_len, char** out_owned);

// --- #133: SHA-2 + HMAC ---------------------------------------------------
// Standalone links BearSSL, but a deployed sprout does not, and this inline C
// is shared by both transports — so a plain reference SHA-2 rather than a link
// dependency. It also lets a handler drop a vendored pure-JS SHA-256. Exposed
// as crypto.subtle.digest / sign / verify (HMAC), which deletes cleanly when
// Porffor ships Web Crypto (CanadaHonk/porffor#347).
#define SB_ROR32(x, n) (((x) >> (n)) | ((x) << (32 - (n))))
#define SB_ROR64(x, n) (((x) >> (n)) | ((x) << (64 - (n))))

typedef struct { uint32_t h[8]; uint64_t len; unsigned char buf[64]; size_t n; } sb_sha256_ctx;
static const uint32_t sb_k256[64] = {
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2 };
static void sb_sha256_block(sb_sha256_ctx* c, const unsigned char* p) {
  uint32_t w[64], a,b,cc,d,e,f,g,h,t1,t2;
  for (int i = 0; i < 16; i++)
    w[i] = ((uint32_t)p[i*4]<<24)|((uint32_t)p[i*4+1]<<16)|((uint32_t)p[i*4+2]<<8)|((uint32_t)p[i*4+3]);
  for (int i = 16; i < 64; i++) {
    uint32_t s0 = SB_ROR32(w[i-15],7) ^ SB_ROR32(w[i-15],18) ^ (w[i-15]>>3);
    uint32_t s1 = SB_ROR32(w[i-2],17) ^ SB_ROR32(w[i-2],19) ^ (w[i-2]>>10);
    w[i] = w[i-16] + s0 + w[i-7] + s1;
  }
  a=c->h[0];b=c->h[1];cc=c->h[2];d=c->h[3];e=c->h[4];f=c->h[5];g=c->h[6];h=c->h[7];
  for (int i = 0; i < 64; i++) {
    uint32_t S1 = SB_ROR32(e,6) ^ SB_ROR32(e,11) ^ SB_ROR32(e,25);
    uint32_t ch = (e & f) ^ (~e & g);
    t1 = h + S1 + ch + sb_k256[i] + w[i];
    uint32_t S0 = SB_ROR32(a,2) ^ SB_ROR32(a,13) ^ SB_ROR32(a,22);
    uint32_t maj = (a & b) ^ (a & cc) ^ (b & cc);
    t2 = S0 + maj;
    h=g;g=f;f=e;e=d+t1;d=cc;cc=b;b=a;a=t1+t2;
  }
  c->h[0]+=a;c->h[1]+=b;c->h[2]+=cc;c->h[3]+=d;c->h[4]+=e;c->h[5]+=f;c->h[6]+=g;c->h[7]+=h;
}
static void sb_sha256_init(sb_sha256_ctx* c) {
  c->h[0]=0x6a09e667;c->h[1]=0xbb67ae85;c->h[2]=0x3c6ef372;c->h[3]=0xa54ff53a;
  c->h[4]=0x510e527f;c->h[5]=0x9b05688c;c->h[6]=0x1f83d9ab;c->h[7]=0x5be0cd19;c->len=0;c->n=0;
}
static void sb_sha256_update(sb_sha256_ctx* c, const unsigned char* p, size_t n) {
  c->len += n;
  while (n) {
    size_t k = 64 - c->n; if (k > n) k = n;
    memcpy(c->buf + c->n, p, k); c->n += k; p += k; n -= k;
    if (c->n == 64) { sb_sha256_block(c, c->buf); c->n = 0; }
  }
}
static void sb_sha256_final(sb_sha256_ctx* c, unsigned char out[32]) {
  uint64_t bits = c->len * 8;
  unsigned char pad = 0x80;
  sb_sha256_update(c, &pad, 1);
  unsigned char z = 0;
  while (c->n != 56) sb_sha256_update(c, &z, 1);
  unsigned char lb[8];
  for (int i = 0; i < 8; i++) lb[i] = (unsigned char)(bits >> (56 - i*8));
  sb_sha256_update(c, lb, 8);
  for (int i = 0; i < 8; i++) {
    out[i*4]=(unsigned char)(c->h[i]>>24);out[i*4+1]=(unsigned char)(c->h[i]>>16);
    out[i*4+2]=(unsigned char)(c->h[i]>>8);out[i*4+3]=(unsigned char)c->h[i];
  }
}

typedef struct { uint64_t h[8]; uint64_t lenhi, lenlo; unsigned char buf[128]; size_t n; } sb_sha512_ctx;
static const uint64_t sb_k512[80] = {
  0x428a2f98d728ae22ULL,0x7137449123ef65cdULL,0xb5c0fbcfec4d3b2fULL,0xe9b5dba58189dbbcULL,
  0x3956c25bf348b538ULL,0x59f111f1b605d019ULL,0x923f82a4af194f9bULL,0xab1c5ed5da6d8118ULL,
  0xd807aa98a3030242ULL,0x12835b0145706fbeULL,0x243185be4ee4b28cULL,0x550c7dc3d5ffb4e2ULL,
  0x72be5d74f27b896fULL,0x80deb1fe3b1696b1ULL,0x9bdc06a725c71235ULL,0xc19bf174cf692694ULL,
  0xe49b69c19ef14ad2ULL,0xefbe4786384f25e3ULL,0x0fc19dc68b8cd5b5ULL,0x240ca1cc77ac9c65ULL,
  0x2de92c6f592b0275ULL,0x4a7484aa6ea6e483ULL,0x5cb0a9dcbd41fbd4ULL,0x76f988da831153b5ULL,
  0x983e5152ee66dfabULL,0xa831c66d2db43210ULL,0xb00327c898fb213fULL,0xbf597fc7beef0ee4ULL,
  0xc6e00bf33da88fc2ULL,0xd5a79147930aa725ULL,0x06ca6351e003826fULL,0x142929670a0e6e70ULL,
  0x27b70a8546d22ffcULL,0x2e1b21385c26c926ULL,0x4d2c6dfc5ac42aedULL,0x53380d139d95b3dfULL,
  0x650a73548baf63deULL,0x766a0abb3c77b2a8ULL,0x81c2c92e47edaee6ULL,0x92722c851482353bULL,
  0xa2bfe8a14cf10364ULL,0xa81a664bbc423001ULL,0xc24b8b70d0f89791ULL,0xc76c51a30654be30ULL,
  0xd192e819d6ef5218ULL,0xd69906245565a910ULL,0xf40e35855771202aULL,0x106aa07032bbd1b8ULL,
  0x19a4c116b8d2d0c8ULL,0x1e376c085141ab53ULL,0x2748774cdf8eeb99ULL,0x34b0bcb5e19b48a8ULL,
  0x391c0cb3c5c95a63ULL,0x4ed8aa4ae3418acbULL,0x5b9cca4f7763e373ULL,0x682e6ff3d6b2b8a3ULL,
  0x748f82ee5defb2fcULL,0x78a5636f43172f60ULL,0x84c87814a1f0ab72ULL,0x8cc702081a6439ecULL,
  0x90befffa23631e28ULL,0xa4506cebde82bde9ULL,0xbef9a3f7b2c67915ULL,0xc67178f2e372532bULL,
  0xca273eceea26619cULL,0xd186b8c721c0c207ULL,0xeada7dd6cde0eb1eULL,0xf57d4f7fee6ed178ULL,
  0x06f067aa72176fbaULL,0x0a637dc5a2c898a6ULL,0x113f9804bef90daeULL,0x1b710b35131c471bULL,
  0x28db77f523047d84ULL,0x32caab7b40c72493ULL,0x3c9ebe0a15c9bebcULL,0x431d67c49c100d4cULL,
  0x4cc5d4becb3e42b6ULL,0x597f299cfc657e2aULL,0x5fcb6fab3ad6faecULL,0x6c44198c4a475817ULL };
static void sb_sha512_block(sb_sha512_ctx* c, const unsigned char* p) {
  uint64_t w[80], a,b,cc,d,e,f,g,h,t1,t2;
  for (int i = 0; i < 16; i++) {
    w[i] = 0; for (int j = 0; j < 8; j++) w[i] = (w[i]<<8) | p[i*8+j];
  }
  for (int i = 16; i < 80; i++) {
    uint64_t s0 = SB_ROR64(w[i-15],1) ^ SB_ROR64(w[i-15],8) ^ (w[i-15]>>7);
    uint64_t s1 = SB_ROR64(w[i-2],19) ^ SB_ROR64(w[i-2],61) ^ (w[i-2]>>6);
    w[i] = w[i-16] + s0 + w[i-7] + s1;
  }
  a=c->h[0];b=c->h[1];cc=c->h[2];d=c->h[3];e=c->h[4];f=c->h[5];g=c->h[6];h=c->h[7];
  for (int i = 0; i < 80; i++) {
    uint64_t S1 = SB_ROR64(e,14) ^ SB_ROR64(e,18) ^ SB_ROR64(e,41);
    uint64_t ch = (e & f) ^ (~e & g);
    t1 = h + S1 + ch + sb_k512[i] + w[i];
    uint64_t S0 = SB_ROR64(a,28) ^ SB_ROR64(a,34) ^ SB_ROR64(a,39);
    uint64_t maj = (a & b) ^ (a & cc) ^ (b & cc);
    t2 = S0 + maj;
    h=g;g=f;f=e;e=d+t1;d=cc;cc=b;b=a;a=t1+t2;
  }
  c->h[0]+=a;c->h[1]+=b;c->h[2]+=cc;c->h[3]+=d;c->h[4]+=e;c->h[5]+=f;c->h[6]+=g;c->h[7]+=h;
}
static void sb_sha512_init(sb_sha512_ctx* c, int is384) {
  if (is384) {
    c->h[0]=0xcbbb9d5dc1059ed8ULL;c->h[1]=0x629a292a367cd507ULL;c->h[2]=0x9159015a3070dd17ULL;c->h[3]=0x152fecd8f70e5939ULL;
    c->h[4]=0x67332667ffc00b31ULL;c->h[5]=0x8eb44a8768581511ULL;c->h[6]=0xdb0c2e0d64f98fa7ULL;c->h[7]=0x47b5481dbefa4fa4ULL;
  } else {
    c->h[0]=0x6a09e667f3bcc908ULL;c->h[1]=0xbb67ae8584caa73bULL;c->h[2]=0x3c6ef372fe94f82bULL;c->h[3]=0xa54ff53a5f1d36f1ULL;
    c->h[4]=0x510e527fade682d1ULL;c->h[5]=0x9b05688c2b3e6c1fULL;c->h[6]=0x1f83d9abfb41bd6bULL;c->h[7]=0x5be0cd19137e2179ULL;
  }
  c->lenhi=0;c->lenlo=0;c->n=0;
}
static void sb_sha512_update(sb_sha512_ctx* c, const unsigned char* p, size_t n) {
  uint64_t add = n; if ((c->lenlo += add) < add) c->lenhi++;
  while (n) {
    size_t k = 128 - c->n; if (k > n) k = n;
    memcpy(c->buf + c->n, p, k); c->n += k; p += k; n -= k;
    if (c->n == 128) { sb_sha512_block(c, c->buf); c->n = 0; }
  }
}
static void sb_sha512_final(sb_sha512_ctx* c, unsigned char* out, int is384) {
  uint64_t bhi = (c->lenhi << 3) | (c->lenlo >> 61), blo = c->lenlo << 3;
  unsigned char pad = 0x80;
  sb_sha512_update(c, &pad, 1);
  unsigned char z = 0;
  while (c->n != 112) sb_sha512_update(c, &z, 1);
  unsigned char lb[16];
  for (int i = 0; i < 8; i++) lb[i] = (unsigned char)(bhi >> (56 - i*8));
  for (int i = 0; i < 8; i++) lb[8+i] = (unsigned char)(blo >> (56 - i*8));
  sb_sha512_update(c, lb, 16);
  int words = is384 ? 6 : 8;
  for (int i = 0; i < words; i++)
    for (int j = 0; j < 8; j++) out[i*8+j] = (unsigned char)(c->h[i] >> (56 - j*8));
}

// One-shot digest. algo: 256 | 384 | 512. out must hold 32/48/64 bytes.
// Returns the digest length, or 0 for an unknown algo.
static size_t sb_digest(int algo, const unsigned char* msg, size_t mlen, unsigned char* out) {
  if (algo == 256) { sb_sha256_ctx c; sb_sha256_init(&c); sb_sha256_update(&c, msg, mlen); sb_sha256_final(&c, out); return 32; }
  if (algo == 384) { sb_sha512_ctx c; sb_sha512_init(&c, 1); sb_sha512_update(&c, msg, mlen); sb_sha512_final(&c, out, 1); return 48; }
  if (algo == 512) { sb_sha512_ctx c; sb_sha512_init(&c, 0); sb_sha512_update(&c, msg, mlen); sb_sha512_final(&c, out, 0); return 64; }
  return 0;
}

// HMAC(algo) per RFC 2104. Block size is 64 for SHA-256, 128 for SHA-384/512.
static size_t sb_hmac(int algo, const unsigned char* key, size_t klen,
                      const unsigned char* msg, size_t mlen, unsigned char* out) {
  size_t bs = algo == 256 ? 64 : 128;
  unsigned char k[128], ipad[128], opad[128], inner[64];
  memset(k, 0, sizeof(k));
  if (klen > bs) { sb_digest(algo, key, klen, k); }
  else memcpy(k, key, klen);
  for (size_t i = 0; i < bs; i++) { ipad[i] = k[i] ^ 0x36; opad[i] = k[i] ^ 0x5c; }
  size_t dl;
  if (algo == 256) {
    sb_sha256_ctx c; sb_sha256_init(&c);
    sb_sha256_update(&c, ipad, bs); sb_sha256_update(&c, msg, mlen); sb_sha256_final(&c, inner);
    sb_sha256_ctx o; sb_sha256_init(&o);
    sb_sha256_update(&o, opad, bs); sb_sha256_update(&o, inner, 32); sb_sha256_final(&o, out);
    dl = 32;
  } else {
    int is384 = algo == 384; dl = is384 ? 48 : 64;
    sb_sha512_ctx c; sb_sha512_init(&c, is384);
    sb_sha512_update(&c, ipad, bs); sb_sha512_update(&c, msg, mlen); sb_sha512_final(&c, inner, is384);
    sb_sha512_ctx o; sb_sha512_init(&o, is384);
    sb_sha512_update(&o, opad, bs); sb_sha512_update(&o, inner, dl); sb_sha512_final(&o, out, is384);
  }
  return dl;
}

// --- #153: scrypt (RFC 7914), for verifying pre-existing password hashes ----
// PBKDF2-HMAC-SHA256 (reuses sb_hmac) + Salsa20/8 + BlockMix + ROMix. Exposed
// only as crypto.scryptVerify: a migration path for hashes made elsewhere
// (Node/Bun scrypt), not a blessed KDF for new credentials.
static void sb_pbkdf2_hmac256(const unsigned char* pw, size_t pwlen,
                              const unsigned char* salt, size_t saltlen,
                              uint32_t iters, unsigned char* out, size_t dklen) {
  unsigned char block[64], u[32], t[32];
  uint32_t i = 1;
  size_t done = 0;
  while (done < dklen) {
    unsigned char* s2 = (unsigned char*)malloc(saltlen + 4);
    memcpy(s2, salt, saltlen);
    s2[saltlen] = (unsigned char)(i >> 24); s2[saltlen+1] = (unsigned char)(i >> 16);
    s2[saltlen+2] = (unsigned char)(i >> 8); s2[saltlen+3] = (unsigned char)i;
    sb_hmac(256, pw, pwlen, s2, saltlen + 4, u);
    free(s2);
    memcpy(t, u, 32);
    // iters is 1 for scrypt's use of PBKDF2, but support the general case.
    for (uint32_t j = 1; j < iters; j++) {
      sb_hmac(256, pw, pwlen, u, 32, u);
      for (int k = 0; k < 32; k++) t[k] ^= u[k];
    }
    memcpy(block, t, 32);
    size_t take = dklen - done; if (take > 32) take = 32;
    memcpy(out + done, block, take);
    done += take; i++;
  }
}
static void sb_salsa20_8(uint32_t out[16], const uint32_t in[16]) {
  uint32_t x[16];
  for (int i = 0; i < 16; i++) x[i] = in[i];
  for (int i = 0; i < 4; i++) {
    x[ 4] ^= SB_ROR32(x[ 0] + x[12], 32 - 7);  x[ 8] ^= SB_ROR32(x[ 4] + x[ 0], 32 - 9);
    x[12] ^= SB_ROR32(x[ 8] + x[ 4], 32 - 13); x[ 0] ^= SB_ROR32(x[12] + x[ 8], 32 - 18);
    x[ 9] ^= SB_ROR32(x[ 5] + x[ 1], 32 - 7);  x[13] ^= SB_ROR32(x[ 9] + x[ 5], 32 - 9);
    x[ 1] ^= SB_ROR32(x[13] + x[ 9], 32 - 13); x[ 5] ^= SB_ROR32(x[ 1] + x[13], 32 - 18);
    x[14] ^= SB_ROR32(x[10] + x[ 6], 32 - 7);  x[ 2] ^= SB_ROR32(x[14] + x[10], 32 - 9);
    x[ 6] ^= SB_ROR32(x[ 2] + x[14], 32 - 13); x[10] ^= SB_ROR32(x[ 6] + x[ 2], 32 - 18);
    x[ 3] ^= SB_ROR32(x[15] + x[11], 32 - 7);  x[ 7] ^= SB_ROR32(x[ 3] + x[15], 32 - 9);
    x[11] ^= SB_ROR32(x[ 7] + x[ 3], 32 - 13); x[15] ^= SB_ROR32(x[11] + x[ 7], 32 - 18);
    x[ 1] ^= SB_ROR32(x[ 0] + x[ 3], 32 - 7);  x[ 2] ^= SB_ROR32(x[ 1] + x[ 0], 32 - 9);
    x[ 3] ^= SB_ROR32(x[ 2] + x[ 1], 32 - 13); x[ 0] ^= SB_ROR32(x[ 3] + x[ 2], 32 - 18);
    x[ 6] ^= SB_ROR32(x[ 5] + x[ 4], 32 - 7);  x[ 7] ^= SB_ROR32(x[ 6] + x[ 5], 32 - 9);
    x[ 4] ^= SB_ROR32(x[ 7] + x[ 6], 32 - 13); x[ 5] ^= SB_ROR32(x[ 4] + x[ 7], 32 - 18);
    x[11] ^= SB_ROR32(x[10] + x[ 9], 32 - 7);  x[ 8] ^= SB_ROR32(x[11] + x[10], 32 - 9);
    x[ 9] ^= SB_ROR32(x[ 8] + x[11], 32 - 13); x[10] ^= SB_ROR32(x[ 9] + x[ 8], 32 - 18);
    x[12] ^= SB_ROR32(x[15] + x[14], 32 - 7);  x[13] ^= SB_ROR32(x[12] + x[15], 32 - 9);
    x[14] ^= SB_ROR32(x[13] + x[12], 32 - 13); x[15] ^= SB_ROR32(x[14] + x[13], 32 - 18);
  }
  for (int i = 0; i < 16; i++) out[i] = x[i] + in[i];
}
// BlockMix: B is 2r 64-byte blocks (as uint32 words). Result into out.
static void sb_blockmix(const uint32_t* b, uint32_t* out, size_t r) {
  uint32_t x[16], y[16];
  memcpy(x, b + (2*r - 1) * 16, 64);
  for (size_t i = 0; i < 2*r; i++) {
    for (int k = 0; k < 16; k++) x[k] ^= b[i*16 + k];
    sb_salsa20_8(y, x);
    memcpy(x, y, 64);
    size_t dst = (i % 2 == 0) ? (i/2) : (r + (i-1)/2);
    memcpy(out + dst*16, x, 64);
  }
}
static uint64_t sb_integerify(const uint32_t* b, size_t r) {
  const uint32_t* p = b + (2*r - 1) * 16;
  return ((uint64_t)p[0]) | (((uint64_t)p[1]) << 32);
}
// scrypt(pw, salt, N, r, p) -> dk[dklen]. Returns 0 on success, -1 on bad
// params or allocation failure. Caps N*r so a bad config cannot ask for GB.
static int sb_scrypt(const unsigned char* pw, size_t pwlen, const unsigned char* salt, size_t saltlen,
                     uint64_t N, uint32_t r, uint32_t p, unsigned char* dk, size_t dklen) {
  if (r == 0 || p == 0 || N < 2 || (N & (N - 1)) != 0) return -1;
  if ((uint64_t)r * N > (1ULL << 20)) return -1; // <= 128 MiB of V
  size_t blk = 128 * (size_t)r;                  // one B block, bytes
  unsigned char* b = (unsigned char*)malloc(blk * p);
  uint32_t* v = (uint32_t*)malloc(blk * (size_t)N);
  uint32_t* xy = (uint32_t*)malloc(blk * 2);
  if (!b || !v || !xy) { free(b); free(v); free(xy); return -1; }
  sb_pbkdf2_hmac256(pw, pwlen, salt, saltlen, 1, b, blk * p);
  for (uint32_t i = 0; i < p; i++) {
    uint32_t* x = (uint32_t*)(b + (size_t)i * blk);
    uint32_t* y = xy;
    for (uint64_t j = 0; j < N; j++) {
      memcpy(v + j * (blk / 4), x, blk);
      sb_blockmix(x, y, r);
      memcpy(x, y, blk);
    }
    for (uint64_t j = 0; j < N; j++) {
      uint64_t k = sb_integerify(x, r) & (N - 1);
      const uint32_t* vk = v + k * (blk / 4);
      for (size_t w = 0; w < blk / 4; w++) x[w] ^= vk[w];
      sb_blockmix(x, y, r);
      memcpy(x, y, blk);
    }
  }
  sb_pbkdf2_hmac256(pw, pwlen, b, blk * p, 1, dk, dklen);
  free(b); free(v); free(xy);
  return 0;
}

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

// #133 — one-shot SHA-2 digest. `algoStr` is "256"|"384"|"512"; `data` is a
// latin1 string (one char per byte). Returns the raw digest as a bytestring.
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block, not by JS.
function __sbDigestRaw(algoStr, data) {
  let out = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __as; size_t __asl; char* __aso = 0;
    porf_native_fetch_read_value(algoStr, &__as, &__asl, &__aso);
    char __ab[8]; size_t __ak = __asl < 7 ? __asl : 7;
    memcpy(__ab, __as, __ak); __ab[__ak] = 0;
    if (__aso) free(__aso);
    int __algo = atoi(__ab);

    const char* __d; size_t __dl; char* __do = 0;
    porf_native_fetch_read_value(data, &__d, &__dl, &__do);
    unsigned char __out[64];
    size_t __n = sb_digest(__algo, (const unsigned char*)__d, __dl, __out);
    if (__do) free(__do);
    if (__n) out = porf_box((f64)porf_native_fetch_alloc_bytestring((const char*)__out, __n), 195);
  `;
  return out;
}

// #133 — HMAC-SHA-2. `algoStr` "256"|"384"|"512"; `key` and `data` latin1.
// Returns the raw MAC as a bytestring.
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block, not by JS.
function __sbHmacRaw(algoStr, key, data) {
  let out = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __as; size_t __asl; char* __aso = 0;
    porf_native_fetch_read_value(algoStr, &__as, &__asl, &__aso);
    char __ab[8]; size_t __ak = __asl < 7 ? __asl : 7;
    memcpy(__ab, __as, __ak); __ab[__ak] = 0;
    if (__aso) free(__aso);
    int __algo = atoi(__ab);

    const char* __k; size_t __kl; char* __ko = 0;
    porf_native_fetch_read_value(key, &__k, &__kl, &__ko);
    unsigned char* __kc = (unsigned char*)malloc(__kl ? __kl : 1);
    if (__kc) memcpy(__kc, __k, __kl);
    if (__ko) free(__ko);

    const char* __d; size_t __dl; char* __do = 0;
    porf_native_fetch_read_value(data, &__d, &__dl, &__do);
    unsigned char __out[64];
    size_t __n = __kc ? sb_hmac(__algo, __kc, __kl, (const unsigned char*)__d, __dl, __out) : 0;
    if (__do) free(__do);
    if (__kc) free(__kc);
    if (__n) out = porf_box((f64)porf_native_fetch_alloc_bytestring((const char*)__out, __n), 195);
  `;
  return out;
}

// #153 — scrypt derivation. All params are decimal strings. Returns the derived
// key as a bytestring, or '' on bad params / allocation failure.
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block, not by JS.
function __sbScryptRaw(pw, salt, nStr, rStr, pStr, dkLenStr) {
  let out = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __p; size_t __pl; char* __po = 0;
    porf_native_fetch_read_value(pw, &__p, &__pl, &__po);
    unsigned char* __pc = (unsigned char*)malloc(__pl ? __pl : 1);
    if (__pc) memcpy(__pc, __p, __pl);
    if (__po) free(__po);

    const char* __s; size_t __sl; char* __so = 0;
    porf_native_fetch_read_value(salt, &__s, &__sl, &__so);
    unsigned char* __sc = (unsigned char*)malloc(__sl ? __sl : 1);
    if (__sc) memcpy(__sc, __s, __sl);
    if (__so) free(__so);

    long __N = 0, __r = 0, __pp = 0, __dk = 0;
    { const char* q; size_t ql; char* qo = 0; char nb[24];
      porf_native_fetch_read_value(nStr, &q, &ql, &qo); { size_t k = ql < 23 ? ql : 23; memcpy(nb, q, k); nb[k] = 0; } if (qo) free(qo); __N = atol(nb);
      porf_native_fetch_read_value(rStr, &q, &ql, &qo); { size_t k = ql < 23 ? ql : 23; memcpy(nb, q, k); nb[k] = 0; } if (qo) free(qo); __r = atol(nb);
      porf_native_fetch_read_value(pStr, &q, &ql, &qo); { size_t k = ql < 23 ? ql : 23; memcpy(nb, q, k); nb[k] = 0; } if (qo) free(qo); __pp = atol(nb);
      porf_native_fetch_read_value(dkLenStr, &q, &ql, &qo); { size_t k = ql < 23 ? ql : 23; memcpy(nb, q, k); nb[k] = 0; } if (qo) free(qo); __dk = atol(nb);
    }
    if (__pc && __sc && __dk > 0 && __dk <= 1024) {
      unsigned char* __d = (unsigned char*)malloc((size_t)__dk);
      if (__d) {
        if (sb_scrypt(__pc, __pl, __sc, __sl, (uint64_t)__N, (uint32_t)__r, (uint32_t)__pp, __d, (size_t)__dk) == 0)
          out = porf_box((f64)porf_native_fetch_alloc_bytestring((const char*)__d, (size_t)__dk), 195);
        free(__d);
      }
    }
    if (__pc) free(__pc);
    if (__sc) free(__sc);
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
    // Sproutboat extension (not in CF Workers D1): an online, integrity-checked
    // snapshot of this database. Standalone only for now — the broker transport
    // returns an error until hosted backup (#139) covers it. `name` lands under
    // `<data-dir>/backups/`; omit it for a timestamped default. See #164.
    backup(name) {
      const r = __sbRpc("d1.backup", { db: dbName, name: name == null ? "" : String(name) });
      return { path: r.path, bytes: r.bytes };
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
    // #184 — `body` is raw bytes (a bytestring), not decoded text: `.text()`
    // returning it verbatim produced mojibake for any object holding real
    // UTF-8 content, the same gap __sbRawBodyResponse already closed for
    // assets/fetch/service-binding responses. Same fix here: decode lazily,
    // once, on first read.
    let decoded = null;
    obj.text = function () {
      if (decoded === null) decoded = __sbFromUtf8(body);
      return decoded;
    };
    obj.json = function () {
      return JSON.parse(obj.text());
    };
    // #177 — `new Response(obj.body)` UTF-8-re-encodes the raw bytes (they're
    // a bytestring, same ambiguity #172/#176 exist to resolve): any byte
    // 0x80-0xFF doubles into two bytes, corrupting binary content on the way
    // out. `toResponse()` is the fix already used for assets/fetch/service
    // bindings (`__sbRawBodyResponse`, below) — same reserved x-sb-raw-body
    // marker, applied here too.
    obj.toResponse = function (init) {
      const opts = init || {};
      const headers = new Headers(opts.headers || {});
      headers.set("x-sb-raw-body", "1");
      if (!headers.has("content-type") && obj.httpMetadata.contentType)
        headers.set("content-type", obj.httpMetadata.contentType);
      if (!headers.has("etag")) headers.set("etag", obj.httpEtag);
      return __sbRawBodyResponse(body, { status: opts.status, headers });
    };
  }
  return obj;
}

function __sbR2Multipart(bucket, key, uploadId) {
  return {
    key,
    uploadId,
    uploadPart(partNumber, value) {
      const number = Number(partNumber);
      if (!Number.isInteger(number) || number < 1 || number > 10000)
        throw new TypeError("partNumber must be an integer between 1 and 10000");
      return __sbR2MultipartPut(bucket, key, uploadId, number, value == null ? "" : String(value)).part;
    },
    complete(parts) {
      const r = __sbRpc("r2.multipart.complete", { bucket, key, uploadId, parts: parts || [] });
      return __sbR2Object(r.object, null);
    },
    abort() {
      __sbRpc("r2.multipart.abort", { bucket, key, uploadId });
    },
  };
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
      put(key, value, options) {
        const msg = { ns, key: String(key), value: String(value) };
        if (options && options.expirationTtl != null) msg.expirationTtl = Number(options.expirationTtl);
        else if (options && options.expiration != null) msg.expiration = Number(options.expiration);
        __sbRpc("kv.put", msg);
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
      createMultipartUpload(key, options) {
        const objectKey = String(key);
        const o = options || {};
        const r = __sbRpc("r2.multipart.create", {
          bucket: name,
          key: objectKey,
          httpMetadata: o.httpMetadata || {},
          customMetadata: o.customMetadata || {},
        });
        return __sbR2Multipart(name, objectKey, r.uploadId);
      },
      resumeMultipartUpload(key, uploadId) {
        return __sbR2Multipart(name, String(key), String(uploadId));
      },
      createUploadUrl(key, options) {
        const o = options || {};
        const r = __sbRpc("r2.transfer.create", {
          bucket: name,
          key: String(key),
          method: "upload",
          maxBytes: o.maxBytes,
          expiresIn: o.expiresIn,
          sha256: o.sha256,
          httpMetadata: o.httpMetadata || {},
          customMetadata: o.customMetadata || {},
        });
        return { url: r.url, expiresAt: r.expiresAt };
      },
      createDownloadUrl(key, options) {
        const o = options || {};
        const r = __sbRpc("r2.transfer.create", {
          bucket: name,
          key: String(key),
          method: "download",
          expiresIn: o.expiresIn,
        });
        return { url: r.url, expiresAt: r.expiresAt };
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

  // #69 — env.<NAME>.limit({ key }) -> { success, resetAt }. Fixed window: at
  // most `limit` calls per `period` seconds for a given key. limit/period
  // travel in the message so the op stays stateless (the transport has no
  // config). `resetAt` is epoch ms when the window rolls and the count clears,
  // so a 429 can send `Retry-After: ceil((resetAt - Date.now()) / 1000)`.
  // Returns sync like the other shims (CF's is a Promise; the runtime is sync).
  for (let i = 0; i < (bindings.ratelimiters || []).length; i++) {
    const rl = bindings.ratelimiters[i];
    target[rl.binding] = {
      limit(options) {
        const key = options && options.key != null ? String(options.key) : "";
        const r = __sbRpc("ratelimit.check", { name: rl.binding, key, limit: rl.limit, period: rl.period });
        return { success: !!r.success, resetAt: Number(r.resetAt) || 0 };
      },
    };
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
        // #176: these bytes came off disk already-finished (UTF-8 text or
        // binary, doesn't matter which) -- the reserved x-sb-raw-body header
        // tells the C write path to pass them through untouched instead of
        // re-encoding as if this were a JS string a handler built.
        if (r.body != null) headers["x-sb-raw-body"] = "1";
        return __sbRawBodyResponse(r.body, { status: r.status || (r.found ? 200 : 404), headers });
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
        // #176: wire bytes from another deployment, not a string this handler
        // built -- must not be re-encoded if the handler proxies it straight
        // through (see the assets binding for the same reasoning).
        if (r.body != null) respHeaders.set("x-sb-raw-body", "1");
        return __sbRawBodyResponse(r.body, { status: r.status || 502, headers: respHeaders });
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
      // #176: bytes from an outbound HTTP response, not a string this handler
      // built -- must not be re-encoded if the handler proxies it straight
      // through (see the assets binding for the same reasoning).
      if (r.body != null) respHeaders.set("x-sb-raw-body", "1");
      return __sbRawBodyResponse(r.body, { status: r.status || 502, headers: respHeaders });
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
          const inst = __sbGetDOInstance(className, idStr);
          const res = inst.fetch(req);
          if (inst.__sbTasks.length || (res && __sbIsFn(res.then))) return __sbFetchWithDrain(res, inst.__sbTasks);
          return res;
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
    // #57 — was a no-op: a DO calling `state.waitUntil(p)` had `p` vanish with
    // no error. The instance outlives any one call (cached in
    // `__sbDOInstances`), so the queue lives on `state` too and is drained by
    // whichever call site invoked `fetch`/`alarm` this turn.
    const __sbTasks = [];
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
      waitUntil(p) {
        if (p && __sbIsFn(p.then)) __sbTasks.push(p);
      },
    };
    inst = new Ctor(state, globalThis.env);
    inst.__sbTasks = __sbTasks;
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

// #163 — the connection's remote address, for `request.cf.clientIp`.
//
// `x-sb-remote-addr` is the TCP peer, appended by the server (see
// patches/UPSTREAM.md #163) and stripped from anything a client sends, so it
// cannot be forged. With no proxy in front, that is the client. Behind one, set
// `SB_TRUSTED_PROXIES` to a comma-separated list of trusted CIDRs (or bare IPs):
// when the peer is trusted, the client is the rightmost `x-forwarded-for` entry
// that is not itself a trusted hop.
//
// ponytail: IPv4 CIDR ranges + exact-string match (which covers a bare IPv6).
// An IPv6 *prefix* in SB_TRUSTED_PROXIES matches nothing — widen __sbIpInCidr if
// a deployment ever fronts its sprout with an IPv6 proxy range.
function __sbParseHex(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let d = -1;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (c >= 97 && c <= 102) d = c - 87;
    else if (c >= 65 && c <= 70) d = c - 55;
    if (d < 0) return -1;
    n = n * 16 + d;
  }
  return n;
}
// uWS hands back IPv4-mapped IPv6 for IPv4 clients on a dual-stack socket
// (`::ffff:1.2.3.4`, or fully expanded `0:0:0:0:0:ffff:0102:0304`). Fold those
// to the dotted IPv4 so CIDR matching and `clientIp` see a plain address.
function __sbNormalizeIp(ip) {
  const s = String(ip || "");
  if (s.indexOf(":") === -1) return s;
  const low = s.toLowerCase();
  const dotted = low.indexOf("::ffff:");
  if (dotted === 0 && low.indexOf(".") !== -1) return low.slice(7);
  const g = low.split(":");
  if (g.length === 8) {
    let mapped = __sbParseHex(g[5]) === 0xffff;
    for (let i = 0; i < 5; i++) if (__sbParseHex(g[i] || "0") !== 0) mapped = false;
    if (mapped) {
      const hi = __sbParseHex(g[6] || "0");
      const lo = __sbParseHex(g[7] || "0");
      if (hi >= 0 && lo >= 0) {
        return ((hi / 256) | 0) + "." + (hi & 0xff) + "." + ((lo / 256) | 0) + "." + (lo & 0xff);
      }
    }
  }
  return s;
}
function __sbTrim(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}
function __sbSplitList(raw) {
  const out = [];
  const parts = String(raw || "").split(",");
  for (let i = 0; i < parts.length; i++) {
    const v = __sbTrim(parts[i]);
    if (v) out.push(v);
  }
  return out;
}
function __sbIpToLong(ip) {
  const p = String(ip).split(".");
  if (p.length !== 4) return -1;
  let n = 0;
  for (let i = 0; i < 4; i++) {
    if (p[i] === "" || p[i].length > 3) return -1;
    const o = Number(p[i]);
    if (!(o >= 0 && o <= 255) || o !== (o | 0)) return -1;
    n = n * 256 + o;
  }
  return n;
}
function __sbIpInCidr(ip, cidr) {
  const slash = cidr.indexOf("/");
  if (slash === -1) return ip === cidr; // bare IP: exact match, covers IPv6
  const addr = __sbIpToLong(ip);
  const base = __sbIpToLong(cidr.slice(0, slash));
  const bits = Number(cidr.slice(slash + 1));
  if (addr < 0 || base < 0 || !(bits >= 0 && bits <= 32)) return false;
  if (bits === 0) return true;
  if (bits === 32) return addr === base;
  // Divide rather than mask: a 32-bit `&` in JS is signed and would miscompare
  // addresses above 2^31.
  const size = Math.pow(2, 32 - bits);
  return Math.floor(addr / size) === Math.floor(base / size);
}
function __sbIpTrusted(ip, list) {
  for (let i = 0; i < list.length; i++) if (__sbIpInCidr(ip, list[i])) return true;
  return false;
}
function __sbClientIp(request) {
  const peer = __sbNormalizeIp(request.headers.get("x-sb-remote-addr") || "");
  const trusted = __sbSplitList(__sbEnv("SB_TRUSTED_PROXIES"));
  if (!trusted.length || !__sbIpTrusted(peer, trusted)) return peer;
  const xff = __sbSplitList(request.headers.get("x-forwarded-for"));
  for (let i = xff.length - 1; i >= 0; i--) {
    const hop = __sbNormalizeIp(xff[i]);
    if (!__sbIpTrusted(hop, trusted)) return hop;
  }
  return peer;
}

// #57 — ctx.waitUntil: work that must run before the turn completes but must
// not block the response the handler already built. `waitUntil(p)` just
// records `p`; nothing awaits it until the handler itself has returned.
//
// The wall-clock cap #25 was meant to gate this on turned out not to apply:
// #25 was per-tenant abuse control (rate limits, cgroup isolation against a
// hostile *other* caller) and was closed as not-planned — this deployment
// model is single-admin, nobody else's handler to isolate from. A drain that
// never lets go of the worker slot is a local bug either way, so it gets its
// own timeout rather than waiting on that. Kept under the edge's own
// `SPROUTBOAT_REQUEST_TIMEOUT_MS` (30s default, services/edge/src/main.ts) so
// the sprout still gets to answer before the edge gives up on it.
//
// ponytail: drained sequentially, one timeout for the whole batch (not one
// per task — N tasks should not cost N timeouts). A task still running past
// the cap keeps running; nothing here can cancel a promise it didn't create.
// No Promise.all (unproven in this runtime, sequential is fine at this
// volume). A rejected task is swallowed rather than failing the response:
// dropping a background task's error beats dropping the response it doesn't
// own.
const __SB_WAITUNTIL_TIMEOUT_MS = 25000;

function __sbTimeout(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function __sbDrainWaitUntil(tasks) {
  if (!tasks.length) return;
  const pending = tasks.splice(0, tasks.length);
  await Promise.race([__sbDrainAll(pending), __sbTimeout(__SB_WAITUNTIL_TIMEOUT_MS)]);
}

async function __sbDrainAll(pending) {
  for (let i = 0; i < pending.length; i++) {
    try {
      await pending[i];
    } catch {
      /* a background task's rejection must not fail the response */
    }
  }
}

// Tail-called from `__sbEntry`/DO dispatch so the promise this returns is the
// one *this* async function creates, not a `.then()` derived from someone
// else's — see the note below on why that distinction matters here.
async function __sbFetchWithDrain(res, tasks) {
  let r;
  try {
    r = res && __sbIsFn(res.then) ? await res : res;
  } catch {
    // #179 — a rejected handler promise must not take the process down with it.
    r = __sbErrorResponse();
  }
  await __sbDrainWaitUntil(tasks);
  return r;
}

// #179 — turn an uncaught handler exception into a 500 instead of letting it
// propagate past __sbEntry and crash the whole server.
function __sbErrorResponse() {
  return new Response("Internal Server Error", { status: 500 });
}

// Shared by alarm and scheduled: both reply with an empty 204 once their
// handler (and anything it queued via `waitUntil`) has settled.
async function __sb204WithDrain(res, tasks) {
  try {
    if (res && __sbIsFn(res.then)) await res;
  } catch {
    // #179 — same rule as fetch: a rejected scheduled/alarm promise must not crash the process.
  }
  await __sbDrainWaitUntil(tasks);
  return new Response("", { status: 204 });
}

async function __sbQueueWithDrain(result, tasks) {
  const r = result && __sbIsFn(result.then) ? await result : result;
  await __sbDrainWaitUntil(tasks);
  return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
}

globalThis.__sbEntry = function (handlers, request) {
  const trigger = request.headers.get("x-sb-trigger");
  if (!trigger) {
    // #163 — expose the resolved client IP the Workers way, before the handler runs.
    const __cf = request.cf || {};
    __cf.clientIp = __sbClientIp(request);
    request.cf = __cf;
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
    const __sbTasks = [];
    const ctx = {
      waitUntil(p) {
        if (p && __sbIsFn(p.then)) __sbTasks.push(p);
      },
    };
    let __res;
    try {
      __res = handlers.fetch(request, ctx);
    } catch {
      // #179 — a synchronous throw anywhere in the handler must not take the
      // whole process (and every other in-flight request) down with it.
      return __sbErrorResponse();
    }
    // Same promise-identity rule as above applies to `__sbFetchWithDrain`'s
    // own return, which is why it's tail-called rather than chained on here.
    if (__sbTasks.length || (__res && __sbIsFn(__res.then))) return __sbFetchWithDrain(__res, __sbTasks);
    return __sbTagCpu(__res, __t0);
  }
  if (!__sbTriggerAuthed(request)) return new Response("forbidden", { status: 403 });

  if (trigger === "scheduled") {
    if (!__sbIsFn(handlers.scheduled)) return new Response("no scheduled handler", { status: 404 });
    const body = __sbReadJson(request);
    // #171 — ctx.waitUntil, same shape as fetch's. Was also fire-and-forget
    // before this: an async `scheduled()`'s own promise was dropped the
    // moment 204 went out, same bug alarm() had.
    const __sbTasks = [];
    const ctx = {
      waitUntil(p) {
        if (p && __sbIsFn(p.then)) __sbTasks.push(p);
      },
    };
    let __sres;
    try {
      __sres = handlers.scheduled(
        { cron: body.cron || "", scheduledTime: body.scheduledTime || Date.now(), noRetry() {} },
        ctx,
      );
    } catch {
      // #179 — same rule as fetch: don't let a throw here crash the process.
      return new Response("", { status: 204 });
    }
    if (__sbTasks.length || (__sres && __sbIsFn(__sres.then))) return __sb204WithDrain(__sres, __sbTasks);
    return new Response("", { status: 204 });
  }

  if (trigger === "queue") {
    if (!__sbIsFn(handlers.queue)) return new Response("no queue handler", { status: 404 });
    // #171 — same ctx.waitUntil shape. `__sbRunQueueBatch` was also
    // fire-and-forget for an async `queue()`: it computed the default
    // ack/retry and answered the broker before the handler's own awaits ran,
    // so any ack()/retry() past the first `await` never made it into the
    // response. It now awaits the handler itself when it returns a promise.
    const __sbTasks = [];
    const ctx = {
      waitUntil(p) {
        if (p && __sbIsFn(p.then)) __sbTasks.push(p);
      },
    };
    // Always a promise now (`__sbRunQueueBatch` is async, to await the
    // handler above), so always tail-call the drain wrapper — same
    // promise-identity reasoning as `__sbFetchWithDrain`.
    return __sbQueueWithDrain(__sbRunQueueBatch(handlers, __sbReadJson(request), ctx), __sbTasks);
  }

  if (trigger === "alarm") {
    const body = __sbReadJson(request);
    const inst = __sbGetDOInstance(String(body.cls || ""), String(body.id || ""));
    if (!__sbIsFn(inst.alarm)) return new Response("no alarm handler", { status: 404 });
    let __ares;
    try {
      __ares = inst.alarm();
    } catch {
      // #179 — same rule as fetch: don't let a throw here crash the process.
      return new Response("", { status: 204 });
    }
    // Was fire-and-forget before: an async `alarm()` and any `state.waitUntil()`
    // it queued were both dropped the moment 204 went out. Await both.
    if (inst.__sbTasks.length || (__ares && __sbIsFn(__ares.then))) return __sb204WithDrain(__ares, inst.__sbTasks);
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
async function __sbRunQueueBatch(handlers, body, ctx) {
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
  try {
    const __qres = handlers.queue(batch, ctx);
    // Was fire-and-forget: an async `queue()` had this default-ack pass run (and
    // the response go out) before its own `await`s did, so any ack()/retry()
    // past the first one never counted.
    if (__qres && __sbIsFn(__qres.then)) await __qres;
  } catch {
    // #179 — a throw here must not crash the process. Whatever ack()/retry()
    // calls the handler made before throwing still count; anything it never
    // touched falls through to the default-ack pass below, same as a handler
    // that returns without calling ack()/retry() on every message.
  }
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
