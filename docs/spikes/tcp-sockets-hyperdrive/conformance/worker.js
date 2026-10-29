// cloudflare:sockets conformance suite. The same file runs in workerd (the reference) and in a
// sproutboat build; GET /run?p=plain:1,tls:2,... runs every test and returns JSON observations.
import { connect } from "cloudflare:sockets";

const enc = new TextEncoder();
const dec = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT " + what)), ms))]);
const err = (e) => ({ name: e && e.name, message: String(e && e.message).slice(0, 120) });
async function readN(reader, n) {
  let out = "";
  while (out.length < n) {
    const r = await reader.read();
    if (r.done) return { out, done: true };
    out += dec.decode(r.value);
  }
  return { out, done: false };
}
async function settled(p, ms = 1500) {
  try {
    return {
      state: await withTimeout(
        p.then(
          (v) => ({ resolved: true, value: v === undefined ? "undefined" : typeof v }),
          (e) => ({ rejected: err(e) }),
        ),
        ms,
        "settle",
      ),
    };
  } catch {
    return { state: "pending" };
  }
}

const tests = {
  async shape(P) {
    const s = connect({ hostname: "127.0.0.1", port: P.plain });
    const r = {
      readable: s.readable instanceof ReadableStream,
      writable: s.writable instanceof WritableStream,
      opened: s.opened instanceof Promise,
      closed: s.closed instanceof Promise,
      close: typeof s.close,
      startTls: typeof s.startTls,
      upgraded: s.upgraded,
      secureTransport: s.secureTransport,
      allowHalfOpen: s.allowHalfOpen,
    };
    const info = await withTimeout(s.opened, 3000, "opened");
    r.openedInfoKeys = Object.keys(info || {}).sort();
    r.remoteAddressType = typeof (info && info.remoteAddress);
    await s.close();
    return r;
  },
  async addressForms(P) {
    const r = {};
    for (const [k, a] of Object.entries({
      string: "127.0.0.1:" + P.plain,
      obj: { hostname: "127.0.0.1", port: P.plain },
      noPort: "127.0.0.1",
      badPort: { hostname: "127.0.0.1", port: "x" },
      port0: "127.0.0.1:0",
      empty: "",
    })) {
      try {
        const s = connect(a);
        const o = await settled(s.opened, 2000);
        r[k] = { ok: true, opened: o.state };
        try {
          await s.close();
        } catch {}
      } catch (e) {
        r[k] = { threw: err(e) };
      }
    }
    return r;
  },
  async port25(P) {
    try {
      const s = connect("127.0.0.1:25");
      return { ok: true, opened: await settled(s.opened), closed: await settled(s.closed) };
    } catch (e) {
      return { threw: err(e) };
    }
  },
  async echo(P) {
    const s = connect("127.0.0.1:" + P.plain);
    const w = s.writable.getWriter(),
      rd = s.readable.getReader();
    await w.write(enc.encode("hello\n"));
    const got = await withTimeout(readN(rd, 6), 3000, "echo");
    await s.close();
    return got;
  },
  async bulk(P) {
    const N = 1 << 20;
    const s = connect("127.0.0.1:" + P.plain);
    const w = s.writable.getWriter(),
      rd = s.readable.getReader();
    const data = new Uint8Array(N);
    for (let i = 0; i < N; i++) data[i] = (i * 31 + 7) & 255;
    let sum = 0,
      got = 0;
    const reading = (async () => {
      while (got < N) {
        const r = await rd.read();
        if (r.done) break;
        for (const b of r.value) sum = (sum + b) % 1000003;
        got += r.value.length;
      }
    })();
    for (let o = 0; o < N; o += 65536) await w.write(data.subarray(o, o + 65536));
    await withTimeout(reading, 10000, "bulk");
    let want = 0;
    for (let i = 0; i < N; i++) want = (want + data[i]) % 1000003;
    await s.close();
    return { got, checksumOk: sum === want };
  },
  async halfOpenTrue(P) {
    const s = connect("127.0.0.1:" + P.plain, { allowHalfOpen: true });
    const w = s.writable.getWriter(),
      rd = s.readable.getReader();
    await w.write(enc.encode("x\n"));
    await w.close();
    const got = await withTimeout(readN(rd, 100), 3000, "halfopen");
    const closed = await settled(s.closed, 1000);
    await s.close().catch(() => {});
    return { got, closedAfterEof: closed.state, allowHalfOpen: s.allowHalfOpen };
  },
  async halfOpenFalse(P) {
    const s = connect("127.0.0.1:" + P.plain, { allowHalfOpen: false });
    const w = s.writable.getWriter(),
      rd = s.readable.getReader();
    await w.write(enc.encode("x\n"));
    await w.close();
    const got = await withTimeout(readN(rd, 100), 3000, "halfclosed");
    const closed = await settled(s.closed, 1500);
    return { got, closedAfterEof: closed.state };
  },
  async serverEof(P) {
    const s = connect("127.0.0.1:" + P.greet);
    const rd = s.readable.getReader();
    const got = await withTimeout(readN(rd, 1000), 3000, "greet");
    const closed = await settled(s.closed, 1500);
    let writeAfter;
    try {
      const w = s.writable.getWriter();
      await withTimeout(w.write(enc.encode("late")), 1500, "write");
      writeAfter = "resolved";
    } catch (e) {
      writeAfter = err(e);
    }
    return { got, closedAfterEof: closed.state, writeAfter };
  },
  async closeSemantics(P) {
    const s = connect("127.0.0.1:" + P.plain);
    await s.opened;
    const rd = s.readable.getReader();
    const pending = rd.read();
    const closeRet = s.close();
    const r = {};
    r.closeReturnsPromise = closeRet instanceof Promise;
    r.pendingRead = await settled(pending.then((x) => x.done));
    r.closed = await settled(s.closed);
    r.closeResolved = await settled(closeRet);
    try {
      await s.writable.getWriter().write(enc.encode("a"));
      r.writeAfterClose = "resolved";
    } catch (e) {
      r.writeAfterClose = err(e);
    }
    r.closeTwice = await settled(s.close());
    return r;
  },
  async refused(P) {
    const s = connect("127.0.0.1:" + P.closed);
    const o = await settled(s.opened, 4000);
    const c = await settled(s.closed, 4000);
    let rd;
    try {
      rd = await settled(
        s.readable
          .getReader()
          .read()
          .then((x) => x.done),
        1500,
      );
    } catch (e) {
      rd = { threw: err(e) };
    }
    return { opened: o.state, closed: c.state, read: rd };
  },
  async writeTypes(P) {
    const s = connect("127.0.0.1:" + P.plain);
    const w = s.writable.getWriter();
    const r = {};
    for (const [k, v] of Object.entries({
      string: "abc",
      arrayBuffer: new ArrayBuffer(2),
      u8: new Uint8Array(2),
      dataview: new DataView(new ArrayBuffer(2)),
      number: 5,
      nullv: null,
    })) {
      try {
        await withTimeout(w.write(v), 1500, "write");
        r[k] = "ok";
      } catch (e) {
        r[k] = err(e);
      }
    }
    await s.close().catch(() => {});
    return r;
  },
  async tlsOn(P) {
    const s = connect("localhost:" + P.tls, { secureTransport: "on" });
    const w = s.writable.getWriter(),
      rd = s.readable.getReader();
    const info = await settled(s.opened, 4000);
    await w.write(enc.encode("secure\n"));
    const got = await withTimeout(readN(rd, 7), 3000, "tls echo");
    await s.close();
    return { opened: info.state, got, secureTransport: s.secureTransport };
  },
  async startTls(P) {
    const s = connect("localhost:" + P.starttls, { secureTransport: "starttls" });
    const w = s.writable.getWriter(),
      rd = s.readable.getReader();
    await w.write(enc.encode("STARTTLS\n"));
    const ok = await withTimeout(readN(rd, 3), 3000, "starttls ok");
    w.releaseLock();
    rd.releaseLock();
    const s2 = s.startTls({ expectedServerHostname: "localhost" });
    const r = {
      ok,
      oldReadableLocked: s.readable.locked,
      oldWritableLocked: s.writable.locked,
      sameObject: s2 === s,
      upgraded: s.upgraded,
      s2Upgraded: s2.upgraded,
      s2Secure: s2.secureTransport,
    };
    const w2 = s2.writable.getWriter(),
      rd2 = s2.readable.getReader();
    await w2.write(enc.encode("tls!\n"));
    r.echo = await withTimeout(readN(rd2, 5), 4000, "tls echo");
    r.s2Opened = (await settled(s2.opened, 2000)).state;
    try {
      s.startTls();
      r.secondStartTls = "ok";
    } catch (e) {
      r.secondStartTls = err(e);
    }
    await s2.close();
    return r;
  },
  async startTlsOnPlain(P) {
    const s = connect("127.0.0.1:" + P.plain);
    try {
      s.startTls();
      return { threw: false };
    } catch (e) {
      return { threw: err(e) };
    }
  },
  async backpressure(P) {
    const s = connect("127.0.0.1:" + P.sink);
    await s.opened;
    const w = s.writable.getWriter();
    const chunk = new Uint8Array(65536);
    let resolved = 0,
      blockedAt = null;
    const t0 = Date.now();
    const loop = (async () => {
      for (let i = 0; i < 512; i++) {
        await w.write(chunk);
        resolved++;
      }
    })();
    await Promise.race([loop, sleep(2000)]);
    const mid = resolved;
    await sleep(500);
    const r = {
      writesResolvedWithinWindow: mid,
      stalled: resolved === mid && resolved < 512,
      bytesAccepted: resolved * 65536,
      desiredSize: w.desiredSize,
      finite: resolved < 512,
    };
    s.close().catch(() => {});
    return r;
  },
  async abort(P) {
    const s = connect("127.0.0.1:" + P.plain);
    await s.opened;
    const rd = s.readable.getReader();
    await rd.cancel("bye");
    const c = await settled(s.closed, 1500);
    return { closedAfterReadableCancel: c.state };
  },
};

export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/run") return new Response("conformance");
    const P = {};
    for (const kv of (url.searchParams.get("p") || "").split(",")) {
      const [k, v] = kv.split(":");
      if (k) P[k] = Number(v);
    }
    const only = url.searchParams.get("t");
    const out = {};
    for (const name of Object.keys(tests)) {
      if (only && only !== name) continue;
      try {
        out[name] = await withTimeout(tests[name](P), 20000, name);
      } catch (e) {
        out[name] = { FAILED: err(e) };
      }
    }
    return new Response(JSON.stringify(out, null, 1), { headers: { "content-type": "application/json" } });
  },
};
