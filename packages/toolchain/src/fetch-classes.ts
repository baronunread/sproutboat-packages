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
    // A stream the body getter handed out is what the reader reads: a locked one throws.
    return message._bodyStream != null ? message._bodyStream : message._bodyInit;
  }

  // body is a ReadableStream, as in Fetch: a stream body itself, else a stream made once over
  // the bytes. The value as given stays in _bodyInit, which the native writer, streaming and
  // the prelude read; assigning body (the native ingress does) sets it.
  static _bodyAsStream(message) {
    const init = message._bodyInit;
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
    const Stream = globalThis.ReadableStream;
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
    let url = input;
    let method = 'GET';
    let headers = undefined;
    let body = null;
    let redirect = undefined;

    if (input instanceof Request) {
      url = input.url;
      method = input.method;
      headers = input.headers;
      body = input._bodyStream != null ? input._bodyStream : input._bodyInit;
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
    this._bodyInit = Request._extractBody(body, this.headers);
    if (redirect != null) this._redirect = String(redirect);
  }

  get redirect() { return this._redirect ?? 'follow'; }
  get body() { return Request._bodyAsStream(this); }
  set body(value) { this._bodyInit = value; this._bodyStream = null; }
  get bodyUsed() { return this._bodyUsed === true; }

  arrayBuffer() { return Request._read(this, (bytes) => bytes.buffer); }
  blob() { return Request._read(this, (bytes) => new Blob([bytes])); }
  clone() {
    if (this._bodyUsed === true) throw new TypeError('Body has already been used');
    return new Request(this);
  }
  json() {
    const body = Request._consume(this);
    if (Request._isStream(body)) return Request._streamBytes(body).then((bytes) => JSON.parse(new TextDecoder().decode(bytes)));
    return JSON.parse(Request._bodyText(body));
  }
  text() {
    const body = Request._consume(this);
    if (Request._isStream(body)) return Request._streamBytes(body).then((bytes) => new TextDecoder().decode(bytes));
    return Request._bodyText(body);
  }
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
    this._bodyInit = Request._extractBody(body, this.headers);
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
  get body() { return Request._bodyAsStream(this); }
  set body(value) { this._bodyInit = value; this._bodyStream = null; }
  get bodyUsed() { return this._bodyUsed === true; }

  arrayBuffer() { return Request._read(this, (bytes) => bytes.buffer); }
  blob() { return Request._read(this, (bytes) => new Blob([bytes])); }
  clone() {
    if (this._bodyUsed === true) throw new TypeError('Body has already been used');
    const copy = new Response(null, { status: this.status == 0 ? 200 : this.status, statusText: this._statusText, headers: this.headers });
    copy._bodyInit = this._bodyInit;
    copy.status = this.status;
    if (this._type != null) copy._type = this._type;
    return copy;
  }
  json() {
    const body = Request._consume(this);
    if (Request._isStream(body)) return Request._streamBytes(body).then((bytes) => JSON.parse(new TextDecoder().decode(bytes)));
    return JSON.parse(Request._bodyText(body));
  }
  text() {
    const body = Request._consume(this);
    if (Request._isStream(body)) return Request._streamBytes(body).then((bytes) => new TextDecoder().decode(bytes));
    return Request._bodyText(body);
  }
}
`;

// The finalizer's body line, and what replaces it: byte bodies go out as their bytes.
export const RESPONSE_BYTES_ANCHOR =
  "  const body = response.body == null ? '' : String(response.body);\n  const headersEntries = response.headers._entries;\n";
export const RESPONSE_BYTES_INJECT =
  "  // sproutboat: byte bodies go out as their bytes. A Latin-1 string, one character per byte,\n" +
  "  // built in windows (concatenating one long string is quadratic), sent raw by the writer.\n" +
  "  let body = response._bodyInit !== undefined ? response._bodyInit : response.body;\n" +
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
