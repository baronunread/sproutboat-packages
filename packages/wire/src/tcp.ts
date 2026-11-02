/**
 * The TCP tunnel behind `connect()` from `cloudflare:sockets` on the broker transport.
 *
 * A sprout opens a second loopback connection to the broker (the first carries binding
 * calls) and sends one v1 frame, `{ v: 1, token, op: "tcp.open", host, port, mode,
 * servername }`, where mode is `off`, `on` (TLS from the first byte) or `starttls`. The
 * broker answers with one plain JSON frame, `{ ok: true }` or `{ ok: false, error }` (a bad
 * token, too many open sockets, port 25, a malformed target), and from then on both ends
 * speak typed frames, `[u8 type][u32 LE length][payload]`:
 *
 *   sprout -> broker   1 data, 2 startTls (payload: server name), 3 shutdown the write
 *                      side, 7 close
 *   broker -> sprout   1 data, 4 error (payload: reason), 5 connected, 6 TLS done,
 *                      7 closed (the origin connection is gone), 8 end of input (the
 *                      origin half-closed; writes still go through)
 *
 * The origin is resolved here, every address vetted exactly as `fetch()` vets it (private
 * ranges refused unless `SB_EGRESS_ALLOW` says otherwise), and the connection goes to the
 * vetted address, never the name. A refusal or a failed connect arrives as an error frame.
 * TLS (`on`, and `startTls()`) ends in the broker, verified against the server name.
 *
 * Backpressure is TCP's: when the origin cannot take bytes the sprout's socket is paused
 * (its writer blocks), and when the sprout cannot take bytes the origin is paused. Nothing
 * queues beyond one chunk each way, plus a bounded buffer while the origin is connecting.
 *
 * With an egress service configured the broker holds no network of its own: it relays the
 * tunnel, byte for byte, to the service's tunnel endpoint (`listenTunnelService`), which runs
 * this same code with the service's token and does the vetting and connecting.
 */
import { timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import net, { isIP } from "node:net";
import tls from "node:tls";
import { egressRefusal } from "@sproutboat/runtime";
import type { Resolve } from "./egress";
import { isSafeInteger, isString, jsonObject, parseJsonValue, type JsonObject, type JsonValue } from "./json";

export const TCP_DATA = 1;
export const TCP_START_TLS = 2;
export const TCP_SHUTDOWN = 3;
export const TCP_ERROR = 4;
export const TCP_CONNECTED = 5;
export const TCP_TLS_DONE = 6;
export const TCP_CLOSE = 7;
export const TCP_EOF = 8;

/** Open sockets one deployment may hold at once, and how long a connect may take. */
export const TCP_MAX_OPEN = 16;
export const TCP_CONNECT_TIMEOUT_MS = 15_000;
/** The largest typed frame the sprout may send. */
const MAX_TYPED_FRAME = 1024 * 1024;
/** Bytes held for an origin that is still connecting before the sprout is paused. */
const PENDING_LIMIT = 256 * 1024;
const V1 = 1;

/** One typed frame. */
export function typedFrame(type: number, payload: Uint8Array = new Uint8Array(0)): Buffer {
  const out = Buffer.allocUnsafe(5 + payload.length);
  out.writeUInt8(type, 0);
  out.writeUInt32LE(payload.length, 1);
  if (payload.length) out.set(payload, 5);
  return out;
}

/** The plain `[u32 LE length][json]` reply to the opening frame. */
function jsonFrame(obj: JsonObject): Buffer {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32LE(body.length, 0);
  body.copy(out, 4);
  return out;
}

/** The opening frame as a sprout (or a relaying broker) writes it, length header included. */
export function openFrame(head: JsonObject): Buffer {
  const json = Buffer.from(JSON.stringify({ v: 1, ...head }), "utf8");
  const out = Buffer.allocUnsafe(4 + 5 + json.length);
  out.writeUInt32LE(5 + json.length, 0);
  out.writeUInt8(V1, 4);
  out.writeUInt32LE(json.length, 5);
  json.copy(out, 9);
  return out;
}

/** The head of a `tcp.open` payload (marker, json length, json), or null when it is another frame. */
export function parseTcpOpen(payload: Buffer): JsonObject | null {
  if (payload.length < 5 || payload[0] !== V1) return null;
  const jsonLen = payload.readUInt32LE(1);
  if (5 + jsonLen > payload.length) return null;
  const text = payload.subarray(5, 5 + jsonLen).toString("utf8");
  if (!text.includes('"op":"tcp.open"')) return null;
  const msg = jsonObject(parseJsonValue(text));
  return msg && msg.op === "tcp.open" ? msg : null;
}

/** What a tunnel needs of the sprout's connection; a `Bun.Socket` is one. */
export type TunnelPeer = {
  write(data: Uint8Array): number;
  end(): number | void;
  pause(): void;
  resume(): void;
};

/** The listener forwards the sprout socket's events to its tunnel. */
export type Tunnel = {
  data(chunk: Buffer): void;
  drain(): void;
  close(): void;
};

export type TcpOptions = {
  /** Sprouts (or, on the egress service, brokers) must present it in the opening frame. */
  token: string;
  /** `SB_EGRESS_ALLOW`, split. */
  allow?: readonly string[];
  resolve?: Resolve;
  maxOpen?: number;
  connectTimeoutMs?: number;
  /** TLS trust for tests (`ca` for a self-signed server); production verifies against the system roots. */
  tls?: tls.ConnectionOptions;
  /** Injected in tests: connects one vetted address (host here is the IP). */
  connect?: (options: { host: string; port: number; servername?: string; tls: boolean }) => net.Socket;
  /** The egress service's tunnel endpoint and token: relay instead of connecting. */
  relay?: { host: string; port: number; token: string };
};

export type TcpTunnels = {
  /** The sprout's connection carried `head` (a `tcp.open` frame) and `rest` bytes after it. */
  accept(peer: TunnelPeer, head: JsonObject, rest: Buffer, options?: { ack?: boolean }): Tunnel;
  open(): number;
  closeAll(): void;
};

const lookupAll: Resolve = (hostname) => lookup(hostname, { all: true });

function sameToken(given: JsonValue | undefined, expected: string): boolean {
  const a = Buffer.from(isString(given) ? given : "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const reasonOf = (error: Error) => error.message;

export function createTcpTunnels(opts: TcpOptions): TcpTunnels {
  const allow = opts.allow ?? [];
  const resolve = opts.resolve ?? lookupAll;
  const maxOpen = opts.maxOpen ?? TCP_MAX_OPEN;
  const connectTimeout = opts.connectTimeoutMs ?? TCP_CONNECT_TIMEOUT_MS;
  const live = new Set<Tunnel>();

  /** Vets every address of `host` and returns the usable ones, or throws the refusal. */
  async function vetted(host: string): Promise<string[]> {
    const name = host.replace(/^\[|\]$/g, "");
    let addresses: Array<{ address: string }>;
    if (isIP(name)) addresses = [{ address: name }];
    else {
      try {
        addresses = await resolve(name);
      } catch {
        throw new Error(`could not resolve ${host}`);
      }
    }
    let refusal: string | null = null;
    const ok = addresses.filter(({ address }) => {
      const why = egressRefusal(host, address, allow);
      refusal ??= why;
      return why === null;
    });
    if (ok.length === 0) throw new Error((refusal ?? `could not resolve ${host}`).replace(/^fetch\(\)/, "connect()"));
    return ok.map(({ address }) => address);
  }

  /** One attempt at one vetted address, within `ms`. TLS (`secure`) is verified against `servername`. */
  function attempt(host: string, port: number, servername: string, secure: boolean, ms: number): Promise<net.Socket> {
    return new Promise((done, fail) => {
      const options = { host, port, allowHalfOpen: true };
      const name = isIP(servername.replace(/^\[|\]$/g, "")) ? undefined : servername;
      let socket: net.Socket;
      if (opts.connect) socket = opts.connect({ host, port, servername: name, tls: secure });
      else if (secure) socket = tls.connect({ ...options, servername: name, ...opts.tls });
      else socket = net.connect(options);
      const timer = setTimeout(() => {
        socket.destroy();
        fail(new Error("connect timed out"));
      }, ms);
      const ready = secure ? "secureConnect" : "connect";
      socket.once(ready, () => {
        clearTimeout(timer);
        socket.removeListener("error", onError);
        done(socket);
      });
      const onError = (error: Error) => {
        clearTimeout(timer);
        socket.destroy();
        fail(error);
      };
      socket.once("error", onError);
    });
  }

  function accept(peer: TunnelPeer, head: JsonObject, rest: Buffer, flags: { ack?: boolean } = {}): Tunnel {
    const sendAck = flags.ack !== false;
    let closed = false;
    let origin: net.Socket | null = null;
    let connected = false;
    let upgraded = false;
    let originPaused = false;
    let peerPaused = false;
    let awaitingOriginDrain = false;
    let shutdownRequested = false;
    let pendingBytes = 0;
    const pending: Buffer[] = [];
    const out: Buffer[] = [];
    let inbox: Buffer = Buffer.alloc(0);
    let ending = false;

    const tunnel: Tunnel = { data, drain, close };
    const refuse = (error: string) => {
      peer.write(jsonFrame({ ok: false, error }));
      peer.end();
      return tunnel;
    };

    // --- toward the sprout
    const pauseOrigin = () => {
      if (!origin || originPaused) return;
      originPaused = true;
      origin.pause();
    };
    const resumeOrigin = () => {
      if (!origin || !originPaused) return;
      originPaused = false;
      origin.resume();
    };
    const send = (frame: Buffer) => {
      if (closed) return;
      if (out.length > 0) {
        out.push(frame);
        return;
      }
      const n = Math.max(0, peer.write(frame));
      if (n < frame.length) {
        out.push(frame.subarray(n));
        pauseOrigin();
      }
    };
    function drain() {
      while (out.length > 0) {
        const frame = out[0];
        const n = Math.max(0, peer.write(frame));
        if (n < frame.length) {
          out[0] = frame.subarray(n);
          return;
        }
        out.shift();
      }
      resumeOrigin();
      if (ending) peer.end();
    }
    const finish = () => {
      if (ending) return;
      ending = true;
      if (out.length === 0) peer.end();
    };

    // --- toward the origin
    const pausePeer = () => {
      if (peerPaused) return;
      peerPaused = true;
      peer.pause();
    };
    const resumePeer = () => {
      if (!peerPaused || awaitingOriginDrain || pendingBytes > 0) return;
      peerPaused = false;
      peer.resume();
    };
    const toOrigin = (buf: Buffer) => {
      if (closed) return;
      if (!origin || !connected) {
        pending.push(buf);
        pendingBytes += buf.length;
        if (pendingBytes > PENDING_LIMIT) pausePeer();
        return;
      }
      if (!origin.write(buf)) {
        awaitingOriginDrain = true;
        pausePeer();
      }
    };
    const flushPending = () => {
      for (const buf of pending.splice(0)) toOrigin(buf);
      pendingBytes = 0;
      if (shutdownRequested) origin?.end();
      resumePeer();
    };

    const relaying = opts.relay !== undefined;

    function bind(socket: net.Socket) {
      origin = socket;
      originPaused = false;
      socket.on("data", (chunk: Buffer) => send(relaying ? chunk : typedFrame(TCP_DATA, chunk)));
      socket.on("end", () => {
        if (!relaying) send(typedFrame(TCP_EOF));
        else {
          // the service ends its side only after the origin is fully closed
          socket.end();
          finish();
        }
      });
      socket.on("drain", () => {
        awaitingOriginDrain = false;
        resumePeer();
      });
      socket.on("error", (error: Error) => {
        send(typedFrame(TCP_ERROR, Buffer.from(reasonOf(error))));
      });
      socket.on("close", () => {
        if (!relaying) send(typedFrame(TCP_CLOSE));
        finish();
        cleanup();
      });
    }

    function cleanup() {
      closed = true;
      live.delete(tunnel);
      origin?.destroy();
    }

    function close() {
      closed = true;
      pending.length = 0;
      out.length = 0;
      live.delete(tunnel);
      origin?.destroy();
    }

    // --- typed frames from the sprout
    function startTls(servername: string) {
      if (head.mode !== "starttls" || upgraded || !origin || !connected) {
        send(typedFrame(TCP_ERROR, Buffer.from("startTls is not available on this socket")));
        return;
      }
      upgraded = true;
      const raw = origin;
      raw.removeAllListeners();
      raw.on("error", () => {});
      const name = isIP(servername.replace(/^\[|\]$/g, "")) ? undefined : servername;
      const secure = tls.connect({ socket: raw, servername: name, ...opts.tls });
      bind(secure);
      secure.once("secureConnect", () => send(typedFrame(TCP_TLS_DONE)));
    }

    function frames() {
      for (;;) {
        if (closed || inbox.length < 5) return;
        const type = inbox[0];
        const len = inbox.readUInt32LE(1);
        if (len > MAX_TYPED_FRAME) {
          send(typedFrame(TCP_ERROR, Buffer.from("frame too large")));
          close();
          peer.end();
          return;
        }
        if (inbox.length < 5 + len) return;
        const payload = inbox.subarray(5, 5 + len);
        inbox = inbox.subarray(5 + len);
        if (type === TCP_DATA) toOrigin(Buffer.from(payload));
        else if (type === TCP_START_TLS) startTls(payload.toString("utf8"));
        else if (type === TCP_SHUTDOWN) {
          shutdownRequested = true;
          if (connected && pending.length === 0) origin?.end();
        } else if (type === TCP_CLOSE) {
          close();
          peer.end();
          return;
        }
      }
    }

    function data(chunk: Buffer) {
      if (closed) return;
      if (relaying) {
        toOrigin(chunk);
        return;
      }
      inbox = inbox.length === 0 ? chunk : Buffer.concat([inbox, chunk]);
      frames();
    }

    // --- admission
    if (!sameToken(head.token, opts.token)) {
      if (!sendAck) {
        peer.write(typedFrame(TCP_ERROR, Buffer.from("unauthorized")));
        peer.end();
        return tunnel;
      }
      return refuse("unauthorized");
    }
    const host = isString(head.host) ? head.host : "";
    const port = isSafeInteger(head.port) ? head.port : Number.NaN;
    const mode = head.mode === "on" || head.mode === "starttls" || head.mode === "off" ? head.mode : null;
    const servername = isString(head.servername) && head.servername ? head.servername : host;
    let invalid: string | null = null;
    if (live.size >= maxOpen) invalid = "Too many open connections";
    else if (!host || host.length > 255 || mode === null) invalid = "invalid tunnel target";
    else if (!Number.isInteger(port) || port < 1 || port > 65535) invalid = "invalid tunnel port";
    else if (port === 25) invalid = "connect() refused: port 25 is blocked, as on Workers";
    if (invalid !== null) {
      if (!sendAck) {
        peer.write(typedFrame(TCP_ERROR, Buffer.from(invalid)));
        peer.end();
        return tunnel;
      }
      return refuse(invalid);
    }
    if (sendAck) peer.write(jsonFrame({ ok: true }));
    live.add(tunnel);
    if (rest.length > 0) data(rest);

    // --- connecting
    void (async () => {
      try {
        if (relaying) {
          const relay = opts.relay!;
          const socket = await attempt(relay.host, relay.port, "", false, connectTimeout);
          if (closed) {
            socket.destroy();
            return;
          }
          bind(socket);
          connected = true;
          const opening = openFrame({ token: relay.token, op: "tcp.open", host, port, mode, servername });
          socket.write(opening);
          flushPending();
          return;
        }
        const addresses = await vetted(host);
        const deadline = Date.now() + connectTimeout;
        let socket: net.Socket | null = null;
        let last = new Error("connect timed out");
        for (const address of addresses) {
          const left = deadline - Date.now();
          if (left <= 0) break;
          try {
            socket = await attempt(address, port, servername, mode === "on", left);
            break;
          } catch (error) {
            last = error instanceof Error ? error : new Error("connect failed");
          }
        }
        if (closed) {
          socket?.destroy();
          return;
        }
        if (!socket) throw last;
        bind(socket);
        connected = true;
        send(typedFrame(TCP_CONNECTED));
        flushPending();
      } catch (error) {
        if (closed) return;
        send(typedFrame(TCP_ERROR, Buffer.from(error instanceof Error ? reasonOf(error) : "connect failed")));
        finish();
        cleanup();
      }
    })();
    return tunnel;
  }

  return {
    accept,
    open: () => live.size,
    closeAll() {
      for (const tunnel of live) tunnel.close();
    },
  };
}

type ServiceState = { head: Buffer; tunnel: Tunnel | null };

/**
 * The egress service's tunnel endpoint: a raw TCP listener whose first frame is the broker's
 * `tcp.open`, answered with the typed frames directly (no ack; a refusal is an error frame).
 */
export function listenTunnelService(tunnels: TcpTunnels, hostname: string, port: number) {
  const server = Bun.listen<ServiceState>({
    hostname,
    port,
    socket: {
      open(socket) {
        socket.data = { head: Buffer.alloc(0), tunnel: null };
      },
      data(socket, chunk) {
        const state = socket.data;
        if (state.tunnel) {
          state.tunnel.data(chunk);
          return;
        }
        state.head = Buffer.concat([state.head, chunk]);
        if (state.head.length < 4) return;
        const len = state.head.readUInt32LE(0);
        if (len > 64 * 1024) {
          socket.end();
          return;
        }
        if (state.head.length < 4 + len) return;
        const open = parseTcpOpen(state.head.subarray(4, 4 + len));
        if (!open) {
          socket.write(typedFrame(TCP_ERROR, Buffer.from("expected tcp.open")));
          socket.end();
          return;
        }
        state.tunnel = tunnels.accept(socket, open, Buffer.from(state.head.subarray(4 + len)), { ack: false });
        state.head = Buffer.alloc(0);
      },
      drain(socket) {
        socket.data.tunnel?.drain();
      },
      close(socket) {
        socket.data.tunnel?.close();
      },
    },
  });
  return { port: server.port, stop: () => server.stop(true) };
}
