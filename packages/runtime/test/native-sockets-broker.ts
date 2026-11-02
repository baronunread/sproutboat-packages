import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import tls from "node:tls";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { createBroker, listen } from "../../wire/src/broker";
import { EMPTY_BINDINGS, preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// cloudflare:sockets connect() on the broker transport (compatibility date 2026-11-17): a
// sprout built with the broker transport opens a second loopback connection to the broker per
// socket, and the broker vets the address, connects, and terminates TLS. Local servers play the
// origins: an echo, a server that answers once it sees the end of input, a STARTTLS server and a
// TLS echo. The handler is what a driver does; measurements are printed at the end.
const handler = `
import { connect } from "cloudflare:sockets";
const enc = new TextEncoder();
const dec = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT " + what)), ms))]);
async function readN(reader, n) {
  let out = "";
  while (out.length < n) {
    const r = await reader.read();
    if (r.done) return out;
    out += dec.decode(r.value);
  }
  return out;
}
async function readAll(reader) {
  let out = "";
  for (;;) {
    const r = await reader.read();
    if (r.done) return out;
    out += dec.decode(r.value);
  }
}
const held = [];
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const q = url.searchParams;
    const port = Number(q.get("port"));
    try {
      if (url.pathname === "/ping") return new Response("pong");
      if (url.pathname === "/echo") {
        const s = connect("127.0.0.1:" + port);
        const w = s.writable.getWriter();
        const r = s.readable.getReader();
        const info = await withTimeout(s.opened, 5000, "opened");
        await w.write(enc.encode("hello\\n"));
        const got = await withTimeout(readN(r, 6), 5000, "echo");
        await s.close();
        return Response.json({ got, remote: typeof info.remoteAddress });
      }
      if (url.pathname === "/halfclose") {
        const s = connect({ hostname: "127.0.0.1", port }, { allowHalfOpen: true });
        const w = s.writable.getWriter();
        const r = s.readable.getReader();
        await w.write(enc.encode("one two"));
        await w.close();
        const got = await withTimeout(readAll(r), 5000, "halfclose");
        await s.close().catch(() => {});
        return Response.json({ got });
      }
      if (url.pathname === "/starttls") {
        const s = connect("127.0.0.1:" + port, { secureTransport: "starttls" });
        const w = s.writable.getWriter();
        const r = s.readable.getReader();
        const greeting = await withTimeout(readN(r, 11), 5000, "greeting");
        await w.write(enc.encode("STARTTLS\\r\\n"));
        const go = await withTimeout(readN(r, 4), 5000, "go");
        r.releaseLock();
        w.releaseLock();
        const secure = s.startTls({ expectedServerHostname: "localhost" });
        const w2 = secure.writable.getWriter();
        const r2 = secure.readable.getReader();
        await withTimeout(secure.opened, 5000, "tls");
        await w2.write(enc.encode("ping"));
        const echoed = await withTimeout(readN(r2, 8), 5000, "tls echo");
        await secure.close();
        return Response.json({ greeting, go, echoed, upgraded: s.upgraded });
      }
      if (url.pathname === "/tls") {
        const host = q.get("host") || "localhost";
        const s = connect({ hostname: host, port }, { secureTransport: "on" });
        const w = s.writable.getWriter();
        const r = s.readable.getReader();
        await withTimeout(s.opened, 5000, "tls opened");
        await w.write(enc.encode("secret"));
        const got = await withTimeout(readN(r, 6), 5000, "tls echo");
        await s.close();
        return Response.json({ got });
      }
      if (url.pathname === "/refused") {
        const out = {};
        for (const target of ["169.254.169.254:80", "10.1.2.3:80", "127.0.0.1:25"]) {
          const s = connect(target);
          try {
            await withTimeout(s.opened, 5000, "opened");
            out[target] = "opened";
          } catch (e) {
            out[target] = e.name + ": " + e.message;
          }
        }
        return Response.json(out);
      }
      if (url.pathname === "/untrusted") {
        const s = connect({ hostname: "localhost", port }, { secureTransport: "on" });
        try {
          await withTimeout(s.opened, 5000, "opened");
          return Response.json({ opened: true });
        } catch (e) {
          return Response.json({ opened: false, name: e.name });
        }
      }
      if (url.pathname === "/bulk") {
        const N = 1 << 20;
        const s = connect("127.0.0.1:" + port);
        const w = s.writable.getWriter();
        const rd = s.readable.getReader();
        const data = new Uint8Array(N);
        for (let i = 0; i < N; i++) data[i] = (i * 31 + 7) & 255;
        let sum = 0;
        let got = 0;
        const reading = (async () => {
          while (got < N) {
            const r = await rd.read();
            if (r.done) break;
            for (let i = 0; i < r.value.length; i++) sum = (sum + r.value[i]) % 1000003;
            got += r.value.length;
          }
        })();
        for (let o = 0; o < N; o += 65536) await w.write(data.subarray(o, o + 65536));
        await withTimeout(reading, 20000, "bulk");
        let want = 0;
        for (let i = 0; i < N; i++) want = (want + data[i]) % 1000003;
        await s.close();
        return Response.json({ got, checksumOk: sum === want });
      }
      if (url.pathname === "/latency") {
        const t0 = Date.now();
        const s = connect("127.0.0.1:" + port);
        await withTimeout(s.opened, 5000, "opened");
        const ms = Date.now() - t0;
        await s.close();
        return Response.json({ ms });
      }
      if (url.pathname === "/latency-many") {
        const n = Number(q.get("n"));
        const times = [];
        for (let i = 0; i < n; i++) {
          const t0 = performance.now();
          const s = connect("127.0.0.1:" + port);
          await withTimeout(s.opened, 5000, "opened");
          times.push(performance.now() - t0);
          await s.close();
        }
        times.sort((a, b) => a - b);
        return Response.json({ n, median: times[Math.floor(n / 2)], p95: times[Math.floor(n * 0.95)], max: times[n - 1] });
      }
      if (url.pathname === "/rtt") {
        const n = Number(q.get("n"));
        const s = connect("127.0.0.1:" + port);
        const w = s.writable.getWriter();
        const r = s.readable.getReader();
        await withTimeout(s.opened, 5000, "opened");
        const msg = enc.encode("0123456789abcdef");
        const t0 = performance.now();
        for (let i = 0; i < n; i++) {
          await w.write(msg);
          await withTimeout(readN(r, 16), 5000, "rtt");
        }
        const ms = performance.now() - t0;
        await s.close();
        return Response.json({ n, ms });
      }
      if (url.pathname === "/hold") {
        const k = Number(q.get("k"));
        for (const s of held.splice(0)) await s.close();
        for (let i = 0; i < k; i++) {
          const s = connect("127.0.0.1:" + port);
          await withTimeout(s.opened, 5000, "opened");
          held.push(s);
        }
        return Response.json({ held: held.length });
      }
      if (url.pathname === "/release") {
        for (const s of held.splice(0)) await s.close();
        return Response.json({ held: held.length });
      }
      if (url.pathname === "/seventeen") {
        const out = [];
        for (let i = 0; i < 17; i++) {
          const s = connect("127.0.0.1:" + port);
          held.push(s);
          try {
            await withTimeout(s.opened, 5000, "opened");
            out.push("ok");
          } catch (e) {
            out.push(e.message);
          }
        }
        for (const s of held.splice(0)) await s.close();
        return Response.json({ ok: out.filter((o) => o === "ok").length, last: out[16] });
      }
      return new Response("no route", { status: 404 });
    } catch (e) {
      return Response.json({ error: String(e && e.message) }, { status: 500 });
    }
  },
};
`;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-sockets-broker-"));
const servers: Array<{ close(): void }> = [];

// A self-signed certificate for localhost; the broker is told to trust it (tests only).
const made = Bun.spawnSync([
  "openssl",
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-keyout",
  join(workdir, "key.pem"),
  "-out",
  join(workdir, "cert.pem"),
  "-days",
  "2",
  "-subj",
  "/CN=localhost",
  "-addext",
  "subjectAltName=DNS:localhost",
]);
assert.equal(made.exitCode, 0, `openssl failed: ${made.stderr}`);
const cert = await readFile(join(workdir, "cert.pem"), "utf8");
const key = await readFile(join(workdir, "key.pem"), "utf8");

const listenOn = (server: net.Server): number => {
  server.listen(0, "127.0.0.1");
  servers.push(server);
  // SAFETY: a listening TCP server's address() is an AddressInfo.
  return (server.address() as net.AddressInfo).port;
};
const echoPort = listenOn(net.createServer((s) => s.pipe(s)));
const answersAtEnd = listenOn(
  net.createServer({ allowHalfOpen: true }, (s) => {
    const parts: Buffer[] = [];
    s.on("data", (c) => parts.push(c));
    s.on("end", () => s.end(`got ${Buffer.concat(parts).toString()}`));
  }),
);
const starttlsPort = listenOn(
  net.createServer((s) => {
    s.write("220 hello\r\n");
    s.once("data", () => {
      s.write("go\r\n");
      const secure = new tls.TLSSocket(s, { isServer: true, key, cert });
      secure.on("data", (c) => secure.write(Buffer.concat([Buffer.from("tls:"), c])));
      secure.on("error", () => {});
    });
  }),
);
const tlsPort = listenOn(
  tls.createServer({ key, cert }, (s) => {
    s.on("data", (c) => s.write(c));
    s.on("error", () => {});
  }),
);

const broker = createBroker({
  db: ":memory:",
  token: "native-sockets",
  bindings: { ...EMPTY_BINDINGS, resources: {} },
  egressAllow: ["127.0.0.1"],
  tcp: { tls: { ca: cert } },
});
const brokerServer = listen(broker, "127.0.0.1", 0);
const untrustingBroker = createBroker({ db: ":memory:", token: "native-sockets", egressAllow: ["127.0.0.1"] });
const untrustingServer = listen(untrustingBroker, "127.0.0.1", 0);

let sprout: ReturnType<typeof Bun.spawn> | undefined;
let untrusting: ReturnType<typeof Bun.spawn> | undefined;
const port = freePort();
const port2 = freePort();
const rssKiB = (pid: number) =>
  Number(
    Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)])
      .stdout.toString()
      .trim(),
  );
const get = async (path: string, base = port) => {
  const res = await fetch(`http://127.0.0.1:${base}${path}`, { signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

try {
  const porffor = await ensurePorffor({ cacheRoot: workdir });
  const node = Bun.which("node");
  if (!node) throw new Error("native sockets test needs node on PATH");
  const [core, transport] = await Promise.all([
    readFile(preludePath, "utf8"),
    readFile(transportPath("broker"), "utf8"),
  ]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const generated = join(workdir, "sockets.generated.js");
  const binary = join(workdir, "sockets-native");
  await writeFile(
    generated,
    wrapNativeFetchHandler(
      handler,
      core.replace(TRANSPORT_MARKER, transport),
      {},
      EMPTY_BINDINGS,
      undefined,
      "2026-11-17",
    ),
  );
  const compile = Bun.spawn(
    [node, resolve(porffor, "runtime/index.js"), "native", generated, "-o", binary, "-s", "-O0"],
    {
      cwd: workdir,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    compile.exited,
    new Response(compile.stdout).text(),
    new Response(compile.stderr).text(),
  ]);
  assert.equal(exitCode, 0, `Porffor native compile failed:\n${stderr}\n${stdout}`);

  const start = async (listening: number, brokerPort: number) => {
    const child = Bun.spawn([binary], {
      cwd: workdir,
      env: {
        ...process.env,
        PORT: String(listening),
        SB_BROKER_PORT: String(brokerPort),
        SB_BROKER_TOKEN: "native-sockets",
      },
      stdout: "ignore",
      stderr: "inherit",
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if ((await get("/ping", listening)) === "pong") return child;
      } catch {
        if (child.exitCode !== null) break;
        await Bun.sleep(100);
      }
    }
    throw new Error("compiled handler did not start");
  };
  sprout = await start(port, brokerServer.port);
  untrusting = await start(port2, untrustingServer.port);

  assert.deepEqual(await get(`/echo?port=${echoPort}`), { got: "hello\n", remote: "string" });
  console.log("echo through the broker tunnel");

  assert.deepEqual(await get(`/halfclose?port=${answersAtEnd}`), { got: "got one two" });
  console.log("half-close: the writer closes, the reply still arrives, then the end of input");

  assert.deepEqual(await get(`/starttls?port=${starttlsPort}`), {
    greeting: "220 hello\r\n",
    go: "go\r\n",
    echoed: "tls:ping",
    upgraded: false,
  });
  console.log("startTls upgrades in the broker, verified against the expected host name");

  assert.deepEqual(await get(`/tls?port=${tlsPort}`), { got: "secret" });
  const wrongName = await get(`/tls?port=${tlsPort}&host=127.0.0.1`);
  assert.match(String(wrongName.error), /proxy request failed, cannot connect/);
  console.log("secureTransport on: TLS ends in the broker; a name the certificate lacks fails");

  assert.deepEqual(await get(`/untrusted?port=${tlsPort}`, port2), { opened: false, name: "Error" });
  console.log("an untrusted certificate is refused");

  const refused = await get("/refused");
  for (const target of ["169.254.169.254:80", "10.1.2.3:80", "127.0.0.1:25"]) {
    assert.match(refused[target], /proxy request failed, cannot connect to the specified address/, target);
  }
  console.log("private addresses and port 25 are refused like fetch");

  assert.deepEqual(await get(`/bulk?port=${echoPort}`), { got: 1 << 20, checksumOk: true });
  console.log("1 MiB echoed through the tunnel with its checksum intact");

  const seventeen = await get(`/seventeen?port=${echoPort}`);
  assert.equal(seventeen.ok, 16);
  assert.match(seventeen.last, /Too many open connections/);
  for (let i = 0; i < 100 && broker.tcp.open() > 0; i++) await Bun.sleep(20);
  assert.equal(broker.tcp.open(), 0, "closing the sockets frees the broker's slots");
  console.log("the sixteenth socket opens, the seventeenth is refused, closing frees the slots");

  // Cleanup on sprout exit: held sockets are torn down when the sprout dies.
  assert.deepEqual(await get(`/hold?port=${echoPort}&k=3`), { held: 3 });
  assert.equal(broker.tcp.open(), 3);
  sprout.kill(9);
  await sprout.exited;
  sprout = undefined;
  for (let i = 0; i < 50 && broker.tcp.open() > 0; i++) await Bun.sleep(20);
  assert.equal(broker.tcp.open(), 0, "the broker cleans up when the sprout disconnects");
  console.log("a dead sprout's sockets are cleaned up in the broker");

  // --- measurements
  sprout = await start(port, brokerServer.port);
  const latency = await get(`/latency-many?port=${echoPort}&n=200`);
  const rtt = await get(`/rtt?port=${echoPort}&n=2000`);
  await get(`/hold?port=${echoPort}&k=1`);
  await get(`/release?`);
  const rss = new Map<string, number>([["base", rssKiB(sprout.pid)]]);
  for (const k of [1, 8, 16]) {
    await get(`/release?`);
    await Bun.sleep(300);
    const before = rssKiB(sprout.pid);
    await get(`/hold?port=${echoPort}&k=${k}`);
    await Bun.sleep(300);
    const after = rssKiB(sprout.pid);
    rss.set(`open${k}`, after);
    rss.set(`perSocketKiB${k}`, Math.round(((after - before) / k) * 10) / 10);
  }
  console.log(
    JSON.stringify({
      connectLatencyMs: latency,
      roundTrips: { ...rtt, perTripMs: rtt.ms / rtt.n },
      rssKiB: Object.fromEntries(rss),
    }),
  );
} finally {
  sprout?.kill(9);
  untrusting?.kill(9);
  await sprout?.exited;
  await untrusting?.exited;
  brokerServer.stop();
  untrustingServer.stop();
  broker.close();
  untrustingBroker.close();
  for (const server of servers) server.close();
  await rm(workdir, { recursive: true, force: true });
}
// Origin sockets still open would keep the process alive.
process.exit(0);
