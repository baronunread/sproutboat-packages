import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentType,
  isSproutFirst,
  matchHeaders,
  matchRedirect,
  parseHeaders,
  parseRedirects,
  readAssetRules,
  walkAssets,
} from "./assets";

test("contentType maps known extensions, defaults to octet-stream", () => {
  expect(contentType("index.html")).toBe("text/html; charset=utf-8");
  expect(contentType("app.CSS")).toBe("text/css; charset=utf-8");
  expect(contentType("logo.png")).toBe("image/png");
  expect(contentType("archive.tar")).toBe("application/octet-stream");
  expect(contentType("noext")).toBe("application/octet-stream");
});

test("isSproutFirst: boolean short-circuits; patterns match with negation", () => {
  expect(isSproutFirst(true, "/anything")).toBe(true);
  expect(isSproutFirst(false, "/anything")).toBe(false);
  expect(isSproutFirst(["/api/*"], "/api/users")).toBe(true);
  expect(isSproutFirst(["/api/*"], "/index.html")).toBe(false);
  expect(isSproutFirst(["/api/*", "!/api/docs/*"], "/api/docs/intro")).toBe(false);
  expect(isSproutFirst(["/api/**"], "/api/a/b/c")).toBe(true);
  expect(isSproutFirst(["/api/*"], "/api/a/b")).toBe(false); // single * stays in a segment
});

test("walkAssets hashes every file under a directory, posix keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-walk-"));
  mkdirSync(join(dir, "css"));
  writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
  writeFileSync(join(dir, "css", "app.css"), "body{}");
  writeFileSync(join(dir, ".hidden"), "skip me");
  const files = walkAssets(dir);
  expect(Object.keys(files).sort()).toEqual(["/css/app.css", "/index.html"]);
  expect(files["/index.html"]).toMatchObject({ size: 11, type: "text/html; charset=utf-8" });
  expect(files["/index.html"].hash).toMatch(/^[0-9a-f]{64}$/);
  rmSync(dir, { recursive: true, force: true });
});

test("walkAssets excludes _headers/_redirects at the root, but not nested files with those names", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-walk-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "_headers"), "/*\n  X-Test: 1\n");
  writeFileSync(join(dir, "_redirects"), "/a /b\n");
  writeFileSync(join(dir, "sub", "_headers"), "not config, just a file");
  const files = walkAssets(dir);
  expect(Object.keys(files).sort()).toEqual(["/sub/_headers"]);
  rmSync(dir, { recursive: true, force: true });
});

test("parseHeaders: set and unset lines, comments, and blank lines ending a block", () => {
  const rules = parseHeaders(
    [
      "# a comment",
      "/*",
      "  X-Frame-Options: DENY",
      "  Cache-Control: no-cache",
      "",
      "/assets/*",
      "  Cache-Control: public, max-age=31536000",
      "  ! X-Frame-Options",
    ].join("\n"),
  );
  expect(rules).toEqual([
    {
      pattern: "/*",
      set: [
        ["X-Frame-Options", "DENY"],
        ["Cache-Control", "no-cache"],
      ],
      unset: [],
    },
    { pattern: "/assets/*", set: [["Cache-Control", "public, max-age=31536000"]], unset: ["X-Frame-Options"] },
  ]);
});

test("parseHeaders: an indented line with no preceding pattern is ignored", () => {
  expect(parseHeaders("  X-Test: 1\n")).toEqual([]);
});

test("matchHeaders: returns rules whose pattern matches, in file order", () => {
  const rules = parseHeaders("/*\n  A: 1\n\n/assets/*\n  B: 2\n");
  expect(matchHeaders(rules, "/assets/app.js").map((r) => r.pattern)).toEqual(["/*", "/assets/*"]);
  expect(matchHeaders(rules, "/index.html").map((r) => r.pattern)).toEqual(["/*"]);
});

test("parseRedirects: from/to/status, default status, malformed lines dropped", () => {
  expect(
    parseRedirects(["# comment", "/old /new 301", "/a /b", "/bad-status /c 200", "just-one-token"].join("\n")),
  ).toEqual([
    { from: "/old", to: "/new", status: 301 },
    { from: "/a", to: "/b", status: 302 },
  ]);
});

test("matchRedirect: exact path, no placeholders", () => {
  const rule = { from: "/old", to: "/new", status: 301 };
  expect(matchRedirect(rule, "/old")).toBe("/new");
  expect(matchRedirect(rule, "/old/extra")).toBeNull();
  expect(matchRedirect(rule, "/other")).toBeNull();
});

test("matchRedirect: :name segments substitute into `to`", () => {
  const rule = { from: "/user/:id", to: "/profile/:id", status: 302 };
  expect(matchRedirect(rule, "/user/42")).toBe("/profile/42");
  expect(matchRedirect(rule, "/user")).toBeNull();
  expect(matchRedirect(rule, "/user/42/extra")).toBeNull();
});

test("matchRedirect: a trailing * captures the rest of the path as :splat", () => {
  const rule = { from: "/blog/*", to: "/articles/:splat", status: 301 };
  expect(matchRedirect(rule, "/blog/2024/hello")).toBe("/articles/2024/hello");
  expect(matchRedirect(rule, "/blog/")).toBe("/articles/");
  expect(matchRedirect(rule, "/blog")).toBeNull();
});

test("readAssetRules: empty when neither file exists, parsed when both do", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-rules-"));
  expect(readAssetRules(dir)).toEqual({ headers: [], redirects: [] });
  writeFileSync(join(dir, "_headers"), "/*\n  X: 1\n");
  writeFileSync(join(dir, "_redirects"), "/a /b\n");
  const rules = readAssetRules(dir);
  expect(rules.headers).toHaveLength(1);
  expect(rules.redirects).toHaveLength(1);
  rmSync(dir, { recursive: true, force: true });
});
