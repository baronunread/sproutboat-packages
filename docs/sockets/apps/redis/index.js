// A small RESP2 client over cloudflare:sockets: the shape ioredis and node-redis speak, without Node's net.
import { connect } from "cloudflare:sockets";

const enc = new TextEncoder();
const dec = new TextDecoder();

class Redis {
  constructor(hostname, port) {
    this.socket = connect({ hostname, port });
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
    this.buf = new Uint8Array(0);
  }
  async fill() {
    const r = await this.reader.read();
    if (r.done) throw new Error("connection closed");
    const next = new Uint8Array(this.buf.length + r.value.length);
    next.set(this.buf);
    next.set(r.value, this.buf.length);
    this.buf = next;
  }
  async line() {
    for (;;) {
      for (let i = 0; i + 1 < this.buf.length; i++) {
        if (this.buf[i] === 13 && this.buf[i + 1] === 10) {
          const s = dec.decode(this.buf.subarray(0, i));
          this.buf = this.buf.subarray(i + 2);
          return s;
        }
      }
      await this.fill();
    }
  }
  async reply() {
    const l = await this.line();
    const t = l[0];
    const rest = l.slice(1);
    if (t === "+") return rest;
    if (t === "-") throw new Error(rest);
    if (t === ":") return Number(rest);
    if (t === "$") {
      const n = Number(rest);
      if (n < 0) return null;
      while (this.buf.length < n + 2) await this.fill();
      const v = this.buf.slice(0, n);
      this.buf = this.buf.subarray(n + 2);
      return v;
    }
    if (t === "*") {
      const n = Number(rest);
      if (n < 0) return null;
      const out = [];
      for (let i = 0; i < n; i++) out.push(await this.reply());
      return out;
    }
    throw new Error("bad reply " + l);
  }
  encode(args) {
    const parts = [enc.encode("*" + args.length + "\r\n")];
    for (const a of args) {
      const b = a instanceof Uint8Array ? a : enc.encode(String(a));
      parts.push(enc.encode("$" + b.length + "\r\n"), b, enc.encode("\r\n"));
    }
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
  async cmd(...args) {
    await this.writer.write(this.encode(args));
    return this.reply();
  }
  async pipeline(cmds) {
    for (const c of cmds) await this.writer.write(this.encode(c));
    const out = [];
    for (let i = 0; i < cmds.length; i++) out.push(await this.reply());
    return out;
  }
  async quit() {
    try {
      await this.cmd("QUIT");
    } catch {}
    await this.socket.close();
  }
}

const show = (v) => (v instanceof Uint8Array ? dec.decode(v) : Array.isArray(v) ? v.map(show) : v);

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const port = Number(url.searchParams.get("port") || 56379);
    const n = Number(url.searchParams.get("n") || 0);
    const out = {};
    const t = async (k, f) => {
      try {
        out[k] = await f();
      } catch (e) {
        out[k] = "THROW " + (e && e.name) + ": " + (e && e.message);
      }
    };
    const r = new Redis("127.0.0.1", port);
    await t("opened", async () =>
      Object.keys(await r.socket.opened)
        .sort()
        .join(","),
    );
    await t("ping", async () => show(await r.cmd("PING")));
    await t("flush", async () => show(await r.cmd("FLUSHALL")));
    await t("set-get", async () => {
      await r.cmd("SET", "k", "héllo wörld");
      return show(await r.cmd("GET", "k"));
    });
    await t("binary", async () => {
      const b = new Uint8Array(256);
      for (let i = 0; i < 256; i++) b[i] = i;
      await r.cmd("SET", "bin", b);
      const back = await r.cmd("GET", "bin");
      return back.length + ":" + (back.every((x, i) => x === i) ? "same" : "differs");
    });
    await t("incr", async () => {
      await r.cmd("DEL", "c");
      await r.cmd("INCR", "c");
      await r.cmd("INCRBY", "c", 41);
      return show(await r.cmd("GET", "c"));
    });
    await t("hash-list", async () => {
      await r.cmd("HSET", "h", "a", "1", "b", "2");
      await r.cmd("RPUSH", "l", "x", "y", "z");
      return JSON.stringify([show(await r.cmd("HGETALL", "h")), show(await r.cmd("LRANGE", "l", 0, -1))]);
    });
    await t("transaction", async () => {
      const res = await r.pipeline([["MULTI"], ["SET", "tx", "1"], ["INCR", "tx"], ["EXEC"]]);
      return JSON.stringify(show(res));
    });
    await t("pipeline-500", async () => {
      const cmds = [];
      for (let i = 0; i < 500; i++) cmds.push(["SET", "p" + i, "v" + i]);
      for (let i = 0; i < 500; i++) cmds.push(["GET", "p" + i]);
      const res = await r.pipeline(cmds);
      return res.slice(500).every((v, i) => dec.decode(v) === "v" + i) ? "ok" : "mismatch";
    });
    await t("large-value", async () => {
      const big = new Uint8Array(1 << 20).fill(97);
      await r.cmd("SET", "big", big);
      const back = await r.cmd("GET", "big");
      return back.length;
    });
    await t("error-reply", async () => {
      try {
        await r.cmd("NOSUCHCOMMAND");
        return "no error";
      } catch (e) {
        return e.message.split(" ")[0] + " " + e.message.split(" ")[1];
      }
    });
    await t("wrongtype", async () => {
      try {
        await r.cmd("LPUSH", "k", "x");
        return "no error";
      } catch (e) {
        return e.message.split(" ")[0];
      }
    });
    await t("after-error", async () => show(await r.cmd("PING")));
    if (n > 0) {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) await r.cmd("GET", "k");
      out.us_per_get = Math.round(((performance.now() - t0) * 1000) / n);
    }
    await t("quit", async () => {
      await r.quit();
      return "ok";
    });
    await t("closed", async () => {
      await r.socket.closed;
      return "resolved";
    });
    return new Response(JSON.stringify(out, null, 1), { headers: { "content-type": "application/json" } });
  },
};
