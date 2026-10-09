import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  matchRedirect,
  matchHeaders,
  parseHeaders,
  parseRedirects,
} from "../../assets/src/assets.ts";

const source = readFileSync(new URL("./native-fetch-prelude.js", import.meta.url), "utf8");
const start = source.indexOf("function __sbAssetRedirect(");
const end = source.indexOf("// Installed only when the project declares bindings.", start);
if (start < 0 || end < start) throw new Error("asset rule helpers not found");
// oxlint-disable-next-line no-function-constructor -- test the text-only native prelude
const load = new Function(
  "__sbRawBodyResponse",
  source.slice(start, end) +
    "\nreturn { redirect: __sbAssetRedirect, matches: __sbAssetHeaderMatches, response: __sbAssetResponse };",
);
const { redirect, matches, response } = load((body, init) => new Response(body, init));

test("native redirect matching agrees with shared asset rules", () => {
  const rules = parseRedirects(
    "/old /new 301\n/blog/:slug /posts/:slug\n/docs/* https://example.test/:splat 307",
  );
  for (const path of [
    "/old",
    "/old/",
    "/blog/a",
    "/blog/a/b",
    "/docs",
    "/docs/",
    "/docs/a/b",
    "/missing",
  ]) {
    for (const rule of rules) expect(redirect(rule, path)).toBe(matchRedirect(rule, path));
  }
});

test("native header matching agrees with shared asset rules", () => {
  const rules = parseHeaders(
    "/*\n  X-Test: yes\n/assets/*\n  Cache-Control: public\n/exact\n  ! ETag",
  );
  for (const path of ["/", "/assets", "/assets/a/b", "/exact", "/exact/deep", "/missing"]) {
    expect(rules.filter((rule) => matches(rule.pattern, path))).toEqual(matchHeaders(rules, path));
  }
});

test("redirects override files and SPA fallback, with the first matching rule winning", () => {
  const rules = { redirects: parseRedirects("/old /first 301\n/old /second 302") };
  for (const found of [true, false]) {
    const result = response("/old", {
      found,
      body: "asset",
      type: "text/html",
      hash: "abc",
      rules,
    });
    expect(result.status).toBe(301);
    expect(result.headers.get("location")).toBe("/first");
    expect(result.headers.has("etag")).toBe(false);
    expect(result.headers.has("x-sb-raw-body")).toBe(false);
  }
});

test("header rules replace and remove defaults in order without losing the raw-byte marker", async () => {
  const rules = {
    headers: parseHeaders(
      "/*\n  X-Test: first\n  Cache-Control: public\n/assets/*\n  X-Test: second\n  ! ETag\n  ! x-sb-raw-body",
    ),
  };
  const result = response("/assets/deep/file.bin", {
    found: true,
    status: 200,
    body: "binary",
    type: "application/octet-stream",
    hash: "abc",
    rules,
  });
  expect(result.headers.get("x-test")).toBe("second");
  expect(result.headers.get("cache-control")).toBe("public");
  expect(result.headers.has("etag")).toBe(false);
  expect(result.headers.get("x-sb-raw-body")).toBe("1");
  expect(await result.text()).toBe("binary");
});

test("SPA/custom-404 assets receive headers, generated missing responses do not", () => {
  const rules = { headers: parseHeaders("/*\n  X-Test: asset") };
  expect(
    response("/missing", {
      status: 200,
      found: true,
      type: "text/html",
      body: "shell",
      rules,
    }).headers.get("x-test"),
  ).toBe("asset");
  const custom = response("/missing", {
    status: 404,
    found: false,
    type: "text/html",
    body: "404 page",
    rules,
  });
  expect(custom.status).toBe(404);
  expect(custom.headers.get("x-test")).toBe("asset");
  expect(
    response("/missing", { status: 404, found: false, body: "Not Found", rules }).headers.has(
      "x-test",
    ),
  ).toBe(false);
});

test("a set wins over an unset in the same header block, matching edge behavior", () => {
  const rules = { headers: parseHeaders("/*\n  ! ETag\n  ETag: custom") };
  expect(
    response("/file", {
      found: true,
      type: "text/plain",
      body: "x",
      hash: "abc",
      rules,
    }).headers.get("etag"),
  ).toBe("custom");
});
