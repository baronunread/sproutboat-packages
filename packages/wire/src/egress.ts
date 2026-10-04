/**
 * Outbound `fetch()` for sprouts: the private-address block (#174) and the
 * egress service (baronunread/sproutboat#252).
 *
 * The broker normally fetches itself. On the systemd install it runs inside the
 * edge unit, whose `IPAddressDeny=any` keeps sprouts off the network and the
 * broker with them, so it hands each request to this service instead: a
 * separate unit outside that cgroup, listening on loopback. Sprouts share
 * loopback, so every call carries a token that only brokers are given (the
 * sprout sandbox clears its environment).
 *
 *   SB_EGRESS_TOKEN=... bun egress.ts --port 8070
 *
 * Either way the request goes through `vettedFetch`, so the address checks and
 * `SB_EGRESS_ALLOW` behave identically.
 */
import { timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { parseArgs } from "node:util";
import { egressAllowList, egressRefusal } from "@sproutboat/runtime";

type FetchLike = (input: URL | string, init?: RequestInit) => Promise<Response>;
export type Resolve = (hostname: string) => Promise<Array<{ address: string }>>;
export const resolveAll: Resolve = (hostname) => lookup(hostname, { all: true });

/** The target URL, the caller's token, and the marker on a refusal reply. */
export const EGRESS_URL_HEADER = "x-sb-egress-url";
export const EGRESS_TOKEN_HEADER = "x-sb-egress-token";
export const EGRESS_ERROR_HEADER = "x-sb-egress-error";

/**
 * #174 — resolve, vet every address, then connect to the vetted one, never the
 * name: handing the name to fetch() would resolve it again, and DNS rebinding
 * lives in that gap. TLS still verifies against the name. Throws the refusal.
 */
export async function vettedFetch(
  url: URL,
  init: RequestInit,
  opts: { resolve: Resolve; allow: readonly string[]; fetchImpl: FetchLike },
): Promise<Response> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: Array<{ address: string }>;
  try {
    addresses = await opts.resolve(hostname);
  } catch {
    throw new Error(`could not resolve ${url.hostname}`);
  }
  let refusal: string | null = null;
  const vetted = addresses.filter(({ address }) => {
    const why = egressRefusal(url.hostname, address, opts.allow);
    refusal ??= why;
    return why === null;
  });
  if (vetted.length === 0) throw new Error(refusal ?? `could not resolve ${url.hostname}`);
  const headers = new Headers(init.headers);
  headers.set("host", url.host);
  const pinnedInit: RequestInit & { tls?: { serverName: string } } = { ...init, headers, redirect: "manual" };
  // Bun's TLS option: SNI and certificate checks against the name, not the address.
  if (url.protocol === "https:" && !isIP(hostname)) pinnedInit.tls = { serverName: hostname };
  // Like the standalone client, move on to the next address when one cannot be
  // connected to (an IPv6 answer on a host with no IPv6 route). Only on those
  // codes: nothing has been sent yet, so a retry cannot repeat a request.
  let lastError: unknown;
  for (const { address } of vetted) {
    const pinned = new URL(url);
    pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;
    try {
      return await opts.fetchImpl(pinned, pinnedInit);
    } catch (error) {
      lastError = error;
      // SAFETY: only reads an optional `code`; anything without one is rethrown.
      const code = (error as { code?: unknown } | null)?.code;
      if (!CONNECT_FAILURES.has(String(code))) throw error;
    }
  }
  throw lastError;
}

/** Bun's fetch codes for a connection that never opened. */
const CONNECT_FAILURES = new Set(["FailedToOpenSocket", "ConnectionRefused", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"]);

const refuse = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { [EGRESS_ERROR_HEADER]: "1" } });

export type EgressOptions = {
  /** Required: brokers send it, sprouts never see it. */
  token: string;
  /** `SB_EGRESS_ALLOW`, split. */
  allow?: string[];
  /** Injected in tests. */
  resolve?: Resolve;
  fetchImpl?: FetchLike;
};

/** The service's request handler: one upstream request per call. */
export function createEgressHandler(opts: EgressOptions): (request: Request) => Promise<Response> {
  if (!opts.token) throw new Error("the egress service needs a token");
  const expected = Buffer.from(opts.token);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const resolve = opts.resolve ?? resolveAll;
  const allow = opts.allow ?? [];
  return async (request) => {
    const given = Buffer.from(request.headers.get(EGRESS_TOKEN_HEADER) ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return new Response("unauthorized", { status: 401 });
    }
    let url: URL;
    try {
      url = new URL(request.headers.get(EGRESS_URL_HEADER) ?? "");
    } catch {
      return refuse(400, `invalid url: ${request.headers.get(EGRESS_URL_HEADER) ?? ""}`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return refuse(400, `unsupported protocol: ${url.protocol}`);
    const headers = new Headers(request.headers);
    for (const name of [EGRESS_URL_HEADER, EGRESS_TOKEN_HEADER, "host", "content-length"]) headers.delete(name);
    const method = request.method;
    // `decompress: false` relays the upstream's bytes and Content-Encoding as
    // they came, so the broker decodes them exactly as a direct fetch would.
    const init: RequestInit & { decompress?: boolean } = {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer(),
      decompress: false,
    };
    try {
      const upstream = await vettedFetch(url, init, { resolve, allow, fetchImpl });
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    } catch (error) {
      return refuse(502, error instanceof Error ? error.message : String(error));
    }
  };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { port: { type: "string" }, host: { type: "string" } } });
  const token = process.env.SB_EGRESS_TOKEN ?? "";
  if (!token) {
    console.error("sproutboat egress: SB_EGRESS_TOKEN is required");
    process.exit(1);
  }
  const server = Bun.serve({
    hostname: values.host ?? "127.0.0.1",
    port: Number(values.port ?? process.env.PORT ?? 8070),
    // A direct fetch has no idle cutoff either; the broker owns the deadline.
    idleTimeout: 0,
    fetch: createEgressHandler({ token, allow: egressAllowList(process.env.SB_EGRESS_ALLOW) }),
  });
  console.log(`sproutboat egress listening on ${server.url}`);
}
