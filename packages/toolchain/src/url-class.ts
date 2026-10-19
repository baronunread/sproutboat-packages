/**
 * The URL class patchURLClass puts into Porffor's runtime/fetch-globals.js. Porffor's own
 * exposes href, origin, pathname and search only, with no setters but pathname, no base
 * argument and no hash, so Workers code that rewrites a URL (`url.hostname = ...`,
 * `url.searchParams.set(...)`, `new URL(path, request.url)`) failed or went stale.
 * Plain JavaScript compiled by Porffor; checked against WHATWG URL behaviour (Bun's) by
 * packages/runtime/test/native-url.ts. searchParams is the prelude's URLSearchParams,
 * which writes back through `_url` and is re-read through `_reset`.
 */
export const URL_CLASS_SOURCE = String.raw`class URL {
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

`;
