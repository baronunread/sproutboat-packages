// Vendored source: the web classes of the standalone build.
//
// What it is: Porffor alpha 19's runtime/fetch-globals.js with sproutboat's seven class patches applied
// (@sproutboat/toolchain 0.26.1, patch fingerprint d9f485cffe3c, upstream 0c135ce), minus its four
// C-timer functions (the standalone preamble's table replaces them), each class then assigned on globalThis so
// that on alpha 22+ every free reference binds program-wide (P4).
//
// Why it is here: the standalone prelude composes these classes (standalone.ts). It used to acquire a whole
// patched alpha 19 tree only to read them. That tree is gone; this file is maintained here, by hand.
// Equivalence: everything after the marker below is byte for byte what the alpha 19 chain produced (sha256 in
// sources.json, "origin").
// ---- end of provenance header ----
// Alpha 19 web classes: Porffor alpha 19's runtime/fetch-globals.js with the toolchain's patches, so the
// live generation's Headers, Request, Response, Blob, File, URL, TextEncoder and TextDecoder are the
// prelude's own on alpha 22 (@sproutboat/toolchain/a21 standalone.ts).
globalThis.crypto = {};

class Headers {
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
    Porffor.c`
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
    `;
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
    Porffor.c`
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
    `;
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


class Blob {
  // sproutboat: byte-backed Blob and File
  constructor(parts = [], options = undefined) {
    const chunks = [];
    let size = 0;
    for (const part of parts) {
      let bytes;
      if (part instanceof Blob) bytes = part._bytes;
      else if (part instanceof ArrayBuffer) bytes = new Uint8Array(part);
      else if (ArrayBuffer.isView(part)) bytes = new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
      else bytes = new TextEncoder().encode(String(part));
      chunks.push(bytes);
      size += bytes.length;
    }
    this._bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      this._bytes.set(chunk, at);
      at += chunk.length;
    }
    const type = options == null || options.type == null ? '' : String(options.type);
    this._type = /^[\x20-\x7e]*$/.test(type) ? type.toLowerCase() : '';
  }

  get size() { return this._bytes.length; }
  get type() { return this._type; }

  slice(start = 0, end = undefined, contentType = '') {
    const n = this._bytes.length;
    const from = start < 0 ? Math.max(n + start, 0) : Math.min(start, n);
    const to = end === undefined ? n : end < 0 ? Math.max(n + end, 0) : Math.min(end, n);
    const out = new Blob([], { type: contentType });
    out._bytes = this._bytes.slice(from, Math.max(to, from));
    return out;
  }

  arrayBuffer() { return Promise.resolve(this._bytes.slice().buffer); }
  bytes() { return Promise.resolve(this._bytes.slice()); }
  text() { return Promise.resolve(new TextDecoder().decode(this._bytes)); }
  stream() {
    const bytes = this._bytes.slice();
    return new ReadableStream({
      start(controller) {
        if (bytes.length > 0) controller.enqueue(bytes);
        controller.close();
      },
    });
  }
}

class File extends Blob {
  constructor(bits, name, options = undefined) {
    super(bits, options);
    this.name = String(name);
    this.lastModified = options != null && options.lastModified != null ? Number(options.lastModified) : Date.now();
  }
}

class TextEncoder {
  // sb_text_encoder_scalar_v1
  get encoding() { return 'utf-8'; }
  encode(input = '') {
    const text = String(input);
    // Two C passes (size, then fill) for a string; the JS loops below stay for anything else.
    let size = -1;
    let bytes = null;
    let filled = 0;
    Porffor.c`
      if (text.type == 195 || text.type == 67) {
        const int __wide = text.type == 67;
        const size_t __len = (size_t)*(u32*)(MEM + (u32)text.val);
        const unsigned char* __s = (const unsigned char*)(MEM + (u32)text.val + 4);
        unsigned char* __o = 0;
        
        size_t __k = 0;
        for (size_t __i = 0; __i < __len; __i++) {
          uint32_t __c = __wide ? (uint32_t)((const uint16_t*)__s)[__i] : (uint32_t)__s[__i];
          if (__c < 0x80) { if (__o) __o[__k] = (unsigned char)__c; __k += 1; continue; }
          if (__c < 0x800) {
            if (__o) { __o[__k] = (unsigned char)(0xc0 | (__c >> 6)); __o[__k + 1] = (unsigned char)(0x80 | (__c & 0x3f)); }
            __k += 2; continue;
          }
          if (__c >= 0xd800 && __c <= 0xdbff && __i + 1 < __len) {
            const uint32_t __d = (uint32_t)((const uint16_t*)__s)[__i + 1];
            if (__d >= 0xdc00 && __d <= 0xdfff) {
              const uint32_t __cp = 0x10000 + ((__c - 0xd800) << 10) + (__d - 0xdc00);
              if (__o) {
                __o[__k] = (unsigned char)(0xf0 | (__cp >> 18)); __o[__k + 1] = (unsigned char)(0x80 | ((__cp >> 12) & 0x3f));
                __o[__k + 2] = (unsigned char)(0x80 | ((__cp >> 6) & 0x3f)); __o[__k + 3] = (unsigned char)(0x80 | (__cp & 0x3f));
              }
              __k += 4; __i++; continue;
            }
          }
          if (__c >= 0xd800 && __c <= 0xdfff) __c = 0xfffd;
          if (__o) {
            __o[__k] = (unsigned char)(0xe0 | (__c >> 12)); __o[__k + 1] = (unsigned char)(0x80 | ((__c >> 6) & 0x3f));
            __o[__k + 2] = (unsigned char)(0x80 | (__c & 0x3f));
          }
          __k += 3;
        }
        size = (f64)__k;
      }
    `;
    if (size === 0) return new Uint8Array(0);
    if (size > 0) {
      bytes = new Uint8Array(size);
      Porffor.c`
        if (bytes.type == 81 && *(int32_t*)(MEM + (u32)bytes.val) == (int32_t)size) {
          const int __wide = text.type == 67;
          const size_t __len = (size_t)*(u32*)(MEM + (u32)text.val);
          const unsigned char* __s = (const unsigned char*)(MEM + (u32)text.val + 4);
          unsigned char* __o = MEM + *(u32*)(MEM + (u32)bytes.val + 4) + 4;
          
        size_t __k = 0;
        for (size_t __i = 0; __i < __len; __i++) {
          uint32_t __c = __wide ? (uint32_t)((const uint16_t*)__s)[__i] : (uint32_t)__s[__i];
          if (__c < 0x80) { if (__o) __o[__k] = (unsigned char)__c; __k += 1; continue; }
          if (__c < 0x800) {
            if (__o) { __o[__k] = (unsigned char)(0xc0 | (__c >> 6)); __o[__k + 1] = (unsigned char)(0x80 | (__c & 0x3f)); }
            __k += 2; continue;
          }
          if (__c >= 0xd800 && __c <= 0xdbff && __i + 1 < __len) {
            const uint32_t __d = (uint32_t)((const uint16_t*)__s)[__i + 1];
            if (__d >= 0xdc00 && __d <= 0xdfff) {
              const uint32_t __cp = 0x10000 + ((__c - 0xd800) << 10) + (__d - 0xdc00);
              if (__o) {
                __o[__k] = (unsigned char)(0xf0 | (__cp >> 18)); __o[__k + 1] = (unsigned char)(0x80 | ((__cp >> 12) & 0x3f));
                __o[__k + 2] = (unsigned char)(0x80 | ((__cp >> 6) & 0x3f)); __o[__k + 3] = (unsigned char)(0x80 | (__cp & 0x3f));
              }
              __k += 4; __i++; continue;
            }
          }
          if (__c >= 0xd800 && __c <= 0xdfff) __c = 0xfffd;
          if (__o) {
            __o[__k] = (unsigned char)(0xe0 | (__c >> 12)); __o[__k + 1] = (unsigned char)(0x80 | ((__c >> 6) & 0x3f));
            __o[__k + 2] = (unsigned char)(0x80 | (__c & 0x3f));
          }
          __k += 3;
        }
          filled = (f64)1;
        }
      `;
      if (filled === 1) return bytes;
    }
    let length = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { length += 4; i++; }
      else length += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    }
    const out = new Uint8Array(length);
    this.encodeInto(text, out);
    return out;
  }
  encodeInto(source, destination) {
    const text = String(source);
    let read = 0;
    let written = 0;
    while (read < text.length) {
      let cp = text.charCodeAt(read);
      let units = 1;
      if (cp >= 0xd800 && cp <= 0xdbff && read + 1 < text.length && text.charCodeAt(read + 1) >= 0xdc00 && text.charCodeAt(read + 1) <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + text.charCodeAt(read + 1) - 0xdc00;
        units = 2;
      } else if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
      const count = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      if (written + count > destination.length) break;
      if (count === 1) destination[written++] = cp;
      else if (count === 2) {
        destination[written++] = 0xc0 | (cp >> 6);
        destination[written++] = 0x80 | (cp & 0x3f);
      } else if (count === 3) {
        destination[written++] = 0xe0 | (cp >> 12);
        destination[written++] = 0x80 | ((cp >> 6) & 0x3f);
        destination[written++] = 0x80 | (cp & 0x3f);
      } else {
        destination[written++] = 0xf0 | (cp >> 18);
        destination[written++] = 0x80 | ((cp >> 12) & 0x3f);
        destination[written++] = 0x80 | ((cp >> 6) & 0x3f);
        destination[written++] = 0x80 | (cp & 0x3f);
      }
      read += units;
    }
    return { read, written };
  }
}

class TextDecoder {
  // sproutboat: WHATWG UTF-8 decoder, also UTF-16LE/BE and windows-1252
  constructor(label = 'utf-8', options = undefined) {
    const name = String(label).trim().toLowerCase();
    let encoding = '';
    if (name == 'utf-8' || name == 'utf8' || name == 'unicode-1-1-utf-8' || name == 'unicode11utf8' || name == 'unicode20utf8' || name == 'x-unicode20utf8') encoding = 'utf-8';
    else if (name == 'utf-16le' || name == 'utf-16' || name == 'ucs-2' || name == 'unicode' || name == 'csunicode' || name == 'iso-10646-ucs-2' || name == 'unicodefeff') encoding = 'utf-16le';
    else if (name == 'utf-16be' || name == 'unicodefffe') encoding = 'utf-16be';
    else if (name == 'windows-1252' || name == 'ascii' || name == 'us-ascii' || name == 'ansi_x3.4-1968' || name == 'cp1252' || name == 'x-cp1252' || name == 'cp819' || name == 'ibm819' || name == 'iso-8859-1' || name == 'iso8859-1' || name == 'iso88591' || name == 'iso_8859-1' || name == 'iso_8859-1:1987' || name == 'iso-ir-100' || name == 'csisolatin1' || name == 'l1' || name == 'latin1') encoding = 'windows-1252';
    else throw new RangeError('TextDecoder: unsupported encoding ' + label);
    this.encoding = encoding;
    this._lead = -1;
    this._odd = -1;
    this.fatal = !!(options && options.fatal);
    this.ignoreBOM = !!(options && options.ignoreBOM);
    this._pending = [];
    this._started = false;
  }

  decode(input = undefined, options = undefined) {
    const stream = !!(options && options.stream);
    let view;
    if (input == null) view = new Uint8Array(0);
    else if (input instanceof ArrayBuffer) view = new Uint8Array(input);
    else if (ArrayBuffer.isView(input)) view = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    else throw new TypeError('TextDecoder.decode: input must be an ArrayBuffer or a view of one');
    if (this.encoding == 'windows-1252') return this._decode1252(view);
    if (this.encoding != 'utf-8') return this._decode16(view, stream);
    let bytes = view;
    if (this._pending.length > 0) {
      bytes = new Uint8Array(this._pending.length + view.length);
      for (let i = 0; i < this._pending.length; i++) bytes[i] = this._pending[i];
      bytes.set(view, this._pending.length);
      this._pending = [];
    }
    const n = bytes.length;
    let out = '';
    let i = 0;
    while (i < n) {
      const a = bytes[i];
      let cp = -1;
      let next = i + 1;
      if (a < 0x80) cp = a;
      else {
        let need = 0, lower = 0x80, upper = 0xbf;
        if (a >= 0xc2 && a <= 0xdf) { need = 1; cp = a & 0x1f; }
        else if (a >= 0xe0 && a <= 0xef) { need = 2; cp = a & 0x0f; if (a == 0xe0) lower = 0xa0; if (a == 0xed) upper = 0x9f; }
        else if (a >= 0xf0 && a <= 0xf4) { need = 3; cp = a & 0x07; if (a == 0xf0) lower = 0x90; if (a == 0xf4) upper = 0x8f; }
        if (need == 0) cp = -1;
        else {
          let k = 0;
          while (k < need) {
            if (next >= n) break;
            const c = bytes[next];
            if (c < lower || c > upper) break;
            lower = 0x80; upper = 0xbf;
            cp = (cp << 6) | (c & 0x3f);
            next++; k++;
          }
          if (k < need) {
            if (next >= n && stream) {
              // An incomplete sequence at the end of a chunk waits for the next one.
              for (let j = i; j < n; j++) this._pending.push(bytes[j]);
              break;
            }
            cp = -1;
          }
        }
      }
      if (cp < 0) {
        if (this.fatal) {
          this._pending = [];
          this._started = false;
          throw new TypeError('The encoded data was not valid utf-8');
        }
        cp = 0xfffd;
      }
      if (!this._started) {
        this._started = true;
        if (cp == 0xfeff && !this.ignoreBOM) { i = next; continue; }
      }
      if (cp > 0xffff) {
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      } else out += String.fromCharCode(cp);
      i = next;
    }
    if (!stream) {
      this._pending = [];
      this._started = false;
    }
    return out;
  }

  _decode1252(view) {
    const high = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];
    let out = '';
    for (let i = 0; i < view.length; i++) {
      const b = view[i];
      out += String.fromCharCode(b >= 0x80 && b < 0xa0 ? high[b - 0x80] : b);
    }
    return out;
  }

  _decode16(view, stream) {
    const be = this.encoding == 'utf-16be';
    let out = '';
    let at = 0;
    const n = view.length;
    while (at < n) {
      let unit;
      if (this._odd >= 0) {
        unit = be ? (this._odd << 8) | view[at] : (view[at] << 8) | this._odd;
        at++;
        this._odd = -1;
      } else {
        if (at + 1 >= n) { this._odd = view[at]; at++; break; }
        unit = be ? (view[at] << 8) | view[at + 1] : (view[at + 1] << 8) | view[at];
        at += 2;
      }
      if (this._lead >= 0) {
        const lead = this._lead;
        this._lead = -1;
        if (unit >= 0xdc00 && unit <= 0xdfff) {
          out += String.fromCharCode(lead, unit);
          continue;
        }
        if (this.fatal) { this._reset16(); throw new TypeError('The encoded data was not valid ' + this.encoding); }
        out += '\ufffd';
      }
      if (unit >= 0xd800 && unit <= 0xdbff) { this._lead = unit; continue; }
      if (unit >= 0xdc00 && unit <= 0xdfff) {
        if (this.fatal) { this._reset16(); throw new TypeError('The encoded data was not valid ' + this.encoding); }
        out += '\ufffd';
        continue;
      }
      if (!this._started) {
        this._started = true;
        if (unit == 0xfeff && !this.ignoreBOM) continue;
      }
      out += String.fromCharCode(unit);
    }
    if (n > 0) this._started = true;
    if (!stream) {
      const dangling = this._lead >= 0 || this._odd >= 0;
      this._reset16();
      if (dangling) {
        if (this.fatal) throw new TypeError('The encoded data was not valid ' + this.encoding);
        out += '\ufffd';
      }
    }
    return out;
  }

  _reset16() {
    this._lead = -1;
    this._odd = -1;
    this._started = false;
  }
}

class URL {
  // sproutboat: WHATWG-style URL. Porffor's had href/origin/pathname/search only, no
  // setters but pathname, no base argument, no hash.
  constructor(input, base = undefined) {
    const raw = input != null && typeof input == 'object' && input.href != null ? String(input.href) : String(input);
    if (this._parse(raw)) return;
    if (base == null) throw new TypeError('Invalid URL: ' + raw);
    this._resolve(raw.trim(), base instanceof URL ? base : new URL(base));
  }

  static _defaultPort(protocol) {
    if (protocol == 'http:' || protocol == 'ws:') return '80';
    if (protocol == 'https:' || protocol == 'wss:') return '443';
    if (protocol == 'ftp:') return '21';
    return '';
  }

  static canParse(input, base = undefined) {
    try {
      new URL(input, base);
      return true;
    } catch (e) {
      return false;
    }
  }

  _clear() {
    this._username = '';
    this._password = '';
    this._hostname = '';
    this._port = '';
    this._pathname = '';
    this._query = null;
    this._fragment = null;
    this._params = null;
  }

  // Splits off the fragment and the query (null when absent, '' when empty); returns the rest.
  _splitTail(rest) {
    const hashAt = rest.indexOf('#');
    this._fragment = hashAt == -1 ? null : URL._escape(rest.slice(hashAt + 1));
    if (hashAt != -1) rest = rest.slice(0, hashAt);
    const queryAt = rest.indexOf('?');
    this._query = queryAt == -1 ? null : URL._escape(rest.slice(queryAt + 1), this._isSpecial());
    if (queryAt != -1) rest = rest.slice(0, queryAt);
    return rest;
  }

  // false when raw has no scheme (a relative reference).
  _parse(raw) {
    raw = raw.trim();
    const first = raw.charCodeAt(0);
    if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122))) return false;
    let i = 1;
    while (i < raw.length) {
      const c = raw.charCodeAt(i);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c == 43 || c == 45 || c == 46) i++;
      else break;
    }
    if (raw.charCodeAt(i) != 58) return false;
    this._clear();
    this._protocol = raw.slice(0, i + 1).toLowerCase();
    let rest = this._splitTail(raw.slice(i + 1));
    if (rest.startsWith('//')) {
      rest = rest.slice(2);
      let end = rest.indexOf('/');
      if (end == -1) end = rest.length;
      this._setAuthority(rest.slice(0, end));
      if (this._hostname == '' && this._protocol != 'file:') throw new TypeError('Invalid URL: ' + raw);
      this._pathname = URL._path(rest.slice(end) || '/');
    } else if (this._isSpecial()) {
      throw new TypeError('Invalid URL: ' + raw);
    } else {
      this._pathname = rest;
    }
    return true;
  }

  _isSpecial() {
    const p = this._protocol;
    return p == 'http:' || p == 'https:' || p == 'ws:' || p == 'wss:' || p == 'ftp:' || p == 'file:';
  }

  _resolve(raw, base) {
    if (raw.startsWith('//')) {
      if (!this._parse(base._protocol + raw)) throw new TypeError('Invalid URL: ' + raw);
      return;
    }
    this._clear();
    this._protocol = base._protocol;
    this._username = base._username;
    this._password = base._password;
    this._hostname = base._hostname;
    this._port = base._port;
    const path = this._splitTail(raw);
    if (path == '') {
      this._pathname = base._pathname;
      if (raw.indexOf('?') == -1) this._query = base._query;
    } else if (path.startsWith('/')) {
      this._pathname = URL._path(path);
    } else {
      const dir = base._pathname.slice(0, base._pathname.lastIndexOf('/') + 1);
      this._pathname = URL._path(dir + path);
    }
  }

  _setAuthority(auth) {
    const at = auth.lastIndexOf('@');
    if (at != -1) {
      const info = auth.slice(0, at);
      const colon = info.indexOf(':');
      this._username = colon == -1 ? info : info.slice(0, colon);
      this._password = colon == -1 ? '' : info.slice(colon + 1);
      auth = auth.slice(at + 1);
    }
    this._setHost(auth);
  }

  _setHost(host) {
    const close = host.charCodeAt(0) == 91 ? host.indexOf(']') : -1;
    const colon = host.indexOf(':', close == -1 ? 0 : close);
    this._hostname = URL._toASCII((colon == -1 ? host : host.slice(0, colon)).toLowerCase());
    if (colon != -1) this.port = host.slice(colon + 1);
  }

  // An internationalized host in its ASCII form: each non-ASCII label as xn-- plus its
  // Punycode (RFC 3492), as fetch and DNS need it. Lowercased first; no full UTS 46 mapping.
  static _toASCII(host) {
    if (host.charCodeAt(0) == 91) return host;
    let ascii = true;
    for (let i = 0; i < host.length; i++) if (host.charCodeAt(i) > 127) { ascii = false; break; }
    if (ascii) return host;
    const labels = host.split('.');
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      for (let j = 0; j < label.length; j++) if (label.charCodeAt(j) > 127) { labels[i] = 'xn--' + URL._punycode(label); break; }
    }
    return labels.join('.');
  }

  static _punycode(input) {
    const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
    const points = [];
    for (let i = 0; i < input.length; i++) {
      const c = input.codePointAt(i);
      points.push(c);
      if (c > 0xffff) i++;
    }
    let out = '';
    for (let i = 0; i < points.length; i++) if (points[i] < 0x80) out += String.fromCharCode(points[i]);
    const basic = out.length;
    let handled = basic;
    if (basic > 0) out += '-';
    const digit = (d) => String.fromCharCode(d < 26 ? d + 97 : d + 22);
    const adapt = (delta, count, first) => {
      delta = first ? Math.floor(delta / damp) : delta >> 1;
      delta += Math.floor(delta / count);
      let k = 0;
      while (delta > ((base - tMin) * tMax) >> 1) { delta = Math.floor(delta / (base - tMin)); k += base; }
      return k + Math.floor(((base - tMin + 1) * delta) / (delta + skew));
    };
    let n = 128, delta = 0, bias = 72;
    while (handled < points.length) {
      let m = 0x110000;
      for (let i = 0; i < points.length; i++) if (points[i] >= n && points[i] < m) m = points[i];
      delta += (m - n) * (handled + 1);
      n = m;
      for (let i = 0; i < points.length; i++) {
        const c = points[i];
        if (c < n) delta++;
        if (c == n) {
          let q = delta;
          for (let k = base; ; k += base) {
            const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
            if (q < t) break;
            out += digit(t + ((q - t) % (base - t)));
            q = Math.floor((q - t) / (base - t));
          }
          out += digit(q);
          bias = adapt(delta, handled + 1, handled == basic);
          delta = 0;
          handled++;
        }
      }
      delta++;
      n++;
    }
    return out;
  }

  // Dot segments resolved, spaces escaped.
  static _path(p) {
    p = URL._escape(p, false, true);
    if (p.indexOf('.') == -1 && p.indexOf('%2') == -1) return p;
    const parts = p.split('/');
    const out = [];
    for (let i = 1; i < parts.length; i++) {
      const s = parts[i];
      const last = i == parts.length - 1;
      const l = s.toLowerCase();
      if (l == '.' || l == '%2e') {
        if (last) out.push('');
      } else if (l == '..' || l == '.%2e' || l == '%2e.' || l == '%2e%2e') {
        if (out.length > 0) out.pop();
        if (last) out.push('');
      } else {
        out.push(s);
      }
    }
    return '/' + out.join('/');
  }

  // The WHATWG percent-encode sets that matter here: C0 controls, space, " < > and backtick, non-ASCII;
  // plus ' in a query, { } in a path. Existing %XX sequences stay as they are.
  static _escape(s, query = false, path = false) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c <= 32 || c == 34 || c == 60 || c == 62 || c == 96 || c == 127 || (query && c == 39) || (path && (c == 123 || c == 125))) {
        out += '%' + (c < 16 ? '0' : '') + c.toString(16).toUpperCase();
      } else if (c > 127) {
        const pair = c >= 0xd800 && c <= 0xdbff && i + 1 < s.length;
        out += encodeURIComponent(pair ? s.slice(i, i + 2) : s[i]);
        if (pair) i++;
      } else {
        out += s[i];
      }
    }
    return out;
  }

  get protocol() { return this._protocol; }
  set protocol(value) {
    let v = String(value);
    const colon = v.indexOf(':');
    if (colon != -1) v = v.slice(0, colon);
    if (v == '') return;
    this._protocol = v.toLowerCase() + ':';
    if (this._port == URL._defaultPort(this._protocol)) this._port = '';
  }

  get username() { return this._username; }
  set username(value) { if (this._hostname != '') this._username = URL._escape(String(value)); }
  get password() { return this._password; }
  set password(value) { if (this._hostname != '') this._password = URL._escape(String(value)); }

  get hostname() { return this._hostname; }
  set hostname(value) {
    const v = String(value);
    if (v != '' && this._hostname != '') this._hostname = URL._toASCII(v.toLowerCase());
  }

  get port() { return this._port; }
  set port(value) {
    const v = String(value);
    let digits = '';
    for (let i = 0; i < v.length; i++) {
      const c = v.charCodeAt(i);
      if (c < 48 || c > 57) break;
      digits += v[i];
    }
    if (digits == '' && v != '') return;
    if (digits != '') digits = String(Number(digits));
    if (Number(digits) > 65535) return;
    this._port = digits == URL._defaultPort(this._protocol) ? '' : digits;
  }

  get host() { return this._port == '' ? this._hostname : this._hostname + ':' + this._port; }
  set host(value) {
    const v = String(value);
    if (v != '' && this._hostname != '') this._setHost(v);
  }

  get origin() {
    return this._isSpecial() && this._protocol != 'file:' ? this._protocol + '//' + this.host : 'null';
  }

  get pathname() { return this._pathname; }
  set pathname(value) {
    if (this._hostname == '' && !this._isSpecial()) return;
    const v = String(value);
    this._pathname = URL._path(v.startsWith('/') ? v : '/' + v);
  }

  get search() { return this._query == null || this._query == '' ? '' : '?' + this._query; }
  set search(value) {
    let v = String(value);
    if (v.startsWith('?')) v = v.slice(1);
    this._query = v == '' ? null : URL._escape(v, this._isSpecial());
    if (this._params != null) this._params._reset(this.search);
  }

  get hash() { return this._fragment == null || this._fragment == '' ? '' : '#' + this._fragment; }
  set hash(value) {
    let v = String(value);
    if (v.startsWith('#')) v = v.slice(1);
    this._fragment = v == '' ? null : URL._escape(v);
  }

  get searchParams() {
    if (this._params == null) {
      this._params = new globalThis.URLSearchParams(this.search);
      this._params._url = this;
    }
    return this._params;
  }

  get href() {
    let out = this._protocol;
    if (this._hostname != '' || this._protocol == 'file:') {
      out += '//';
      if (this._username != '' || this._password != '') {
        out += this._username;
        if (this._password != '') out += ':' + this._password;
        out += '@';
      }
      out += this.host;
    }
    out += this._pathname;
    if (this._query != null) out += '?' + this._query;
    if (this._fragment != null) out += '#' + this._fragment;
    return out;
  }
  set href(value) {
    const v = String(value);
    if (!this._parse(v)) throw new TypeError('Invalid URL: ' + v);
  }

  toString() { return this.href; }
  toJSON() { return this.href; }
}

class Request {
  // sproutboat: Fetch-spec Request and Response
  // Body init as Fetch extracts it: URLSearchParams becomes form text, and a text body gets
  // its default content type unless one was given. Statics, shared with Response: plain
  // top-level functions in this file are not visible from class methods.
  static _extractBody(body, headers) {
    // A Blob's bytes, with its type as the content type unless one was given.
    if (body instanceof Blob) {
      if (body.type != '' && !headers.has('content-type')) headers.set('content-type', body.type);
      return body._bytes.slice();
    }
    // FormData as multipart/form-data. The prelude defines FormData and URLSearchParams on
    // globalThis after this file is compiled.
    const Form = Request._form ?? (Request._form = globalThis.FormData);
    if (Form != null && body instanceof Form) {
      const boundary = '----sproutboat' + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
      const encoder = new TextEncoder();
      const parts = [];
      for (const entry of body._entries) {
        const name = String(entry[0]).replace(/"/g, '%22');
        const value = entry[1];
        if (value instanceof Blob) {
          const filename = String(value.name ?? 'blob').replace(/"/g, '%22');
          parts.push(encoder.encode('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"; filename="' + filename + '"\r\nContent-Type: ' + (value.type || 'application/octet-stream') + '\r\n\r\n'));
          parts.push(value._bytes);
          parts.push(encoder.encode('\r\n'));
        } else parts.push(encoder.encode('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + String(value) + '\r\n'));
      }
      parts.push(encoder.encode('--' + boundary + '--\r\n'));
      if (!headers.has('content-type')) headers.set('content-type', 'multipart/form-data; boundary=' + boundary);
      return new Blob(parts)._bytes;
    }
    const Params = Request._params ?? (Request._params = globalThis.URLSearchParams);
    if (Params != null && body instanceof Params) {
      if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
      return body.toString();
    }
    if (typeof body === 'string' && !headers.has('content-type')) headers.set('content-type', 'text/plain;charset=UTF-8');
    return body;
  }

  static _bodyBytes(body) {
    if (body == null) return new Uint8Array(0);
    if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    const text = (Porffor.type(body) | 0b10000000) == Porffor.TYPES.bytestring ? body : String(body);
    return new TextEncoder().encode(text);
  }

  // The compatibility date, from the static the app tail sets once (__sbSetCompat). Every read of
  // globalThis costs a rebuild of the whole global object (#get_globalThis), ~20 us each, so the
  // per-request paths here avoid it; until the tail has run (the shared template, unit tests) it
  // reads globalThis as before.
  static _compat() { const d = Request._cd; return d === undefined ? globalThis.__sbCompat : d; }
  // Whether the prelude defined WebSocketPair: set by __sbInstallWebSockets once the date is known.
  static _hasWebSocketPair() { const h = Request._hasWsp; return h === undefined ? globalThis.WebSocketPair != null : h; }

  // Fetch as workerd implements it, from compatibility date 2026-10-23: a Request made from
  // another takes its body (the source becomes used, and a used one cannot be copied),
  // GET and HEAD refuse any body, methods and redirect modes are workerd's, and errors
  // carry workerd's messages. Before it, a copy shared the body, as it always did here.
  static _strict() { return Request._compat() >= '2026-10-23'; }
  static _usedError() {
    return new TypeError(Request._strict() ? 'Body has already been used. It can only be used once. Use tee() first if you need to read it twice.' : 'Body has already been used');
  }
  // workerd's methods (kj's list): known names in any case, uppercased; anything else throws.
  static _method(method) {
    const upper = method.toUpperCase();
    const known = ' GET HEAD POST PUT DELETE PATCH PURGE OPTIONS TRACE COPY LOCK MKCOL MOVE PROPFIND PROPPATCH SEARCH UNLOCK ACL REPORT MKACTIVITY CHECKOUT MERGE MSEARCH NOTIFY SUBSCRIBE UNSUBSCRIBE QUERY ';
    if (method.indexOf(' ') < 0 && known.indexOf(' ' + upper + ' ') >= 0) return upper;
    throw new TypeError('Invalid HTTP method string: ' + method);
  }
  // Whether the body was used: read through this message, or (from 2026-10-23, as in
  // workerd) through its stream by anyone, such as a Request given it as init.
  static _used(message) {
    if (message._bodyUsed === true) return true;
    if (!Request._strict()) return false;
    const stream = message._bodyStream != null ? message._bodyStream : message._bodyInit;
    return Request._isStream(stream) && stream._disturbed === true;
  }
  // A body for two readers: a stream is teed, the first branch staying with the source.
  // Values are read by copying, so both share them.
  static _split(message) {
    const init = message._bodyStream != null ? message._bodyStream : message._bodyInit;
    if (!Request._isStream(init)) return init;
    const pair = init.tee();
    message._bodyInit = pair[0];
    message._bodyStream = null;
    return pair[1];
  }

  // A body is read once: the first reader marks it used, a second throws, as in Fetch.
  static _consume(message) {
    if (Request._used(message)) throw Request._usedError();
    message._bodyUsed = true;
    // A stream the body getter handed out is what the reader reads: a locked one throws.
    return message._bodyStream != null ? message._bodyStream : message._bodyInit;
  }

  // body is a ReadableStream, as in Fetch: a stream body itself, else a stream made once over
  // the bytes. The value as given stays in _bodyInit, which the native writer, streaming and
  // the prelude read; assigning body (the native ingress does) sets it.
  // From compatibility date 2026-10-21. Before it, body is the value as given, as it always
  // was here (apps read request.body as a string); a deployed handler keeps its behaviour.
  static _bodyAsStream(message) {
    const init = message._bodyInit;
    if (!(Request._compat() >= '2026-10-21')) return init;
    if (init == null) return null;
    if (Request._isStream(init)) return init;
    if (message._bodyStream == null) {
      const bytes = Request._messageBytes(message, init);
      message._bodyStream = new globalThis.ReadableStream({ start(c) { if (bytes.length) c.enqueue(bytes); c.close(); } });
      // The value the stream was made from, for the bindings that take a body at once
      // (R2 and KV put, outbound fetch): put(key, request.body) is the Workers idiom.
      message._bodyStream._sbBody = message._bodyLatin1 === true ? bytes : init;
    }
    return message._bodyStream;
  }

  // Raw ingress bytes (a copy of an incoming request) decode as UTF-8, like any byte body.
  static _messageText(message, body) {
    if (message._bodyLatin1 === true && typeof body == 'string') return new TextDecoder().decode(Request._messageBytes(message, body));
    return Request._bodyText(body);
  }

  static _bodyText(body) {
    if (body == null) return '';
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
    return (Porffor.type(body) | 0b10000000) == Porffor.TYPES.bytestring ? body : String(body);
  }

  // A ReadableStream body is read to its end, and its chunks must be bytes, as in Fetch and
  // workerd. Readers of such a body answer with a promise; other bodies keep answering at
  // once, since the prelude reads them synchronously. The prelude defines ReadableStream on
  // globalThis after this file is compiled.
  static _isStream(body) {
    const Stream = Request._stream ?? (Request._stream = globalThis.ReadableStream);
    return Stream != null && body instanceof Stream;
  }
  static async _streamBytes(stream) {
    const reader = stream.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      const value = step.value;
      if (!(value instanceof Uint8Array)) throw new TypeError('This ReadableStream did not return bytes.');
      chunks.push(value);
      size += value.length;
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
  static _read(message, finish) {
    const body = Request._consume(message);
    if (Request._isStream(body)) return Request._streamBytes(body).then(finish);
    return finish(Request._messageBytes(message, body));
  }
  // A body the native ingress delivered is its raw bytes, one character each
  // (_bodyLatin1): those bytes, not the string UTF-8 encoded again.
  static _messageBytes(message, body) {
    if (message._bodyLatin1 === true && typeof body == 'string') {
      const out = new Uint8Array(body.length);
      for (let i = 0; i < body.length; i++) out[i] = body.charCodeAt(i) & 255;
      return out;
    }
    return Request._bodyBytes(body);
  }

  constructor(input, init = undefined) {
    const strict = Request._strict();
    let url = input;
    let method = 'GET';
    let headers = undefined;
    let body = null;
    let redirect = undefined;
    let signal = null;
    // The Request whose body this one takes, when init gives none.
    let source = null;

    if (input instanceof Request) {
      url = input.url;
      method = input.method;
      headers = input.headers;
      body = input._bodyStream != null ? input._bodyStream : input._bodyInit;
      redirect = input.redirect;
      if (input._signal != null) signal = input._signal;
      if (body != null) source = input;
    } else if (input != null && Porffor.type(input) == Porffor.TYPES.object && input.href != null) url = input.href;

    if (init != null) {
      if (init.method != null) method = init.method;
      if (init.headers != null) headers = init.headers;
      if (init.body !== undefined) {
        body = init.body;
        source = null;
      }
      if (init.redirect != null) redirect = init.redirect;
      if (init.signal !== undefined) signal = init.signal;
    }

    const raw = (Porffor.type(url) | 0b10000000) == Porffor.TYPES.bytestring ? url : String(url);
    let href;
    try {
      href = new URL(raw).href;
    } catch (e) {
      throw new TypeError('Invalid URL: ' + raw);
    }
    this.url = href;
    const methodText = (Porffor.type(method) | 0b10000000) == Porffor.TYPES.bytestring ? method : String(method);
    this.method = strict ? Request._method(methodText) : methodText.toUpperCase();
    if (strict) {
      if (redirect != null && redirect != 'follow' && redirect != 'manual')
        throw new TypeError('Invalid redirect value, must be one of "follow" or "manual" ("error" won\'t be implemented since it does not make sense at the edge; use "manual" and check the response status code).');
      if (body != null && (this.method == 'GET' || this.method == 'HEAD'))
        throw new TypeError('Request with a GET or HEAD method cannot have a body.');
      if (source != null && Request._used(source)) throw new TypeError('Cannot reconstruct a Request with a used body.');
    } else if (init != null && init.body != null && init.body !== '' && (this.method == 'GET' || this.method == 'HEAD'))
      throw new TypeError('Request with GET/HEAD method cannot have body.');
    this.headers = new Headers(headers);
    if (source != null) {
      // The body as the source holds it, already extracted: no content type is added, and
      // raw ingress bytes stay bytes. From 2026-10-23 the source gives it up.
      this._bodyInit = body;
      if (source._bodyLatin1 === true) this._bodyLatin1 = true;
      if (strict) source._bodyUsed = true;
    } else this._bodyInit = Request._extractBody(body, this.headers);
    if (redirect != null) this._redirect = String(redirect);
    if (signal != null) this._signal = signal;
  }

  get redirect() { return this._redirect ?? 'follow'; }
  // A signal that never aborts unless one was given, made when first asked for.
  get signal() {
    if (this._signal == null) this._signal = new globalThis.AbortController().signal;
    return this._signal;
  }
  get body() { return Request._bodyAsStream(this); }
  set body(value) { this._bodyInit = value; this._bodyStream = null; }
  get bodyUsed() { return Request._used(this); }

  arrayBuffer() { return Request._read(this, (bytes) => bytes.buffer); }
  blob() { return Request._read(this, (bytes) => new Blob([bytes])); }
  // A copy with its own branch of the body. workerd says the used body's stream is locked.
  clone() {
    if (Request._used(this))
      throw new TypeError(Request._strict() ? 'This ReadableStream is currently locked to a reader,' : 'Body has already been used');
    const copy = new Request(this.url, { method: this.method, headers: this.headers, redirect: this._redirect, signal: this._signal });
    copy._bodyInit = Request._split(this);
    if (this._bodyLatin1 === true) copy._bodyLatin1 = true;
    return copy;
  }
  json() {
    const body = Request._consume(this);
    if (Request._isStream(body)) return Request._streamBytes(body).then((bytes) => JSON.parse(new TextDecoder().decode(bytes)));
    return JSON.parse(Request._messageText(this, body));
  }
  text() {
    const body = Request._consume(this);
    if (Request._isStream(body)) return Request._streamBytes(body).then((bytes) => new TextDecoder().decode(bytes));
    return Request._messageText(this, body);
  }
}

class Response {
  constructor(body = null, init = undefined) {
    const status = init?.status ?? 200;
    this.status = Number(status);
    // A WebSocket handshake answer (from compatibility date 2026-10-30, where the prelude
    // defines WebSocketPair): status 101 and the client end of a pair, as in workerd.
    const webSocket = Request._hasWebSocketPair() ? init?.webSocket : null;
    if (webSocket != null) {
      if (this.status != 101) throw new RangeError('Responses with a WebSocket must have status code 101.');
      this._webSocket = webSocket;
    } else if (!(this.status >= 200 && this.status <= 599) || this.status != Math.floor(this.status))
      throw new RangeError('Response status must be between 200 and 599, got ' + status);
    if (body != null && (this.status == 101 || this.status == 204 || this.status == 205 || this.status == 304))
      throw new TypeError('Response with null body status cannot have body');
    if (init?.statusText != null) this._statusText = String(init.statusText);
    this.headers = new Headers(init?.headers);
    this._bodyInit = Request._extractBody(body, this.headers);
  }

  static error() {
    const response = new Response(null, { status: 200 });
    response.status = 0;
    response._type = 'error';
    return response;
  }

  get statusText() { return this._statusText ?? ''; }
  // '' for a Response you construct, as in the Fetch standard; a fetch() result sets the address it came from.
  get url() { return this._url ?? ''; }
  set url(value) { this._url = value; }
  get redirected() { return false; }
  get type() { return this._type ?? 'default'; }
  get ok() { return this.status >= 200 && this.status < 300; }
  // null when there is none, as in workerd; before 2026-10-30 (no WebSocketPair) undefined.
  get webSocket() { return this._webSocket != null ? this._webSocket : Request._hasWebSocketPair() ? null : undefined; }
  get body() { return Request._bodyAsStream(this); }
  set body(value) { this._bodyInit = value; this._bodyStream = null; }
  get bodyUsed() { return Request._used(this); }

  arrayBuffer() { return Request._read(this, (bytes) => bytes.buffer); }
  blob() { return Request._read(this, (bytes) => new Blob([bytes])); }
  clone() {
    if (Request._used(this)) throw new TypeError('Body has already been used');
    const copy = new Response(null, { status: this.status == 0 ? 200 : this.status, statusText: this._statusText, headers: this.headers });
    copy._bodyInit = Request._split(this);
    copy.status = this.status;
    if (this._type != null) copy._type = this._type;
    return copy;
  }
  json() {
    const body = Request._consume(this);
    if (Request._isStream(body)) return Request._streamBytes(body).then((bytes) => JSON.parse(new TextDecoder().decode(bytes)));
    return JSON.parse(Request._messageText(this, body));
  }
  text() {
    const body = Request._consume(this);
    if (Request._isStream(body)) return Request._streamBytes(body).then((bytes) => new TextDecoder().decode(bytes));
    return Request._messageText(this, body);
  }
}
globalThis.Headers = Headers;
globalThis.Blob = Blob;
globalThis.File = File;
globalThis.TextEncoder = TextEncoder;
globalThis.TextDecoder = TextDecoder;
globalThis.URL = URL;
globalThis.Request = Request;
globalThis.Response = Response;
