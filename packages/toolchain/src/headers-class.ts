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

  static _name(name) {
    const s = String(name);
    if (!/^[!#$%&'*+\-.^_\x60|~0-9A-Za-z]+$/.test(s)) throw new TypeError('Invalid header name: ' + s);
    return s.toLowerCase();
  }

  static _value(value) {
    let s = String(value);
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
