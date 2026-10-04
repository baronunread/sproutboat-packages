import { afterEach, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { createBroker } from "./broker";
import { createEgressHandler, EGRESS_ERROR_HEADER, EGRESS_TOKEN_HEADER, EGRESS_URL_HEADER, vettedFetch } from "./egress";

const TOKEN = "egress-test-token";
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

/** A real upstream on loopback: echoes method, body and Host, or answers gzip / a redirect. */
function upstream() {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/gzip")
        return new Response(gzipSync("compressed hello"), { headers: { "content-encoding": "gzip" } });
      if (path === "/redirect") return new Response(null, { status: 302, headers: { location: "http://127.0.0.2/" } });
      return Response.json(
        { method: request.method, body: await request.text(), host: request.headers.get("host") },
        { status: 201, headers: { "x-upstream": "1" } },
      );
    },
  });
  stops.push(() => server.stop(true));
  return server;
}

/** The egress service on loopback, allowed to reach 127.0.0.1 only (for the upstream). */
function egress() {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: createEgressHandler({ token: TOKEN, allow: ["127.0.0.1"] }),
  });
  stops.push(() => server.stop(true));
  return server;
}

const call = (service: { url: URL }, target: string, init: RequestInit = {}, token = TOKEN) =>
  fetch(service.url, {
    ...init,
    // SAFETY: every caller here passes headers as a plain record, or none.
    headers: { ...(init.headers as Record<string, string>), [EGRESS_URL_HEADER]: target, [EGRESS_TOKEN_HEADER]: token },
  });

test("#252: the service relays a request and its response, Host set to the target's name", async () => {
  const up = upstream();
  const res = await call(egress(), `http://localhost:${up.port}/x`, { method: "POST", body: "payload" });
  expect(res.status).toBe(201);
  expect(res.headers.get("x-upstream")).toBe("1");
  expect(await res.json()).toEqual({ method: "POST", body: "payload", host: `localhost:${up.port}` });
});

test("#252: compressed bodies and redirects pass through as a direct fetch would see them", async () => {
  const up = upstream();
  const service = egress();
  const gz = await call(service, `http://127.0.0.1:${up.port}/gzip`);
  expect([gz.headers.get("content-encoding"), await gz.text()]).toEqual(["gzip", "compressed hello"]);
  const hop = await call(service, `http://127.0.0.1:${up.port}/redirect`, { redirect: "manual" });
  expect([hop.status, hop.headers.get("location")]).toEqual([302, "http://127.0.0.2/"]);
});

test("#252: without the token the service does nothing", async () => {
  const up = upstream();
  const res = await call(egress(), `http://127.0.0.1:${up.port}/`, {}, "wrong-token-of-same-size");
  expect(res.status).toBe(401);
  expect(createEgressHandler.bind(null, { token: "" })).toThrow("needs a token");
});

test("#252: the service refuses private addresses with the #174 message", async () => {
  const res = await call(egress(), "http://169.254.169.254/latest/meta-data/");
  expect(res.headers.get(EGRESS_ERROR_HEADER)).toBe("1");
  // SAFETY: a refusal (EGRESS_ERROR_HEADER, checked above) is { error: string }.
  expect(((await res.json()) as { error: string }).error).toBe(
    "fetch() refused: 169.254.169.254 resolves to 169.254.169.254, a private or reserved address (169.254.0.0/16). An operator can allow it with SB_EGRESS_ALLOW=169.254.169.254",
  );
});

test("#252: a broker given SB_EGRESS_URL fetches through the service, refusals included", async () => {
  const up = upstream();
  const service = egress();
  // The broker itself may not connect anywhere: egressAllow [] and a resolver
  // that would only ever answer loopback. Success can only come via the service.
  const broker = createBroker({
    egressUrl: service.url.href,
    egressToken: TOKEN,
    egressAllow: [],
    resolveImpl: async () => [{ address: "127.0.0.1" }],
  });
  stops.push(() => broker.close());

  const ok = await broker.dispatch({ op: "fetch", url: `http://127.0.0.1:${up.port}/gzip` });
  expect(ok).toMatchObject({ ok: true, status: 200, body: "compressed hello" });

  await expect(broker.dispatch({ op: "fetch", url: "http://10.0.0.1/" })).rejects.toThrow(
    "fetch() refused: 10.0.0.1 resolves to 10.0.0.1",
  );

  const stranger = createBroker({ egressUrl: service.url.href, egressToken: "not-the-token" });
  stops.push(() => stranger.close());
  await expect(stranger.dispatch({ op: "fetch", url: `http://127.0.0.1:${up.port}/` })).rejects.toThrow(
    "rejected this broker's token",
  );
});

test("an address that cannot be connected to falls through to the next, and only then", async () => {
  const tried: string[] = [];
  const unreachable = Object.assign(new TypeError("no route"), { code: "FailedToOpenSocket" });
  const fetchImpl = async (url: URL | string) => {
    tried.push(new URL(url).hostname);
    if (tried.length === 1) throw unreachable;
    return new Response("ok");
  };
  const resolve = async () => [{ address: "2606:4700::1111" }, { address: "1.1.1.1" }];
  const res = await vettedFetch(new URL("https://one.example/"), {}, { resolve, allow: [], fetchImpl });
  expect([tried, await res.text()]).toEqual([["[2606:4700::1111]", "1.1.1.1"], "ok"]);

  // Any other failure may have sent the request already: no second attempt.
  tried.length = 0;
  const reset = Object.assign(new TypeError("reset"), { code: "ConnectionClosed" });
  const failing = async (url: URL | string) => {
    tried.push(new URL(url).hostname);
    throw reset;
  };
  await expect(vettedFetch(new URL("https://one.example/"), {}, { resolve, allow: [], fetchImpl: failing })).rejects.toBe(reset);
  expect(tried).toEqual(["[2606:4700::1111]"]);
});
