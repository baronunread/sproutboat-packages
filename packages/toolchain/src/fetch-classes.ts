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

`;

export const RESPONSE_CLASS_SOURCE = String.raw`class Response {
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
`;
