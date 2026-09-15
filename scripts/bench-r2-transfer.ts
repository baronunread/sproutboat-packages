/** Measure the broker's RSS during a streamed direct upload from a separate process. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBroker, listenTransfers } from "../packages/wire/src/broker";

const size = Number(process.argv[2] ?? 32) * 1024 * 1024;
const mode = process.argv[5] ?? "broker";
if (!Number.isSafeInteger(size) || size <= 0) throw new Error("size must be a positive MiB count");

if (process.argv[3] === "server") {
  const directory = process.argv[4];
  if (!directory) throw new Error("missing directory");
  if (mode === "naive") {
    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const writer = Bun.file(join(directory, "naive.bin")).writer();
      if (request.body) for await (const chunk of request.body) writer.write(chunk);
      await writer.end();
      return new Response("ok", { status: 201 });
    } });
    console.log(`http://127.0.0.1:${listener.port}/`);
    await new Promise(() => undefined);
  }
  const broker = createBroker({ db: join(directory, "state.sqlite"), bindings: { r2: ["UPLOADS"] } });
  const listener = listenTransfers(broker, "127.0.0.1", 0);
  const ticket = await broker.dispatch({ op: "r2.transfer.create", bucket: "UPLOADS", key: "large.bin", method: "upload", maxBytes: size });
  if (mode === "proxy") {
    const upstream = `http://127.0.0.1:${listener.port}${ticket.url}`;
    const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 5 * 1024 * 1024 * 1024, fetch(request) {
      // SAFETY: Bun supports duplex for streamed request bodies; the bundled DOM type omits the field.
      return fetch(upstream, { method: request.method, body: request.body, duplex: "half" } as RequestInit);
    } });
    console.log(`http://127.0.0.1:${proxy.port}/`);
  } else console.log(`http://127.0.0.1:${listener.port}${ticket.url}`);
  await new Promise(() => undefined);
} else {
  const directory = mkdtempSync(join(tmpdir(), "sb-r2-bench-"));
  const child = Bun.spawn([process.execPath, "--smol", resolve(import.meta.dir, "bench-r2-transfer.ts"), String(size / 1024 / 1024), "server", directory, process.argv[3] ?? "broker"], {
    stdout: "pipe", stderr: "inherit",
  });
  try {
    const reader = child.stdout.getReader();
    let line = "";
    while (!line.includes("\n")) {
      const part = await reader.read();
      if (part.done) throw new Error("broker exited before printing its URL");
      line += new TextDecoder().decode(part.value);
    }
    const url = line.trim();
    const rss = (): number => {
      const result = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(child.pid)]);
      return Number(new TextDecoder().decode(result.stdout).trim()) * 1024;
    };
    const baseline = rss();
    let peak = baseline;
    const monitor = setInterval(() => { peak = Math.max(peak, rss()); }, 20);
    let remaining = size;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!remaining) return controller.close();
        const length = Math.min(64 * 1024, remaining);
        controller.enqueue(new Uint8Array(length).fill(7));
        remaining -= length;
      },
    });
    try {
      // SAFETY: Bun supports duplex for streamed request bodies; the bundled DOM type omits the field.
      const response = await fetch(url, { method: "PUT", body, duplex: "half" } as RequestInit);
      const resultText = await response.text();
      peak = Math.max(peak, rss());
      console.log(JSON.stringify({ status: response.status, error: response.status === 201 ? undefined : resultText, sizeMiB: size / 1024 / 1024,
        baselineMiB: baseline / 1024 / 1024, peakMiB: peak / 1024 / 1024,
        settledMiB: rss() / 1024 / 1024 }));
    } finally {
      clearInterval(monitor);
    }
  } finally {
    child.kill(9);
    await child.exited;
    rmSync(directory, { recursive: true, force: true });
  }
}
