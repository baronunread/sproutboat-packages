import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { createBroker, listen } from "./broker";
import type { JsonObject } from "./json";
import {
  TCP_CLOSE,
  TCP_CONNECTED,
  TCP_DATA,
  TCP_EOF,
  TCP_ERROR,
  TCP_SHUTDOWN,
  TCP_START_TLS,
  TCP_TLS_DONE,
  createTcpTunnels,
  listenTunnelService,
  openFrame,
  typedFrame,
} from "./tcp";

const TOKEN = "tunnel-test-token";
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

type Frame = { type: number; payload: Buffer };

/** A sprout's end of a tunnel: the opening frame, the ack, then typed frames. */
async function openTunnel(port: number, head: JsonObject, rawEgress = false) {
  let buffered = Buffer.alloc(0);
  let ack: { ok: boolean; error?: string } | null = null;
  const frames: Frame[] = [];
  let waiter: (() => void) | null = null;
  let ended = false;
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_s, chunk) {
        buffered = Buffer.concat([buffered, chunk]);
        for (;;) {
          if (!ack && !rawEgress) {
            if (buffered.length < 4) break;
            const len = buffered.readUInt32LE(0);
            if (buffered.length < 4 + len) break;
            ack = JSON.parse(buffered.subarray(4, 4 + len).toString());
            buffered = buffered.subarray(4 + len);
            continue;
          }
          if (buffered.length < 5) break;
          const len = buffered.readUInt32LE(1);
          if (buffered.length < 5 + len) break;
          frames.push({ type: buffered[0], payload: Buffer.from(buffered.subarray(5, 5 + len)) });
          buffered = buffered.subarray(5 + len);
        }
        waiter?.();
      },
      close() {
        ended = true;
        waiter?.();
      },
      drain() {},
    },
  });
  socket.write(openFrame({ token: TOKEN, op: "tcp.open", ...head }));
  stops.push(() => socket.end());
  const until = async (done: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!done()) {
      if (Date.now() > end) throw new Error(`timed out; frames ${JSON.stringify(frames.map((f) => f.type))}`);
      await new Promise<void>((resolve) => {
        waiter = resolve;
        setTimeout(resolve, 20);
      });
    }
  };
  return {
    socket,
    frames,
    ack: async () => {
      await until(() => ack !== null);
      return ack!;
    },
    send: (type: number, payload: Uint8Array = new Uint8Array(0)) => socket.write(typedFrame(type, payload)),
    /** The next frame, removed. */
    next: async (ms?: number) => {
      await until(() => frames.length > 0, ms);
      return frames.shift()!;
    },
    /** Reads data frames until `bytes` arrived. */
    read: async (bytes: number, ms = 10000) => {
      const parts: Buffer[] = [];
      let got = 0;
      while (got < bytes) {
        const f = await (async () => {
          await until(() => frames.length > 0, ms);
          return frames.shift()!;
        })();
        if (f.type !== TCP_DATA) throw new Error(`unexpected frame ${f.type}: ${f.payload}`);
        parts.push(f.payload);
        got += f.payload.length;
      }
      return Buffer.concat(parts);
    },
    closed: () => until(() => ended),
  };
}

function brokerOn(options: Parameters<typeof createBroker>[0] = {}) {
  const broker = createBroker({ token: TOKEN, egressAllow: ["127.0.0.1"], ...options });
  const server = listen(broker, "127.0.0.1", 0);
  stops.push(() => {
    server.stop();
    broker.close();
  });
  return { broker, server };
}

/** A plain TCP origin on loopback: echoes by default. */
function origin(onSocket?: (socket: net.Socket) => void, allowHalfOpen = false) {
  const sockets: net.Socket[] = [];
  const server = net.createServer({ allowHalfOpen }, (socket) => {
    sockets.push(socket);
    if (onSocket) onSocket(socket);
    else socket.pipe(socket);
  });
  server.listen(0, "127.0.0.1");
  stops.push(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  // SAFETY: a listening TCP server's address() is an AddressInfo.
  return { server, sockets, port: () => (server.address() as net.AddressInfo).port };
}

const target = (port: number, extra: JsonObject = {}) => ({
  host: "127.0.0.1",
  port,
  mode: "off",
  servername: "127.0.0.1",
  ...extra,
});

test("a tunnel acks, reports connected, echoes bytes and closes with the sprout", async () => {
  const echo = origin();
  const { server, broker } = brokerOn();
  const t = await openTunnel(server.port, target(echo.port()));
  expect(await t.ack()).toEqual({ ok: true });
  expect((await t.next()).type).toBe(TCP_CONNECTED);
  t.send(TCP_DATA, Buffer.from("hello"));
  expect((await t.read(5)).toString()).toBe("hello");
  expect(broker.tcp.open()).toBe(1);
  t.socket.end();
  const end = Date.now() + 3000;
  while (broker.tcp.open() > 0 && Date.now() < end) await Bun.sleep(10);
  expect(broker.tcp.open()).toBe(0);
  // the origin saw the connection go away
  const until = Date.now() + 3000;
  while (echo.sockets[0] && !echo.sockets[0].destroyed && Date.now() < until) await Bun.sleep(10);
  expect(echo.sockets[0].destroyed).toBe(true);
});

test("bytes sent right after the opening frame wait for the origin", async () => {
  const echo = origin();
  const { server } = brokerOn();
  const t = await openTunnel(server.port, target(echo.port()));
  t.send(TCP_DATA, Buffer.from("early"));
  expect(await t.ack()).toEqual({ ok: true });
  expect((await t.next()).type).toBe(TCP_CONNECTED);
  expect((await t.read(5)).toString()).toBe("early");
});

test("half-close both ways: the sprout shuts its write side and still reads the reply", async () => {
  // the origin answers only once it sees the end of the sprout's input
  const seen = origin((socket) => {
    const parts: Buffer[] = [];
    socket.on("data", (c) => parts.push(c));
    socket.on("end", () => socket.end(`got ${Buffer.concat(parts).toString()}`));
  }, true);
  const { server } = brokerOn();
  const t = await openTunnel(server.port, target(seen.port()));
  await t.ack();
  await t.next();
  t.send(TCP_DATA, Buffer.from("one two"));
  t.send(TCP_SHUTDOWN);
  expect((await t.read(11)).toString()).toBe("got one two");
  expect((await t.next()).type).toBe(TCP_EOF);
  expect((await t.next()).type).toBe(TCP_CLOSE);
  await t.closed();
});

test("the origin half-closes first: end of input arrives, writes still reach it", async () => {
  const got: Buffer[] = [];
  const o = origin((socket) => {
    socket.write("hi");
    socket.end();
    socket.on("data", (c) => got.push(c));
  }, true);
  const { server } = brokerOn();
  const t = await openTunnel(server.port, target(o.port()));
  await t.ack();
  await t.next();
  expect((await t.read(2)).toString()).toBe("hi");
  expect((await t.next()).type).toBe(TCP_EOF);
  t.send(TCP_DATA, Buffer.from("still here"));
  const end = Date.now() + 3000;
  while (Buffer.concat(got).length < 10 && Date.now() < end) await Bun.sleep(10);
  expect(Buffer.concat(got).toString()).toBe("still here");
});

test("a refused connect is an error frame with the reason", async () => {
  const closed = net.createServer();
  closed.listen(0, "127.0.0.1");
  await new Promise((r) => closed.once("listening", r));
  // SAFETY: a listening TCP server's address() is an AddressInfo.
  const port = (closed.address() as net.AddressInfo).port;
  closed.close();
  await new Promise((r) => closed.once("close", r));
  const { server } = brokerOn();
  const t = await openTunnel(server.port, target(port));
  expect(await t.ack()).toEqual({ ok: true });
  const frame = await t.next();
  expect(frame.type).toBe(TCP_ERROR);
  expect(frame.payload.toString()).toMatch(/ECONNREFUSED|refused/i);
});

test("the connect timeout ends a socket that never connects", async () => {
  const { server, broker } = brokerOn({
    tcp: { connectTimeoutMs: 80, connect: () => new net.Socket() },
  });
  const t = await openTunnel(server.port, target(9));
  await t.ack();
  const frame = await t.next();
  expect(frame.type).toBe(TCP_ERROR);
  expect(frame.payload.toString()).toBe("connect timed out");
  await t.closed();
  expect(broker.tcp.open()).toBe(0);
});

test("vetting: every address is checked like fetch, private ranges are refused", async () => {
  const { server } = brokerOn({ egressAllow: [] });
  for (const [host, cidr] of [
    ["127.0.0.1", "127.0.0.0/8"],
    ["169.254.169.254", "169.254.0.0/16"],
    ["10.1.2.3", "10.0.0.0/8"],
    ["[::1]", "::/96"],
  ]) {
    const t = await openTunnel(server.port, target(80, { host, servername: host }));
    expect(await t.ack()).toEqual({ ok: true });
    const frame = await t.next();
    expect(frame.type).toBe(TCP_ERROR);
    expect(frame.payload.toString()).toContain("connect() refused");
    expect(frame.payload.toString()).toContain(cidr);
  }
});

test("vetting: a name that resolves to a private address is refused, a mixed answer connects to the vetted one only", async () => {
  const attempts: string[] = [];
  const echo = origin();
  const { server } = brokerOn({
    egressAllow: ["127.0.0.1"],
    resolveImpl: async (name) =>
      name === "rebind.test"
        ? [{ address: "10.9.8.7" }, { address: "127.0.0.1" }]
        : name === "private.test"
          ? [{ address: "192.168.0.5" }]
          : [],
    tcp: {
      connect: ({ host, port }) => {
        attempts.push(host);
        return net.connect({ host, port, allowHalfOpen: true });
      },
    },
  });
  const refused = await openTunnel(
    server.port,
    target(echo.port(), { host: "private.test", servername: "private.test" }),
  );
  await refused.ack();
  const frame = await refused.next();
  expect(frame.payload.toString()).toContain("private.test resolves to 192.168.0.5");
  const mixed = await openTunnel(server.port, target(echo.port(), { host: "rebind.test", servername: "rebind.test" }));
  await mixed.ack();
  expect((await mixed.next()).type).toBe(TCP_CONNECTED);
  mixed.send(TCP_DATA, Buffer.from("ok"));
  expect((await mixed.read(2)).toString()).toBe("ok");
  // the connection went to the vetted address, never the private one nor the name
  expect(attempts).toEqual(["127.0.0.1"]);
  const gone = await openTunnel(server.port, target(80, { host: "nowhere.test", servername: "nowhere.test" }));
  await gone.ack();
  expect((await gone.next()).payload.toString()).toBe("could not resolve nowhere.test");
});

test("the opening frame is checked: token, port 25, the port and mode, and the open-socket limit", async () => {
  const echo = origin();
  const { server } = brokerOn({ tcp: { maxOpen: 2 } });
  const open = async (head: JsonObject, token = TOKEN) => {
    const t = await openTunnel(server.port, { ...target(echo.port()), ...head, token });
    return { t, ack: await t.ack() };
  };
  expect((await open({}, "not-the-token")).ack).toEqual({ ok: false, error: "unauthorized" });
  expect((await open({ port: 25 })).ack.error).toContain("port 25");
  expect((await open({ port: 70000 })).ack.error).toBe("invalid tunnel port");
  expect((await open({ port: 0 })).ack.error).toBe("invalid tunnel port");
  expect((await open({ mode: "weird" })).ack.error).toBe("invalid tunnel target");
  expect((await open({ host: "" })).ack.error).toBe("invalid tunnel target");
  const a = await open({});
  const b = await open({});
  expect([a.ack.ok, b.ack.ok]).toEqual([true, true]);
  const c = await open({});
  expect(c.ack).toEqual({ ok: false, error: "Too many open connections" });
  // closing one frees a slot
  a.t.socket.end();
  await Bun.sleep(100);
  expect((await open({})).ack.ok).toBe(true);
});

test("sixteen open sockets per deployment by default", async () => {
  const echo = origin();
  const { server } = brokerOn();
  const tunnels = [];
  for (let i = 0; i < 16; i++) {
    const t = await openTunnel(server.port, target(echo.port()));
    expect((await t.ack()).ok).toBe(true);
    tunnels.push(t);
  }
  const extra = await openTunnel(server.port, target(echo.port()));
  expect((await extra.ack()).error).toBe("Too many open connections");
});

test("an old-style frame on the same listener still works next to tunnels", async () => {
  const echo = origin();
  const { server, broker } = brokerOn();
  const t = await openTunnel(server.port, target(echo.port()));
  await t.ack();
  const reply = await broker.handlePayload(`${TOKEN}\n${JSON.stringify({ op: "ping" })}`);
  expect(reply.ok).toBe(true);
});

// --- TLS --------------------------------------------------------------------

let cert = "";
let key = "";
let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sb-tcp-test-"));
  const made = Bun.spawnSync([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(dir, "key.pem"),
    "-out",
    join(dir, "cert.pem"),
    "-days",
    "2",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost",
  ]);
  if (made.exitCode !== 0) throw new Error(`openssl failed: ${made.stderr}`);
  cert = readFileSync(join(dir, "cert.pem"), "utf8");
  key = readFileSync(join(dir, "key.pem"), "utf8");
  rmSync(dir, { recursive: true, force: true });
});

function tlsOrigin() {
  const server = tls.createServer({ key, cert, allowHalfOpen: true }, (socket) => {
    socket.on("data", (c) => socket.write(c));
    socket.on("error", () => {});
  });
  server.listen(0, "127.0.0.1");
  stops.push(() => server.close());
  // SAFETY: a listening TCP server's address() is an AddressInfo.
  return { port: () => (server.address() as net.AddressInfo).port };
}

test("TLS on: the broker verifies the certificate against the server name and carries plaintext", async () => {
  const o = tlsOrigin();
  const { server } = brokerOn({ tcp: { tls: { ca: cert } } });
  const t = await openTunnel(server.port, target(o.port(), { mode: "on", host: "localhost", servername: "localhost" }));
  expect(await t.ack()).toEqual({ ok: true });
  expect((await t.next()).type).toBe(TCP_CONNECTED);
  t.send(TCP_DATA, Buffer.from("secret"));
  expect((await t.read(6)).toString()).toBe("secret");
});

test("TLS on: a certificate for another name, or an untrusted one, is an error frame", async () => {
  const o = tlsOrigin();
  const trusting = brokerOn({ tcp: { tls: { ca: cert } } });
  const wrongName = await openTunnel(
    trusting.server.port,
    target(o.port(), { mode: "on", host: "127.0.0.1", servername: "other.example" }),
  );
  await wrongName.ack();
  const mismatch = await wrongName.next();
  expect(mismatch.type).toBe(TCP_ERROR);
  expect(mismatch.payload.toString()).toMatch(/altnames|hostname|identity|certificate/i);
  const plain = brokerOn();
  const untrusted = await openTunnel(
    plain.server.port,
    target(o.port(), { mode: "on", host: "localhost", servername: "localhost" }),
  );
  await untrusted.ack();
  const frame = await untrusted.next();
  expect(frame.type).toBe(TCP_ERROR);
  expect(frame.payload.toString()).toMatch(/self.signed|unable to verify|certificate|trust/i);
});

test("startTls: plaintext greeting, then the upgrade is verified and the rest is encrypted", async () => {
  const wire: string[] = [];
  const o = origin((socket) => {
    socket.write("220 hello\r\n");
    socket.once("data", (first) => {
      wire.push(first.toString());
      socket.write("go\r\n");
      const secure = new tls.TLSSocket(socket, { isServer: true, key, cert });
      secure.on("data", (c) => secure.write(Buffer.concat([Buffer.from("tls:"), c])));
      secure.on("error", () => {});
    });
  });
  const { server } = brokerOn({ tcp: { tls: { ca: cert } } });
  const t = await openTunnel(
    server.port,
    target(o.port(), { mode: "starttls", host: "localhost", servername: "localhost" }),
  );
  await t.ack();
  expect((await t.next()).type).toBe(TCP_CONNECTED);
  expect((await t.read(0 + 11)).toString()).toBe("220 hello\r\n");
  t.send(TCP_DATA, Buffer.from("STARTTLS\r\n"));
  expect((await t.read(4)).toString()).toBe("go\r\n");
  t.send(TCP_START_TLS, Buffer.from("localhost"));
  expect((await t.next()).type).toBe(TCP_TLS_DONE);
  t.send(TCP_DATA, Buffer.from("ping"));
  expect((await t.read(8)).toString()).toBe("tls:ping");
  expect(wire).toEqual(["STARTTLS\r\n"]);
});

test("startTls with a name the certificate does not carry fails", async () => {
  const o = origin((socket) => {
    const secure = new tls.TLSSocket(socket, { isServer: true, key, cert });
    secure.on("error", () => {});
  });
  const { server } = brokerOn({ tcp: { tls: { ca: cert } } });
  const t = await openTunnel(
    server.port,
    target(o.port(), { mode: "starttls", host: "localhost", servername: "localhost" }),
  );
  await t.ack();
  await t.next();
  t.send(TCP_START_TLS, Buffer.from("wrong.example"));
  const frame = await t.next();
  expect(frame.type).toBe(TCP_ERROR);
});

test("startTls is refused when the socket was not opened with starttls", async () => {
  const echo = origin();
  const { server } = brokerOn();
  const t = await openTunnel(server.port, target(echo.port()));
  await t.ack();
  await t.next();
  t.send(TCP_START_TLS, Buffer.from("localhost"));
  const frame = await t.next();
  expect(frame.type).toBe(TCP_ERROR);
  expect(frame.payload.toString()).toContain("startTls");
});

// --- backpressure -----------------------------------------------------------

test("backpressure toward the sprout: an origin that floods a sprout that is not reading is held back", async () => {
  let written = 0;
  let blocked = false;
  const chunk = Buffer.alloc(64 * 1024, 7);
  const o = origin((socket) => {
    const pump = () => {
      while (written < 512 * 1024 * 1024) {
        written += chunk.length;
        if (!socket.write(chunk)) {
          blocked = true;
          socket.once("drain", pump);
          return;
        }
      }
    };
    pump();
  });
  const { server } = brokerOn();
  const t = await openTunnel(server.port, target(o.port()));
  await t.ack();
  // Stop reading from the tunnel: its socket is paused, so the broker must stop reading the origin.
  t.socket.pause();
  await Bun.sleep(800);
  const heldAt = written;
  expect(blocked).toBe(true);
  expect(heldAt).toBeLessThan(32 * 1024 * 1024);
  await Bun.sleep(300);
  expect(written).toBe(heldAt);
  // resume: bytes flow again, in order
  t.socket.resume();
  let total = 0;
  while (total < heldAt + chunk.length * 2) {
    const before = t.frames.length;
    await Bun.sleep(5);
    total = t.frames.reduce((n, f) => n + (f.type === TCP_DATA ? f.payload.length : 0), 0);
    if (written >= 512 * 1024 * 1024 && t.frames.length === before) break;
    t.frames.splice(0, t.frames.length - 1000);
  }
  expect(written).toBeGreaterThan(heldAt);
}, 30000);

test("backpressure toward the origin: a sprout that floods an origin that is not reading is held back", async () => {
  let received = 0;
  let theSocket: net.Socket | null = null;
  const o = origin((socket) => {
    theSocket = socket;
    socket.pause();
    socket.on("data", (c) => (received += c.length));
  });
  const { server } = brokerOn();
  const t = await openTunnel(server.port, target(o.port()));
  await t.ack();
  await t.next();
  const payload = 64 * 1024;
  const chunk = typedFrame(TCP_DATA, Buffer.alloc(payload, 9));
  let backlog: Buffer = Buffer.alloc(0);
  let completed = 0;
  let pushed = 0;
  // The sprout's writer, like the C thread: write until the kernel says no, retry later.
  const writeSome = (limit: number) => {
    for (let i = 0; i < limit; i++) {
      if (backlog.length === 0) backlog = chunk;
      const n = Math.max(0, t.socket.write(backlog));
      pushed += n;
      if (n < backlog.length) {
        backlog = backlog.subarray(n);
        return false;
      }
      backlog = Buffer.alloc(0);
      completed++;
    }
    return true;
  };
  let stalled = false;
  while (!stalled && pushed < 1024 * 1024 * 1024) {
    if (!writeSome(256)) {
      const before = pushed;
      await Bun.sleep(400);
      writeSome(256);
      if (pushed - before < chunk.length) stalled = true;
    }
  }
  expect(stalled).toBe(true);
  // held at a few MiB of kernel buffers, nowhere near unbounded
  expect(pushed).toBeLessThan(32 * 1024 * 1024);
  // The origin reads again: the rest of the pushed frames arrive, none lost.
  theSocket!.resume();
  for (let i = 0; i < 400 && completed < 200; i++) {
    writeSome(16);
    await Bun.sleep(10);
  }
  // Stop pushing once the in-flight frame is whole.
  for (let i = 0; i < 200 && backlog.length > 0; i++) {
    writeSome(1);
    await Bun.sleep(10);
  }
  const want = completed * payload;
  const deadline = Date.now() + 15000;
  while (received < want && Date.now() < deadline) await Bun.sleep(20);
  expect(received).toBe(want);
}, 60000);

test("closing the sprout's connection while data is queued tears the origin down", async () => {
  let sockets = 0;
  const o = origin((socket) => {
    sockets++;
    socket.pause();
  });
  const { server, broker } = brokerOn();
  const t = await openTunnel(server.port, target(o.port()));
  await t.ack();
  await t.next();
  for (let i = 0; i < 64; i++) t.send(TCP_DATA, Buffer.alloc(64 * 1024));
  t.socket.end();
  const end = Date.now() + 3000;
  while (broker.tcp.open() > 0 && Date.now() < end) await Bun.sleep(10);
  expect(sockets).toBe(1);
  expect(broker.tcp.open()).toBe(0);
});

// --- the egress service -----------------------------------------------------

test("egress service: the broker relays tunnels to it and the service does the vetting", async () => {
  const echo = origin();
  const service = listenTunnelService(
    createTcpTunnels({ token: "egress-secret", allow: ["127.0.0.1"] }),
    "127.0.0.1",
    0,
  );
  stops.push(() => service.stop());
  // The broker itself allows nothing: with an egress URL it must not vet or connect on its own.
  const { server, broker } = brokerOn({
    egressAllow: [],
    egressUrl: "http://127.0.0.1:1",
    egressToken: "egress-secret",
    egressTcp: `127.0.0.1:${service.port}`,
  });
  const t = await openTunnel(server.port, target(echo.port()));
  expect(await t.ack()).toEqual({ ok: true });
  expect((await t.next()).type).toBe(TCP_CONNECTED);
  t.send(TCP_DATA, Buffer.from("via egress"));
  expect((await t.read(10)).toString()).toBe("via egress");
  expect(broker.tcp.open()).toBe(1);
  t.send(TCP_SHUTDOWN);
  expect((await t.next()).type).toBe(TCP_EOF);
  expect((await t.next()).type).toBe(TCP_CLOSE);
  await t.closed();
});

test("egress service: the same refusals, port 25 and the broker's token rule apply", async () => {
  const service = listenTunnelService(createTcpTunnels({ token: "egress-secret" }), "127.0.0.1", 0);
  stops.push(() => service.stop());
  const { server } = brokerOn({
    egressUrl: "http://127.0.0.1:1",
    egressToken: "egress-secret",
    egressTcp: `127.0.0.1:${service.port}`,
  });
  const meta = await openTunnel(server.port, target(80, { host: "169.254.169.254" }));
  await meta.ack();
  const refused = await meta.next();
  expect(refused.type).toBe(TCP_ERROR);
  expect(refused.payload.toString()).toContain("connect() refused: 169.254.169.254 resolves to 169.254.169.254");
  const smtp = await openTunnel(server.port, target(25));
  expect((await smtp.ack()).error).toContain("port 25");
  const stranger = await openTunnel(server.port, target(80), false);
  stranger.socket.end();
});

test("egress service: a broker with the wrong token gets an error frame, and an unreachable service too", async () => {
  const service = listenTunnelService(createTcpTunnels({ token: "egress-secret" }), "127.0.0.1", 0);
  stops.push(() => service.stop());
  const wrong = brokerOn({
    egressUrl: "http://127.0.0.1:1",
    egressToken: "not-the-egress-secret",
    egressTcp: `127.0.0.1:${service.port}`,
  });
  const a = await openTunnel(wrong.server.port, target(80));
  await a.ack();
  const denied = await a.next();
  expect([denied.type, denied.payload.toString()]).toEqual([TCP_ERROR, "unauthorized"]);
  const down = brokerOn({ egressUrl: "http://127.0.0.1:1", egressToken: "x", egressTcp: "127.0.0.1:1" });
  const b = await openTunnel(down.server.port, target(80));
  await b.ack();
  expect((await b.next()).type).toBe(TCP_ERROR);
});
