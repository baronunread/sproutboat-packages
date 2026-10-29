/**
 * The WHATWG UTF-8 TextDecoder that replaces Porffor's (see patchTextDecoder). Porffor's
 * decoded three bytes at most (astral characters came out as garbage), never checked
 * continuation bytes, and ignored fatal, ignoreBOM and { stream }. Found by sproutd's W2
 * conformance suite against workerd.
 */
export const TEXT_DECODER_SOURCE = String.raw`class TextDecoder {
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
`;
