import assert from "node:assert/strict";

// Drives test/fixtures/concurrent-app.js with many interleaved requests and checks that every
// reply holds only its own request's values. Used by native-concurrent-requests.ts (a standalone
// binary) and by sproutd's smoke (a worker serving up to 8 requests at once).

/** An upstream the app's fetch() calls: answers after `ms`, echoing the id it was asked for. */
export function startUpstream() {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      await Bun.sleep(Number(url.searchParams.get("ms") || 0));
      return Response.json({ id: url.searchParams.get("id"), header: request.headers.get("x-rid") });
    },
  });
}

type Json = string | number | boolean | null | Json[] | { readonly [key: string]: Json };

let seed = 12345;
const rand = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};

export interface DriverOptions {
  readonly base: string;
  readonly host?: string;
  readonly upstream?: string;
  readonly requests: number;
  readonly rounds: number;
  /** Whether the host carries client WebSockets (a standalone binary answers 501). */
  readonly clientSockets: boolean;
  readonly store: boolean;
  /** Most requests (and sockets) in flight at once; sproutd queues 32 per app and refuses the rest. Default: all. */
  readonly limit?: number;
}

const randomId = (round: number, i: number) => `r${round}-${i}-${rand(1e9).toString(36)}`;

export async function drive(options: DriverOptions): Promise<{ requests: number; failures: string[] }> {
  const { base, upstream, requests, rounds } = options;
  const failures: string[] = [];
  const fail = (msg: string) => failures.push(msg);
  const hostHeader: Record<string, string> = options.host ? { host: options.host } : {};
  const get = (path: string, rid: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { ...hostHeader, "x-rid": rid, cookie: `sid=${rid}` },
    });
  const expectOwn = (kind: string, rid: string, value: Json, expected: Json) => {
    if (JSON.stringify(value) !== JSON.stringify(expected))
      fail(`${kind} ${rid}: got ${JSON.stringify(value)}, wanted ${JSON.stringify(expected)}`);
  };
  let total = 0;

  const one = async (round: number, i: number) => {
    const rid = randomId(round, i);
    const delays = [rand(8), rand(8), rand(8)].join(",");
    total++;
    switch (i % 10) {
      case 0:
      case 1: {
        const alloc = i % 2 ? "&alloc=1" : "";
        const up = upstream ? `&up=${encodeURIComponent(upstream)}` : "";
        const r = await get(`/mix?d=${delays}${alloc}${up}`, rid);
        const body: {
          rid: string;
          steps: {
            rid: string;
            cookie: string;
            url: string;
            method: string;
            env: string;
            ctx: boolean;
            cf: boolean;
            headers: boolean;
          }[];
          mine: { id: string; text: string; list: string };
          extra: string;
          xrid: string;
          upstream?: { id: string; header: string };
        } = await r.json();
        expectOwn("mix.rid", rid, body.rid, rid);
        expectOwn("mix.header", rid, r.headers.get("x-rid"), rid);
        expectOwn("mix.echo", rid, r.headers.get("x-echo"), rid);
        for (const s of body.steps) {
          expectOwn("mix.step.rid", rid, s.rid, rid);
          expectOwn("mix.step.cookie", rid, s.cookie, `sid=${rid}`);
          expectOwn("mix.step.url", rid, new URL(s.url).searchParams.get("d"), delays);
          expectOwn("mix.step.flags", rid, [s.method, s.env, s.ctx, s.cf, s.headers], ["GET", "hi", true, true, true]);
        }
        expectOwn("mix.mine", rid, [body.mine.id, body.mine.text], [rid, "t-" + rid]);
        expectOwn("mix.list", rid, body.mine.list, Array.from({ length: 20 }, (_, k) => `${rid}:${k}`).join(","));
        expectOwn("mix.extra", rid, [body.extra, body.xrid], [rid, rid]);
        if (upstream) expectOwn("mix.upstream", rid, [body.upstream?.id, body.upstream?.header], [rid, rid]);
        break;
      }
      case 2: {
        const r = await get(`/promise?d=${delays}`, rid);
        const body: {
          rid: string;
          all: string[];
          raced: string;
          settled: string[];
          again: string;
        } = await r.json();
        expectOwn(
          "promise",
          rid,
          [body.rid, body.all, body.raced, body.settled, body.again],
          [rid, [rid, rid, rid], rid, ["e-" + rid, rid], rid],
        );
        break;
      }
      case 3: {
        const r = await get(`/boom?d=${delays}`, rid);
        if (r.status !== 500) fail(`boom ${rid}: status ${r.status}`);
        const text = await r.text();
        if (text.includes("boom-")) fail(`boom ${rid}: the error text reached the client: ${text}`);
        break;
      }
      case 4: {
        const r = await get(`/catch?d=${delays}`, rid);
        const body: { rid: string; message: string; again: string } = await r.json();
        expectOwn("catch", rid, [body.rid, body.message, body.again], [rid, "caught-" + rid, rid]);
        break;
      }
      case 5: {
        const r = await get(`/reject?d=${delays}`, rid);
        const body: { rid: string; ok: boolean; again: string } = await r.json();
        expectOwn("reject", rid, [r.status, body.rid, body.ok, body.again], [200, rid, true, rid]);
        break;
      }
      case 6: {
        // A request body that arrives in pieces while others are being served.
        const pieces = 3 + rand(4);
        const data: Uint8Array[] = [];
        let sum = 0;
        let bytes = 0;
        for (let p = 0; p < pieces; p++) {
          const chunk = new Uint8Array(1000 + rand(3000));
          for (let k = 0; k < chunk.length; k++) chunk[k] = rand(256);
          for (const b of chunk) sum = (sum + b) % 1000003;
          bytes += chunk.length;
          data.push(chunk);
        }
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const next = data.shift();
            if (!next) return controller.close();
            await Bun.sleep(1 + rand(5));
            controller.enqueue(next);
          },
        });
        // SAFETY: Bun accepts a streamed body with duplex: "half"; its RequestInit type does not list the field.
        const r = await get(`/body`, rid, { method: "POST", body: stream, duplex: "half" } as RequestInit);
        const body: { rid: string; bytes: number; sum: number; again: string } = await r.json();
        expectOwn("body", rid, [body.rid, body.bytes, body.sum, body.again], [rid, bytes, sum, rid]);
        break;
      }
      case 7: {
        const r = await get(`/stream?d=${delays}`, rid);
        const text = await r.text();
        const lines = text.trim().split("\n");
        expectOwn(
          "stream",
          rid,
          lines,
          Array.from({ length: 8 }, (_, k) => `${rid}:${k}:${rid}`),
        );
        break;
      }
      case 8: {
        if (options.store && round % 2 === 0) {
          const r = await get(`/store?d=${delays}`, rid);
          const body: { rid: string; kv: string; row: string; again: string } = await r.json();
          expectOwn("store", rid, [body.rid, body.kv, body.row, body.again], [rid, rid, "v-" + rid, rid]);
        } else {
          const r = await get(`/pair?d=${rand(4)}`, rid);
          const body: { rid: string; log: string[] } = await r.json();
          expectPair(rid, body);
        }
        break;
      }
      case 9: {
        const text = "x".repeat(2000 + rand(5000)) + rid;
        const r = await get(`/text?d=${delays}`, rid, { method: "POST", body: text });
        const body: { rid: string; bytes: number; sum: number; again: string } = await r.json();
        let sum = 0;
        for (let k = 0; k < text.length; k++) sum = (sum + text.charCodeAt(k)) % 1000003;
        expectOwn("text", rid, [body.rid, body.bytes, body.sum, body.again], [rid, text.length, sum, rid]);
        break;
      }
    }
    if (i % 10 === 0) {
      // ctx.waitUntil ran with this request's values, whatever ran in between.
      await Bun.sleep(40);
      const w: {
        rid: string;
        again: string;
        mine: string;
        ctx: boolean;
      } | null = await (await get(`/wu`, rid)).json();
      expectOwn("waitUntil", rid, w, { rid, again: rid, mine: rid, ctx: true });
    }
  };

  const expectPair = (rid: string, body: { rid: string; log: string[] }) => {
    const want: string[] = [];
    for (let k = 0; k < 4; k++) want.push(`s:${rid}:${k}`, `c:echo:${rid}:${k}:${rid}`);
    const sorted = (a: string[]) => [...a].sort();
    expectOwn("pair", rid, [body.rid, sorted(body.log)], [rid, sorted(want)]);
  };

  const socket = async (round: number, i: number) => {
    const rid = randomId(round, i);
    total++;
    // SAFETY: Bun takes a headers option on the WebSocket constructor; the DOM type does not list it.
    const ws = new WebSocket(`${base.replace("http:", "ws:")}/ws?d=${rand(6)}`, {
      headers: { ...hostHeader, "x-rid": rid },
    } as never);
    const got: string[] = [];
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        fail(`ws ${rid}: timed out with ${got.join(",")}`);
        done();
      }, 15000);
      ws.addEventListener("open", () => {
        for (let k = 0; k < 4; k++) ws.send(`m${k}`);
      });
      ws.addEventListener("message", (e) => {
        got.push(String(e.data));
        if (got.length === 4) {
          clearTimeout(timer);
          ws.close(1000, "done");
          done();
        }
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        fail(`ws ${rid}: error`);
        done();
      });
    });
    expectOwn(
      "ws",
      rid,
      got.sort(),
      [0, 1, 2, 3].map((k) => `${rid}|m${k}|${rid}`),
    );
  };

  for (let round = 0; round < rounds; round++) {
    const work: (() => Promise<void>)[] = [];
    for (let i = 0; i < requests; i++) {
      work.push(() =>
        one(round, i).catch((error) => {
          fail(`request ${round}-${i} threw ${String(error)}`);
        }),
      );
    }
    if (options.clientSockets) {
      for (let i = 0; i < 6; i++)
        work.push(() => socket(round, i).catch((error) => fail(`socket ${round}-${i} threw ${String(error)}`)));
    }
    // At most `limit` at a time, started in order.
    let next = 0;
    const runner = async () => {
      while (next < work.length) {
        const job = work[next++];
        if (job) await job();
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.limit ?? work.length, work.length) }, runner));
  }
  // Nothing shared between requests: no two saw the same cf, headers or ctx object.
  const report: {
    maxActive: number;
    cfShared: boolean;
    headersShared: boolean;
    ctxShared: boolean;
  } = await (await get("/report", "report")).json();
  if (report.cfShared || report.headersShared || report.ctxShared)
    fail(`objects shared across requests: ${JSON.stringify(report)}`);
  if (report.maxActive < 2) fail(`requests never overlapped (max ${report.maxActive} at once)`);
  assert(Array.isArray(failures));
  return { requests: total, failures };
}
