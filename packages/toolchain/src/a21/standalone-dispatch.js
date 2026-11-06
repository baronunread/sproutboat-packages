/* oxlint-disable anti-slop/no-runtime-typeof -- runtime code Porffor compiles into the binary: typeof is how a callback or a thenable is recognised there. */
// sproutd on Porffor alpha 21: the dispatch shim build/a21/base.ts puts after the runtime prelude.
// The bridge (src/a21/native-host-bridge.c) builds the request parts in C and calls __sbDispatch
// through a rooted function value; a settled response goes back through sb_response_complete_js,
// at once or from the promise reaction that settles it later, as alpha 19's native-fetch
// response reaction did. The response is read the way alpha 19's finalizer and bridge read it:
// the flat Headers._entries list, _bodyInit over body, x-sb-raw-body marking a Latin-1 string
// whose characters are the bytes, and byte bodies sent as their bytes.
function __sbBuildRequest(method, url, headersBlob, body) {
  const request = Object.create(Request.prototype);
  request.url = url;
  request.method = method;
  const headers = Object.create(Headers.prototype);
  const entries = [];
  let i = 0;
  const n = headersBlob.length;
  while (i < n) {
    const a = headersBlob.indexOf("\0", i);
    const b = headersBlob.indexOf("\0", a + 1);
    entries.push(headersBlob.slice(i, a));
    entries.push(headersBlob.slice(a + 1, b));
    i = b + 1;
  }
  headers._entries = entries;
  request.headers = headers;
  request.body = body;
  return request;
}
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block, not by JS.
function __sbCompleteNative(pending, status, head, body, kind) {
  // oxlint-disable-next-line no-unused-expressions -- inline C.
  Porffor.c`sb_response_complete_js(SB_NUM(pending), SB_NUM(status), head, body, SB_NUM(kind));`;
}
// kind: 0 a string sent as UTF-8, 1 a Latin-1 string whose characters are the bytes, 2 a Uint8Array.
function __sbSerialize(value, rejected) {
  let status = 500;
  let head = "";
  let body = "compiled app promise rejected";
  let kind = 0;
  if (!rejected) {
    try {
      const response = value;
      status = response.status | 0;
      let entries = response.headers._entries;
      if (typeof entries === "function") entries = entries.call(response.headers);
      let raw = false;
      for (let i = 0; i < entries.length; i += 2) {
        const name = entries[i];
        if (name === "x-sb-raw-body") {
          raw = true;
          continue;
        }
        if (name === "connection" || name === "content-length" || name === "transfer-encoding") continue;
        head += name + "\0" + entries[i + 1] + "\0";
      }
      let b = response._bodyInit !== undefined ? response._bodyInit : response.body;
      if (b instanceof ArrayBuffer) {
        body = new Uint8Array(b);
        kind = 2;
      } else if (ArrayBuffer.isView(b)) {
        // The bridge reads the view's buffer from its start: a view over part of one is copied.
        body =
          b.byteOffset === 0 && b.byteLength === b.buffer.byteLength && b instanceof Uint8Array
            ? b
            : new Uint8Array(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
        kind = 2;
      } else {
        body = b == null ? "" : String(b);
        kind = raw ? 1 : 0;
      }
    } catch (error) {
      status = 500;
      head = "";
      body = "Internal Server Error: " + (error && error.message ? error.message : String(error));
      kind = 0;
    }
  }
  return { status, head, body, kind };
}
function __sbComplete(pending, value, rejected) {
  const r = __sbSerialize(value, rejected);
  __sbCompleteNative(pending, r.status, r.head, r.body, r.kind);
}
function __sbDispatch(pending, method, url, headersBlob, body) {
  let result;
  try {
    const request = __sbBuildRequest(method, url, headersBlob, body);
    result = globalThis.__forkHandler.fetch(request);
  } catch (error) {
    __sbComplete(pending, error, true);
    return;
  }
  if (result !== null && typeof result === "object" && typeof result.then === "function") {
    result.then(
      function (value) {
        __sbComplete(pending, value, false);
      },
      function (reason) {
        __sbComplete(pending, reason, true);
      },
    );
    // A promise that is already settled, or settles in the microtasks the handler queued, replies
    // before the dispatch returns, as alpha 19's drain-then-check did.
    __Porffor_promise_runJobs();
    return;
  }
  __sbComplete(pending, result, false);
}
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block, not by JS.
function __sbRegisterNative(dispatch, fire, drain, warm) {
  // oxlint-disable-next-line no-unused-expressions -- inline C.
  Porffor.c`
sb_dispatch_fn = dispatch;
sb_fire_timer_fn = fire;
sb_drain_fn = drain;
sb_warm_fn = warm;
porf_gc_native_root_add(dispatch.val, dispatch.type);
porf_gc_native_root_add(fire.val, fire.type);
porf_gc_native_root_add(drain.val, drain.type);
porf_gc_native_root_add(warm.val, warm.type);`;
}
// The template's warm-up (M6 causes 2 and 3): the fork template runs a few representative
// requests through the shim's own path before it seals and forks, so the inline-cache slots of
// the prelude's code (per-site 48-byte entries in the shared zero data, written on first use) and
// the shapes of the request and response objects are filled in the template, shared by every
// worker, instead of being copied into each worker on its first request (52 to 68 KiB per
// worker). Only the prelude's functions are exercised (the app's own sites live in its module),
// nothing here reaches the host (no timers, fetch, storage or console), and whatever it allocates
// is garbage by the time the template collects. The megamorphic cache is frozen at the end: a
// worker reads the template's entries and never writes one.
function __sbTemplateWarm() {
  const handler = function (request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const q = url.searchParams.get("x");
    const n = Number(q) + 7;
    const ct = request.headers.get("content-type");
    const host = request.headers.get("host");
    const ua = request.headers.get("user-agent");
    const has = request.headers.has("authorization");
    const names = [];
    request.headers.forEach(function (value, name) {
      names.push(name + "=" + value);
    });
    for (const pair of request.headers.entries()) names.push(pair[0]);
    if (request.method === "POST") {
      return Promise.resolve(request.json()).then(function (data) {
        const out = { ok: true, path, n, ct, host, ua, has, keys: Object.keys(data), items: names.length, echo: data };
        return Response.json(out, { status: 201, headers: { "x-warm": "1" } });
      });
    }
    if (path === "/text") {
      return Promise.resolve(request.text()).then(function (text) {
        const headers = new Headers({ "content-type": "text/plain; charset=utf-8" });
        headers.set("cache-control", "no-store");
        headers.append("x-warm", String(text.length));
        return new Response("hello " + path + " " + n + " " + JSON.stringify({ q, has }), { status: 200, headers });
      });
    }
    if (path === "/bytes") {
      const bytes = new TextEncoder().encode(
        "warm " + String(Date.now() | 0) + " " + encodeURIComponent(path) + " " + btoa("ab"),
      );
      const decoded = new TextDecoder().decode(bytes);
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": "application/octet-stream", "x-len": String(decoded.length) },
      });
    }
    if (path === "/empty") return new Response(null, { status: 204 });
    if (path === "/redirect") return Response.redirect("https://example.com/next", 302);
    const response = new Response(JSON.stringify({ path, n, items: names }), {
      headers: { "content-type": "application/json" },
    });
    response.headers.set("x-warm", "json");
    return Promise.resolve(response.text()).then(function (text) {
      return new Response(text, { status: response.status, headers: response.headers });
    });
  };
  const head =
    [
      "host",
      "warm.localhost",
      "user-agent",
      "sproutd-warm/1",
      "accept",
      "*/*",
      "accept-encoding",
      "gzip, br",
      "content-type",
      "application/json",
      "cookie",
      "a=1; b=2",
      "authorization",
      "Bearer warm",
      "x-forwarded-for",
      "127.0.0.1",
    ].join("\u0000") + "\u0000";
  const requests = [
    ["GET", "https://warm.localhost/proof?x=11&y=2", head, ""],
    ["POST", "https://warm.localhost/api/items?x=3", head, '{"a":1,"b":[1,2,3],"c":{"d":"e"}}'],
    ["GET", "https://warm.localhost/text?x=5", head, "plain body"],
    ["GET", "https://warm.localhost/bytes", head, ""],
    ["GET", "https://warm.localhost/empty", head, ""],
    ["GET", "https://warm.localhost/redirect", head, ""],
    ["PUT", "https://warm.localhost/a/b/c?x=1#f", head, ""],
  ];
  let done = 0;
  let failed = "";
  for (let i = 0; i < requests.length; i++) {
    const r = requests[i];
    try {
      const request = __sbBuildRequest(r[0], r[1], r[2], r[3]);
      const result = handler(request);
      if (result !== null && typeof result === "object" && typeof result.then === "function") {
        result.then(
          function (value) {
            __sbSerialize(value, false);
            done++;
          },
          function (reason) {
            failed += i + ": " + (reason && reason.message ? reason.message : String(reason)) + "; ";
          },
        );
      } else {
        __sbSerialize(result, false);
        done++;
      }
    } catch (error) {
      failed += i + ": " + (error && error.message ? error.message : String(error)) + "; ";
    }
    __Porffor_promise_runJobs();
  }
  // the error path too (a handler that throws, a rejected promise)
  __sbSerialize(new Error("warm"), true);
  __Porffor_promise_runJobs();
  __Porffor_object_icFreezeMega();
  if (failed !== "" || done !== requests.length) {
    console.error("template warm-up failed: " + failed + " (" + done + " of " + requests.length + " requests)");
    // oxlint-disable-next-line no-unused-expressions -- inline C: the template script fails the prepare.
    Porffor.c`sb_warm_failed = 1;`;
  }
}
__sbRegisterNative(__sbDispatch, globalThis.__sbFireTimer, globalThis.__sbDrainJobs, __sbTemplateWarm);
