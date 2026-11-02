// Test servers for the cloudflare:sockets conformance suite. Prints a JSON line with the ports.
import net from "node:net";
import tls from "node:tls";
import { readFileSync, writeFileSync } from "node:fs";
const key = readFileSync(`${process.env.CERT_DIR ?? "certs"}/server.key`);
const cert = readFileSync(`${process.env.CERT_DIR ?? "certs"}/server.crt`);
const ports: Record<string, number> = {};
const listen = (name: string, srv: net.Server) =>
  new Promise<void>((r) =>
    srv.listen(0, "127.0.0.1", () => {
      ports[name] = (srv.address() as net.AddressInfo).port;
      r();
    }),
  );
const echoHandlers = (s: net.Socket | tls.TLSSocket) => {
  s.on("error", () => {});
  s.on("data", (d) => {
    if (d.toString() === "BYE\n") s.end();
    else s.write(d);
  });
  s.on("end", () => {
    s.write("FIN-SEEN\n");
    s.end();
  });
};
// plain echo; on client FIN writes FIN-SEEN then ends
await listen("plain", net.createServer({ allowHalfOpen: true }, echoHandlers));
// sink: never reads, so the client's writes back up
await listen(
  "sink",
  net.createServer((s) => {
    s.on("error", () => {});
    s.pause();
  }),
);
// tls echo
await listen("tls", tls.createServer({ key, cert, allowHalfOpen: true }, echoHandlers));
// starttls: plaintext line protocol, then TLS on the same connection
await listen(
  "starttls",
  net.createServer((raw) => {
    raw.on("error", () => {});
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString();
      if (buf.includes("STARTTLS\n")) {
        raw.off("data", onData);
        raw.write("OK\n");
        const t = new tls.TLSSocket(raw, { isServer: true, key, cert });
        echoHandlers(t);
      }
    };
    raw.on("data", onData);
  }),
);
// greeter: sends a banner then closes (server-initiated EOF)
await listen(
  "greet",
  net.createServer((s) => {
    s.on("error", () => {});
    s.end("HELLO-FROM-SERVER\n");
  }),
);
// closed: a port nothing listens on
const probe = net.createServer();
await listen("closed", probe);
probe.close();
writeFileSync(`${process.env.OUT_DIR ?? "."}/ports.json`, JSON.stringify(ports));
console.log(JSON.stringify(ports));
