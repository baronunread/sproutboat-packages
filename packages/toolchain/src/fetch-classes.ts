/**
 * Request and Response classes for Porffor's runtime/fetch-globals.js (patchFetchClasses),
 * and the native response finalizer's byte-body handling (patchResponseBytes). Found by
 * sproutd's W2 conformance suite against workerd:
 *  - Response had no statusText or type, no Response.error, accepted any status, and read
 *    byte bodies as text ("1,2,3"); Request kept relative and unnormalized URLs, allowed
 *    a body on GET, had no redirect, and set no content type for its body.
 *  - The finalizer sent String(response.body), so a Uint8Array body reached the client as
 *    "104,105" and an ArrayBuffer as "[object ArrayBuffer]".
 * Field names (url, method, headers, body, status) stay Porffor's: the native ingress builds
 * Requests without the constructor, and the native writer reads those fields, so defaults
 * for fields it does not set (redirect, statusText, type) are prototype getters.
 */

export const REQUEST_CLASS_SOURCE = String.raw`class Request {
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
    const Form = globalThis.FormData;
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
    const Params = globalThis.URLSearchParams;
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

  // A body is read once: the first reader marks it used, a second throws, as in Fetch.
  static _consume(message) {
    if (message._bodyUsed === true) throw new TypeError('Body has already been used');
    message._bodyUsed = true;
    return message.body;
  }

  static _bodyText(body) {
    if (body == null) return '';
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
    return (Porffor.type(body) | 0b10000000) == Porffor.TYPES.bytestring ? body : String(body);
  }

  constructor(input, init = undefined) {
    let url = input;
    let method = 'GET';
    let headers = undefined;
    let body = null;
    let redirect = undefined;

    if (input instanceof Request) {
      url = input.url;
      method = input.method;
      headers = input.headers;
      body = input.body;
      redirect = input.redirect;
    } else if (input != null && Porffor.type(input) == Porffor.TYPES.object && input.href != null) url = input.href;

    if (init != null) {
      if (init.method != null) method = init.method;
      if (init.headers != null) headers = init.headers;
      if (init.body !== undefined) body = init.body;
      if (init.redirect != null) redirect = init.redirect;
    }

    const raw = (Porffor.type(url) | 0b10000000) == Porffor.TYPES.bytestring ? url : String(url);
    let href;
    try {
      href = new URL(raw).href;
    } catch (e) {
      throw new TypeError('Invalid URL: ' + raw);
    }
    this.url = href;
    this.method = ((Porffor.type(method) | 0b10000000) == Porffor.TYPES.bytestring ? method : String(method)).toUpperCase();
    if (init != null && init.body != null && init.body !== '' && (this.method == 'GET' || this.method == 'HEAD'))
      throw new TypeError('Request with GET/HEAD method cannot have body.');
    this.headers = new Headers(headers);
    this.body = Request._extractBody(body, this.headers);
    if (redirect != null) this._redirect = String(redirect);
  }

  get redirect() { return this._redirect ?? 'follow'; }
  get bodyUsed() { return this._bodyUsed === true; }

  arrayBuffer() { return Request._bodyBytes(Request._consume(this)).buffer; }
  blob() { return new Blob([Request._bodyBytes(Request._consume(this))]); }
  clone() {
    if (this._bodyUsed === true) throw new TypeError('Body has already been used');
    return new Request(this);
  }
  json() { return JSON.parse(Request._bodyText(Request._consume(this))); }
  text() { return Request._bodyText(Request._consume(this)); }
}

`;

export const RESPONSE_CLASS_SOURCE = String.raw`class Response {
  constructor(body = null, init = undefined) {
    const status = init?.status ?? 200;
    this.status = Number(status);
    if (!(this.status >= 200 && this.status <= 599) || this.status != Math.floor(this.status))
      throw new RangeError('Response status must be between 200 and 599, got ' + status);
    if (body != null && (this.status == 101 || this.status == 204 || this.status == 205 || this.status == 304))
      throw new TypeError('Response with null body status cannot have body');
    if (init?.statusText != null) this._statusText = String(init.statusText);
    this.headers = new Headers(init?.headers);
    this.body = Request._extractBody(body, this.headers);
  }

  static error() {
    const response = new Response(null, { status: 200 });
    response.status = 0;
    response._type = 'error';
    return response;
  }

  get statusText() { return this._statusText ?? ''; }
  get type() { return this._type ?? 'default'; }
  get ok() { return this.status >= 200 && this.status < 300; }
  get bodyUsed() { return this._bodyUsed === true; }

  arrayBuffer() { return Request._bodyBytes(Request._consume(this)).buffer; }
  blob() { return new Blob([Request._bodyBytes(Request._consume(this))]); }
  clone() {
    if (this._bodyUsed === true) throw new TypeError('Body has already been used');
    const copy = new Response(null, { status: this.status == 0 ? 200 : this.status, statusText: this._statusText, headers: this.headers });
    copy.body = this.body;
    copy.status = this.status;
    if (this._type != null) copy._type = this._type;
    return copy;
  }
  json() { return JSON.parse(Request._bodyText(Request._consume(this))); }
  text() { return Request._bodyText(Request._consume(this)); }
}
`;

// The finalizer's body line, and what replaces it: byte bodies go out as their bytes.
export const RESPONSE_BYTES_ANCHOR =
  "  const body = response.body == null ? '' : String(response.body);\n  const headersEntries = response.headers._entries;\n";
export const RESPONSE_BYTES_INJECT =
  "  // sproutboat: byte bodies go out as their bytes. A Latin-1 string, one character per byte,\n" +
  "  // built in windows (concatenating one long string is quadratic), sent raw by the writer.\n" +
  "  let body = response.body;\n" +
  "  let headersEntries = response.headers._entries;\n" +
  "  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {\n" +
  "    const view = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);\n" +
  "    const chunks = [];\n" +
  "    let chunk = '';\n" +
  "    for (let i = 0; i < view.length; i++) {\n" +
  "      chunk += String.fromCharCode(view[i]);\n" +
  "      if (chunk.length == 512) { chunks.push(chunk); chunk = ''; }\n" +
  "    }\n" +
  "    chunks.push(chunk);\n" +
  "    body = chunks.join('');\n" +
  "    headersEntries = headersEntries.slice();\n" +
  "    headersEntries.push('x-sb-raw-body', '1');\n" +
  "  } else body = body == null ? '' : String(body);\n";

// Porffor's Blob kept one string (binary parts were stringified) and had no size, type or
// slice; File did not exist. Bytes inside, text() decoded as UTF-8, read methods as promises.
export const BLOB_CLASS_SOURCE = String.raw`class Blob {
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
}

class File extends Blob {
  constructor(bits, name, options = undefined) {
    super(bits, options);
    this.name = String(name);
    this.lastModified = options != null && options.lastModified != null ? Number(options.lastModified) : Date.now();
  }
}
`;
