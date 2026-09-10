// #163 — the client-IP resolution helpers live inline in native-fetch-prelude.js
// (the prelude is prepended as text and cannot import), so this test lifts that
// one pure-JS block out and exercises it directly. If the block moves or its
// boundary markers change, this fails loudly rather than silently testing nothing.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("./native-fetch-prelude.js", import.meta.url)), "utf8");
const start = src.indexOf("function __sbParseHex(");
const end = src.indexOf("globalThis.__sbEntry");
if (start === -1 || end === -1 || end < start) throw new Error("client-ip helper block not found in prelude");

let env = {};
// oxlint-disable-next-line no-function-constructor -- lifting a pure block out of the text-only prelude for test
const load = new Function(
  "__envMap",
  `${src.slice(start, end)}
   const __sbEnv = (k) => __envMap[k];
   return { __sbNormalizeIp, __sbIpInCidr, __sbIpTrusted, __sbClientIp, __sbSplitList };`,
);
const H = load(new Proxy({}, { get: (_, k) => env[k] }));

const req = (headers) => ({ headers: { get: (k) => headers[k.toLowerCase()] ?? null } });

test("__sbNormalizeIp folds IPv4-mapped IPv6 to dotted quad", () => {
  expect(H.__sbNormalizeIp("0000:0000:0000:0000:0000:ffff:7f00:0001")).toBe("127.0.0.1");
  expect(H.__sbNormalizeIp("::ffff:198.51.100.9")).toBe("198.51.100.9");
  expect(H.__sbNormalizeIp("203.0.113.7")).toBe("203.0.113.7");
  expect(H.__sbNormalizeIp("2001:db8::1")).toBe("2001:db8::1"); // real IPv6 untouched
  expect(H.__sbNormalizeIp("")).toBe("");
});

test("__sbIpInCidr does IPv4 range math without sign errors above 2^31", () => {
  expect(H.__sbIpInCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
  expect(H.__sbIpInCidr("11.0.0.1", "10.0.0.0/8")).toBe(false);
  expect(H.__sbIpInCidr("203.0.113.7", "203.0.113.7")).toBe(true); // bare IP
  expect(H.__sbIpInCidr("192.168.1.1", "0.0.0.0/0")).toBe(true);
  // 224.x is > 2^31 as a uint32 — the divide-not-mask path.
  expect(H.__sbIpInCidr("224.0.0.5", "224.0.0.0/24")).toBe(true);
  expect(H.__sbIpInCidr("224.0.1.5", "224.0.0.0/24")).toBe(false);
});

test("__sbClientIp: no trusted proxies means the peer wins, XFF ignored", () => {
  env = {};
  const r = req({ "x-sb-remote-addr": "::ffff:203.0.113.7", "x-forwarded-for": "1.2.3.4" });
  expect(H.__sbClientIp(r)).toBe("203.0.113.7");
});

test("__sbClientIp: a trusted peer resolves the rightmost untrusted XFF hop", () => {
  env = { SB_TRUSTED_PROXIES: "127.0.0.0/8, 10.0.0.0/8" };
  expect(H.__sbClientIp(req({ "x-sb-remote-addr": "127.0.0.1", "x-forwarded-for": "203.0.113.7, 10.1.2.3" }))).toBe(
    "203.0.113.7",
  );
  // every hop trusted → fall back to the peer
  expect(H.__sbClientIp(req({ "x-sb-remote-addr": "127.0.0.1", "x-forwarded-for": "10.9.9.9" }))).toBe("127.0.0.1");
  // mapped-v6 entry in the chain is normalised
  expect(
    H.__sbClientIp(req({ "x-sb-remote-addr": "10.0.0.1", "x-forwarded-for": "::ffff:198.51.100.9, 10.1.2.3" })),
  ).toBe("198.51.100.9");
});

test("__sbClientIp: an untrusted peer cannot use XFF even if it sends one", () => {
  env = { SB_TRUSTED_PROXIES: "10.0.0.0/8" };
  expect(H.__sbClientIp(req({ "x-sb-remote-addr": "198.51.100.9", "x-forwarded-for": "1.1.1.1" }))).toBe("198.51.100.9");
});
