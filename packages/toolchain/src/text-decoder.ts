/**
 * The WHATWG UTF-8 TextDecoder that replaces Porffor's (see patchTextDecoder). Porffor's
 * decoded three bytes at most (astral characters came out as garbage), never checked
 * continuation bytes, and ignored fatal, ignoreBOM and { stream }. Found by sproutd's W2
 * conformance suite against workerd.
 */
export const TEXT_DECODER_SOURCE = String.raw`class TextDecoder {
  // sproutboat: WHATWG UTF-8 decoder
  constructor(label = 'utf-8', options = undefined) {
    const name = String(label).trim().toLowerCase();
    if (name != 'utf-8' && name != 'utf8' && name != 'unicode-1-1-utf-8') throw new RangeError('TextDecoder: unsupported encoding ' + label);
    this.encoding = 'utf-8';
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
}
`;
