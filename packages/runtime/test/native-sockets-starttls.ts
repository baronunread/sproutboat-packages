import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import tls from "node:tls";

// cloudflare:sockets connect() on the embedded transport (standalone sprouts, sproutd): no
// application byte written after startTls(), or before `opened` on a secureTransport "on"
// socket, may ever reach the wire in plaintext. The origins here record every raw byte they
// receive and refuse anything but a TLS handshake record where the handshake must begin.
//
// The deterministic cases hold the sprout's I/O thread in its plaintext flush (a 16 MiB write
// the origin reads only after a pause) while the handler calls startTls() and writes to the
// new socket; the I/O thread then sees the upgrade and the new writes in one pass, which is
// the race the TLS spike observed on 14 of 200 connections. `/burst` repeats the plain
// immediate-write case many times, as the spike did.
//
// Needs SB_CLI, a sproutboat-cli checkout linked to this one (it builds the sprout).
const BLOB = 16 << 20;
const handler = `
import { connect } from "cloudflare:sockets";
const enc = new TextEncoder();
const dec = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT " + what)), ms))]);
async function readN(reader, n) {
  let out = "";
  while (out.length < n) {
    const r = await withTimeout(reader.read(), 5000, "read");
    if (r.done) return out;
    out += dec.decode(r.value);
  }
  return out;
}
async function readUntil(reader, needle) {
  let out = "";
  while (!out.includes(needle)) {
    const r = await withTimeout(reader.read(), 5000, "read " + needle);
    if (r.done) return out;
    out += dec.decode(r.value);
  }
  return out;
}
let blob = null;
function theBlob() {
  if (blob === null) {
    blob = new Uint8Array(${BLOB});
    for (let i = 0; i < blob.length; i++) blob[i] = 120;
  }
  return blob;
}
// The plaintext phase every startTls route shares: greeting, STARTTLS, go.
async function plainPhase(port) {
  const s = connect({ hostname: "localhost", port }, { secureTransport: "starttls" });
  const w = s.writable.getWriter();
  const r = s.readable.getReader();
  await readN(r, 11);
  await w.write(enc.encode("STARTTLS\\r\\n"));
  await readN(r, 4);
  return { s, w, r };
}
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const q = url.searchParams;
    const port = Number(q.get("port"));
    try {
      if (url.pathname === "/ping") return new Response("pong");
      if (url.pathname === "/immediate" || url.pathname === "/queued") {
        const { s, w, r } = await plainPhase(port);
        // not awaited: the origin reads it only after a pause, so the host is still flushing it
        // in the clear while everything below runs (the yield lets the host start the flush)
        w.write(theBlob());
        await sleep(100);
        w.releaseLock();
        r.releaseLock();
        const secure = s.startTls({ expectedServerHostname: "localhost" });
        const w2 = secure.writable.getWriter();
        const r2 = secure.readable.getReader();
        const n = url.pathname === "/queued" ? 3 : 1;
        for (let i = 1; i <= n; i++) w2.write(enc.encode("secret-" + i));
        const late = s.writable.getWriter().write(enc.encode("late-plaintext")).then(() => "accepted", (e) => e.name);
        await withTimeout(secure.opened, 15000, "tls");
        const echoed = await readUntil(r2, "secret-" + n);
        await secure.close();
        const oldWrite = await withTimeout(late, 1000, "late write").catch(() => "pending");
        return Response.json({ echoed, oldWrite });
      }
      if (url.pathname === "/inflight") {
        const { s, w, r } = await plainPhase(port);
        w.releaseLock();
        r.releaseLock();
        const secure = s.startTls({ expectedServerHostname: "localhost" });
        // the origin holds the ClientHello for a while, so the handshake is still in flight here
        await sleep(100);
        const w2 = secure.writable.getWriter();
        const r2 = secure.readable.getReader();
        w2.write(enc.encode("secret-1"));
        await withTimeout(secure.opened, 15000, "tls");
        const echoed = await readUntil(r2, "secret-1");
        await secure.close();
        return Response.json({ echoed });
      }
      if (url.pathname === "/on") {
        const s = connect({ hostname: "localhost", port }, { secureTransport: "on" });
        const w = s.writable.getWriter();
        const r = s.readable.getReader();
        // written before \`opened\`: it may only leave inside a TLS record
        w.write(enc.encode("secret-1"));
        await withTimeout(s.opened, 15000, "opened");
        const echoed = await readUntil(r, "secret-1");
        await s.close();
        return Response.json({ echoed });
      }
      if (url.pathname === "/burst") {
        const n = Number(q.get("n"));
        let ok = 0;
        const errors = [];
        for (let i = 0; i < n; i++) {
          try {
            const { s, w, r } = await plainPhase(port);
            w.releaseLock();
            r.releaseLock();
            const secure = s.startTls({ expectedServerHostname: "localhost" });
            const w2 = secure.writable.getWriter();
            const r2 = secure.readable.getReader();
            w2.write(enc.encode("secret-" + i + "\\n"));
            const echoed = await readUntil(r2, "secret-" + i + "\\n");
            await secure.close();
            if (echoed.includes("secret-" + i)) ok++;
            else errors.push("bad echo " + i);
          } catch (e) {
            errors.push(String(e && e.message));
          }
        }
        return Response.json({ ok, errors: errors.slice(0, 3) });
      }
      return new Response("no route", { status: 404 });
    } catch (e) {
      return Response.json({ error: String(e && e.message) }, { status: 500 });
    }
  },
};
`;

const cli = process.env.SB_CLI;
if (!cli) {
  console.log("skipped: set SB_CLI to a sproutboat-cli checkout linked to this checkout (it builds the sprout)");
  process.exit(0);
}

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = mkdtempSync(join(tmpdir(), "sb-native-sockets-starttls-"));
const servers: net.Server[] = [];

// A self-signed certificate for localhost; the sprout is told to trust it through SB_CA_BUNDLE.
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
const cert = readFileSync(join(workdir, "cert.pem"), "utf8");
const key = readFileSync(join(workdir, "key.pem"), "utf8");

interface OriginOptions {
  /** Plaintext bytes the client still owes after "go", swallowed before the TLS handshake. */
  readonly plainBytes?: number;
  /** Stop reading for this long after "go", so the client's send side fills up. */
  readonly stallMs?: number;
  /** Hold the first TLS record this long before the server's TLS side sees it. */
  readonly holdHelloMs?: number;
  /** TLS from the first byte (secureTransport "on") instead of a STARTTLS exchange. */
  readonly tlsFromStart?: boolean;
}

/** A recording origin: `records[i]` holds every raw byte connection i sent after the plaintext phase. */
function origin(options: OriginOptions) {
  const records: Buffer[][] = [];
  const server = net.createServer((s) => {
    const raw: Buffer[] = [];
    records.push(raw);
    s.on("error", () => {});
    // A TLSSocket over a net.Socket reads the handle directly, so the TLS side runs over a tap
    // fed by the data listener that records the bytes.
    const tap = new Duplex({
      read() {},
      write(chunk, _enc, done) {
        s.write(chunk, done);
      },
    });
    let plainLeft = options.plainBytes ?? 0;
    let handshakeSeen = false;
    const held: Buffer[] = [];
    let holding = options.holdHelloMs !== undefined;
    const feed = (c: Buffer) => {
      if (!handshakeSeen) {
        handshakeSeen = true;
        // anything but a TLS handshake record here is a leak: end the connection at once
        if (c[0] !== 0x16) {
          s.destroy();
          return;
        }
        if (holding) {
          setTimeout(() => {
            holding = false;
            for (const h of held.splice(0)) tap.push(h);
          }, options.holdHelloMs);
        }
      }
      if (holding) held.push(c);
      else tap.push(c);
    };
    const startTls = () => {
      const secure = new tls.TLSSocket(tap, { isServer: true, key, cert });
      secure.on("data", (c) => secure.write(Buffer.concat([Buffer.from("tls:"), c])));
      secure.on("error", () => {});
    };
    let afterGo = options.tlsFromStart === true;
    s.on("data", (c: Buffer) => {
      if (!afterGo) return;
      raw.push(Buffer.from(c));
      let rest = c;
      if (plainLeft > 0) {
        const k = Math.min(plainLeft, rest.length);
        plainLeft -= k;
        rest = rest.subarray(k);
      }
      if (rest.length > 0) feed(rest);
    });
    if (afterGo) {
      startTls();
      return;
    }
    s.write("220 hello\r\n");
    s.once("data", () => {
      afterGo = true;
      s.write("go\r\n");
      if (options.stallMs !== undefined) {
        s.pause();
        setTimeout(() => s.resume(), options.stallMs);
      }
      startTls();
    });
  });
  server.listen(0, "127.0.0.1");
  servers.push(server);
  // SAFETY: a listening TCP server's address() is an AddressInfo.
  return { port: (server.address() as net.AddressInfo).port, records };
}

const stalled = origin({ plainBytes: BLOB, stallMs: 500 });
const stalledQueued = origin({ plainBytes: BLOB, stallMs: 500 });
const slowHello = origin({ holdHelloMs: 300 });
const burst = origin({});
const tlsOn = origin({ tlsFromStart: true });

const plaintextOnly = (raw: Buffer, plainBytes: number, label: string) => {
  assert.ok(
    raw.length > plainBytes,
    `${label}: the origin saw ${raw.length} bytes, expected the handshake after ${plainBytes}`,
  );
  if (plainBytes > 0)
    assert.ok(
      raw.subarray(0, plainBytes).equals(Buffer.alloc(plainBytes, 0x78)),
      `${label}: the plaintext part is intact`,
    );
  assert.equal(raw[plainBytes], 0x16, `${label}: a TLS handshake record follows the plaintext phase`);
  assert.equal(raw.includes("secret"), false, `${label}: no application bytes reached the origin in plaintext`);
  assert.equal(raw.includes("late-plaintext"), false, `${label}: nothing written to the old socket reached the wire`);
};

let sprout: ReturnType<typeof Bun.spawn> | undefined;
try {
  const slug = "starttls-race";
  const project = join(workdir, slug);
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src/index.js"), handler);
  writeFileSync(
    join(project, "sproutboat.jsonc"),
    JSON.stringify({ name: slug, main: "src/index.js", compatibility_date: "2026-11-17" }),
  );
  const built = Bun.spawnSync(["bun", join(cli, "src/main.ts"), "build", "--standalone", "--target", "host"], {
    cwd: project,
    stdout: "inherit",
    stderr: "inherit",
  });
  assert.equal(built.exitCode, 0, "the CLI could not build the sprout");
  const port = freePort();
  sprout = Bun.spawn([join(project, "dist", slug)], {
    cwd: project,
    env: {
      ...process.env,
      PORT: String(port),
      SB_EGRESS_ALLOW: "127.0.0.1",
      SB_DATA_DIR: join(project, "data"),
      SB_CA_BUNDLE: join(workdir, "cert.pem"),
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100 && !ready; attempt++) {
    try {
      ready = (await (await fetch(`${base}/ping`, { signal: AbortSignal.timeout(500) })).text()) === "pong";
    } catch {
      if (sprout.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  assert.ok(ready, "the sprout did not start");
  // A leak makes the origin drop the connection, so a route may hang on the unfixed runtime:
  // report it as an error and let the recorded bytes speak first.
  const get = async (path: string) => {
    try {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30_000) });
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch (e) {
      return { error: `no answer from the sprout: ${e instanceof Error ? e.message : String(e)}` };
    }
  };

  const immediate = await get(`/immediate?port=${stalled.port}`);
  assert.equal(stalled.records.length, 1);
  plaintextOnly(Buffer.concat(stalled.records[0]), BLOB, "immediate");
  assert.equal(immediate.error, undefined, `immediate: ${JSON.stringify(immediate)}`);
  assert.ok(String(immediate.echoed).includes("secret-1"), "immediate: the write was echoed over TLS");
  assert.equal(
    immediate.oldWrite,
    "TypeError",
    "immediate: a write on the plaintext socket after startTls() is refused",
  );
  console.log("a write right after startTls(), while the plaintext flush is still running, only leaves inside TLS");

  const queued = await get(`/queued?port=${stalledQueued.port}`);
  assert.equal(stalledQueued.records.length, 1);
  plaintextOnly(Buffer.concat(stalledQueued.records[0]), BLOB, "queued");
  assert.equal(queued.error, undefined, `queued: ${JSON.stringify(queued)}`);
  for (const part of ["secret-1", "secret-2", "secret-3"])
    assert.ok(String(queued.echoed).includes(part), `queued: ${part} echoed`);
  assert.equal(queued.oldWrite, "TypeError");
  console.log("several writes queued behind startTls() all wait for the handshake");

  const inflight = await get(`/inflight?port=${slowHello.port}`);
  assert.equal(slowHello.records.length, 1);
  plaintextOnly(Buffer.concat(slowHello.records[0]), 0, "inflight");
  assert.equal(inflight.error, undefined, `inflight: ${JSON.stringify(inflight)}`);
  assert.ok(String(inflight.echoed).includes("secret-1"));
  console.log("a write while the handshake is in flight is held until it completes");

  const on = await get(`/on?port=${tlsOn.port}`);
  assert.equal(tlsOn.records.length, 1);
  plaintextOnly(Buffer.concat(tlsOn.records[0]), 0, "on");
  assert.equal(on.error, undefined, `on: ${JSON.stringify(on)}`);
  assert.ok(String(on.echoed).includes("secret-1"));
  console.log("secureTransport on: a write before `opened` only leaves inside TLS");

  const n = 40;
  const many = await get(`/burst?port=${burst.port}&n=${n}`);
  let leaked = 0;
  for (const rec of burst.records) {
    const raw = Buffer.concat(rec);
    if (raw.length === 0 || raw[0] !== 0x16 || raw.includes("secret")) leaked++;
  }
  assert.equal(
    leaked,
    0,
    `burst: ${leaked} of ${burst.records.length} connections sent application bytes in plaintext`,
  );
  assert.equal(many.error, undefined, `burst: ${JSON.stringify(many)}`);
  assert.deepEqual(many, { ok: n, errors: [] });
  console.log(`${n} immediate writes after startTls() in a row, none in plaintext`);
} finally {
  sprout?.kill();
  for (const server of servers) server.close();
  rmSync(workdir, { recursive: true, force: true });
}
