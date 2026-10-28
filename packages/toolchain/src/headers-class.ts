/**
 * The Headers class patchHeadersClass puts into Porffor's runtime/fetch-globals.js. Porffor's
 * kept the first value for get() (append("a", "1"), append("a", "2") then get("a") gave
 * "1"), iterated in insertion order, had no getSetCookie, and accepted any name or value
 * unvalidated and untrimmed. Found by sproutd's W2 conformance suite against workerd.
 *
 * Storage stays Porffor's: `_entries` holds each appended name (lowercased) and value in
 * order, flat, because the native response writer reads it, and each Set-Cookie must reach
 * the wire as its own header. The Fetch spec's combined, sorted view is computed on read.
 *
 * `_immutable`, when the runtime sets it, makes append, set and delete throw as workerd's
 * immutable guard does (an incoming request's headers, a fetched response's). The runtime
 * sets it from compatibility date 2026-10-23; a copy (`new Headers(h)`) is always mutable.
 */
// The native checks below sit inside Porffor.c${BT}...${BT} blocks: this is a template literal, so the
// backtick is interpolated.
const BT = "`";
export const HEADERS_CLASS_SOURCE = String.raw`class Headers {
  // sproutboat: Fetch-spec Headers
  constructor(init = undefined) {
    this._entries = Porffor.array.new(8);
    if (init == null) return;
    if (init instanceof Headers) {
      for (let i = 0; i < init._entries.length; i += 2) this._push(init._entries[i], init._entries[i + 1]);
      return;
    }
    if (typeof init != 'object') throw new TypeError('Headers: init must be an object, an array of pairs or Headers');
    if (Array.isArray(init) || typeof init[Symbol.iterator] == 'function') {
      for (const entry of init) {
        if (!entry || entry.length != 2) throw new TypeError('Headers: each pair must have exactly two items');
        this.append(entry[0], entry[1]);
      }
      return;
    }
    for (const key in init) this.append(key, init[key]);
  }

  // 1: a valid name with no capital letter (the common case, and its own lowercase), 2: valid with a
  // capital letter, 0: invalid, -1: not a plain string (the regular expression decides).
  static _nameKind(s) {
    let kind = -1;
    Porffor.c${BT}
      if (s.type == 195) {
        const u32 __p = (u32)s.val;
        const size_t __n = (size_t)*(u32*)(MEM + __p);
        const unsigned char* __x = (const unsigned char*)(MEM + __p + 4);
        int __up = 0, __bad = __n == 0;
        for (size_t __i = 0; __i < __n && !__bad; __i++) {
          const unsigned char __c = __x[__i];
          if (__c >= 'a' && __c <= 'z') continue;
          if (__c >= 'A' && __c <= 'Z') __up = 1;
          else if ((__c >= '0' && __c <= '9') || (__c && __c < 128 && strchr("!#$%&'*+-.^_\x60|~", __c))) continue;
          else __bad = 1;
        }
        kind = (f64)(__bad ? 0 : __up ? 2 : 1);
      }
    ${BT};
    return kind;
  }

  static _name(name) {
    const s = String(name);
    const kind = Headers._nameKind(s);
    if (kind === 1) return s;
    if (kind === 2) return s.toLowerCase();
    if (kind === 0 || !/^[!#$%&'*+\-.^_\x60|~0-9A-Za-z]+$/.test(s)) throw new TypeError('Invalid header name: ' + s);
    return s.toLowerCase();
  }

  // 1: nothing to trim and nothing forbidden (the value as it is), 0: trim or check it in JS.
  static _valueClean(s) {
    let clean = 0;
    Porffor.c${BT}
      if (s.type == 195) {
        const u32 __p = (u32)s.val;
        const size_t __n = (size_t)*(u32*)(MEM + __p);
        const unsigned char* __x = (const unsigned char*)(MEM + __p + 4);
        int __ok = 1;
        if (__n) {
          const unsigned char __f = __x[0], __l = __x[__n - 1];
          if (__f == 32 || __f == 9 || __f == 10 || __f == 13 || __l == 32 || __l == 9 || __l == 10 || __l == 13) __ok = 0;
        }
        for (size_t __i = 0; __i < __n && __ok; __i++) if (__x[__i] == 0 || __x[__i] == 10 || __x[__i] == 13) __ok = 0;
        clean = (f64)__ok;
      }
    ${BT};
    return clean;
  }

  static _value(value) {
    let s = String(value);
    if (Headers._valueClean(s) === 1) return s;
    let start = 0, end = s.length;
    while (start < end && (s.charCodeAt(start) == 32 || s.charCodeAt(start) == 9 || s.charCodeAt(start) == 10 || s.charCodeAt(start) == 13)) start++;
    while (end > start && (s.charCodeAt(end - 1) == 32 || s.charCodeAt(end - 1) == 9 || s.charCodeAt(end - 1) == 10 || s.charCodeAt(end - 1) == 13)) end--;
    s = s.slice(start, end);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c == 0 || c == 10 || c == 13) throw new TypeError('Invalid header value');
    }
    return s;
  }

  _push(name, value) {
    Porffor.array.fastPush(this._entries, name);
    Porffor.array.fastPush(this._entries, value);
  }

  _writable() {
    if (this._immutable === true) throw new TypeError("Can't modify immutable headers.");
  }

  append(name, value) {
    this._writable();
    this._push(Headers._name(name), Headers._value(value));
  }

  delete(name) {
    this._writable();
    const normalized = Headers._name(name);
    const next = Porffor.array.new(this._entries.length);
    for (let i = 0; i < this._entries.length; i += 2) {
      if (this._entries[i] == normalized) continue;
      Porffor.array.fastPush(next, this._entries[i]);
      Porffor.array.fastPush(next, this._entries[i + 1]);
    }
    this._entries = next;
  }

  get(name) {
    const normalized = Headers._name(name);
    let out = null;
    for (let i = 0; i < this._entries.length; i += 2) {
      if (this._entries[i] != normalized) continue;
      out = out == null ? this._entries[i + 1] : out + ', ' + this._entries[i + 1];
    }
    return out;
  }

  getSetCookie() {
    const out = [];
    for (let i = 0; i < this._entries.length; i += 2) if (this._entries[i] == 'set-cookie') out.push(this._entries[i + 1]);
    return out;
  }

  has(name) {
    const normalized = Headers._name(name);
    for (let i = 0; i < this._entries.length; i += 2) if (this._entries[i] == normalized) return true;
    return false;
  }

  set(name, value) {
    this._writable();
    const normalized = Headers._name(name), v = Headers._value(value);
    this.delete(normalized);
    this._push(normalized, v);
  }

  // The spec's sort-and-combine: names ascending, values joined with ", ", except
  // set-cookie, which is listed once per value.
  _sorted() {
    const names = [];
    for (let i = 0; i < this._entries.length; i += 2) if (!names.includes(this._entries[i])) names.push(this._entries[i]);
    names.sort();
    const out = [];
    for (const name of names) {
      if (name == 'set-cookie') {
        for (const value of this.getSetCookie()) out.push([name, value]);
      } else out.push([name, this.get(name)]);
    }
    return out;
  }

  entries() { return this._sorted(); }
  keys() { return this._sorted().map((pair) => pair[0]); }
  values() { return this._sorted().map((pair) => pair[1]); }
  forEach(callback, thisArg = undefined) {
    for (const pair of this._sorted()) callback.call(thisArg, pair[1], pair[0], this);
  }
}
`;
