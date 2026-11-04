import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { BEARSSL_SHA256, BEARSSL_URLS } from "./deps";
import { fetchPinned } from "./fetch-pinned";

const body = Buffer.from("pinned bytes");
const sha256 = createHash("sha256").update(body).digest("hex");
const sleep = async () => {};

function server(routes: Record<string, (Response | Error)[]>) {
  const calls: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const next = routes[url]?.shift() ?? new Response("gone", { status: 404 });
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetcher };
}

test("uses the first mirror when it serves the pinned bytes", async () => {
  const s = server({ "https://ours/a": [new Response(body)], "https://up/a": [new Response(body)] });
  expect(await fetchPinned({ urls: ["https://ours/a", "https://up/a"], sha256, fetcher: s.fetcher, sleep })).toEqual(
    body,
  );
  expect(s.calls).toEqual(["https://ours/a"]);
});

test("falls back to the next mirror when the first is missing", async () => {
  const s = server({
    "https://ours/a": [new Response("", { status: 404 })],
    "https://up/a": [new Response(body)],
  });
  expect(await fetchPinned({ urls: ["https://ours/a", "https://up/a"], sha256, fetcher: s.fetcher, sleep })).toEqual(
    body,
  );
  expect(s.calls).toEqual(["https://ours/a", "https://up/a"]);
});

test("rejects a mirror that serves different bytes and uses the next", async () => {
  const s = server({ "https://evil/a": [new Response("tampered")], "https://up/a": [new Response(body)] });
  expect(await fetchPinned({ urls: ["https://evil/a", "https://up/a"], sha256, fetcher: s.fetcher, sleep })).toEqual(
    body,
  );
  expect(s.calls).toEqual(["https://evil/a", "https://up/a"]);
});

test("throws when every source fails the hash, and writes no cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fetch-pinned-"));
  try {
    const s = server({ "https://evil/a": [new Response("tampered")] });
    const cachePath = join(dir, "x.tar.gz");
    await expect(
      fetchPinned({ urls: ["https://evil/a"], sha256, fetcher: s.fetcher, sleep, cachePath }),
    ).rejects.toThrow(/sha256 mismatch/);
    expect(await Bun.file(cachePath).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("retries a 5xx and a network error with exponential backoff, then succeeds", async () => {
  const s = server({
    "https://up/a": [new Response("", { status: 502 }), new Error("socket hang up"), new Response(body)],
  });
  const waits: number[] = [];
  const got = await fetchPinned({
    urls: ["https://up/a"],
    sha256,
    fetcher: s.fetcher,
    backoffMs: 100,
    sleep: async (ms) => void waits.push(ms),
  });
  expect(got).toEqual(body);
  expect(s.calls.length).toBe(3);
  expect(waits).toEqual([100, 200]);
});

test("retries are bounded, then the next mirror is tried", async () => {
  const bad = () => new Response("", { status: 502 });
  const s = server({ "https://up/a": [bad(), bad(), bad(), bad()], "https://m/a": [new Response(body)] });
  expect(
    await fetchPinned({ urls: ["https://up/a", "https://m/a"], sha256, fetcher: s.fetcher, attempts: 3, sleep }),
  ).toEqual(body);
  expect(s.calls).toEqual(["https://up/a", "https://up/a", "https://up/a", "https://m/a"]);
});

test("a 4xx is not retried", async () => {
  const s = server({ "https://up/a": [new Response("", { status: 404 }), new Response(body)] });
  await expect(fetchPinned({ urls: ["https://up/a"], sha256, fetcher: s.fetcher, sleep })).rejects.toThrow(/HTTP 404/);
  expect(s.calls.length).toBe(1);
});

test("a verified copy is cached and reused with no network", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fetch-pinned-"));
  try {
    const cachePath = join(dir, "sub", "x.tar.gz");
    const s = server({ "https://up/a": [new Response(body)] });
    await fetchPinned({ urls: ["https://up/a"], sha256, fetcher: s.fetcher, sleep, cachePath });
    expect(await readFile(cachePath)).toEqual(body);
    const offline = server({});
    expect(await fetchPinned({ urls: ["https://up/a"], sha256, fetcher: offline.fetcher, sleep, cachePath })).toEqual(
      body,
    );
    expect(offline.calls).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt cache entry is discarded and refetched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fetch-pinned-"));
  try {
    const cachePath = join(dir, "x.tar.gz");
    await Bun.write(cachePath, "corrupt");
    const s = server({ "https://up/a": [new Response(body)] });
    expect(await fetchPinned({ urls: ["https://up/a"], sha256, fetcher: s.fetcher, sleep, cachePath })).toEqual(body);
    expect(await readFile(cachePath)).toEqual(body);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("BearSSL pin: our release first, bearssl.org as fallback, CI cache keyed by the sha256", async () => {
  expect(BEARSSL_URLS[0]).toBe(
    "https://github.com/baronunread/sproutboat-packages/releases/download/deps-bearssl-7bea48e5/bearssl-7bea48e.tar.gz",
  );
  expect(BEARSSL_URLS.at(-1)).toContain("https://bearssl.org/");
  expect(BEARSSL_SHA256).toMatch(/^[0-9a-f]{64}$/);
  const ci = await Bun.file(join(import.meta.dir, "../../../.github/workflows/ci.yml")).text();
  expect(ci).toContain(`bearssl-src-${BEARSSL_SHA256}`);
});
