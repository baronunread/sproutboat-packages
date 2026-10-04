// #174 — the prelude's URL shim splits `host` into hostname and port. An IPv6
// literal holds colons of its own, so only the colon after `]` is the port's.
// Lifted out of the text-only prelude, as client-ip.test.js does.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("./native-fetch-prelude.js", import.meta.url)), "utf8");
const start = src.indexOf("function __sbPortColon(");
const end = src.indexOf("__sbDefineURLAccessor(", start);
if (start === -1 || end === -1) throw new Error("__sbPortColon not found in prelude");
// oxlint-disable-next-line no-function-constructor -- lifting a pure block out of the text-only prelude for test
const portColon = new Function(`${src.slice(start, end)}\nreturn __sbPortColon;`)();
const split = (host) => {
  const c = portColon(host);
  return c === -1 ? [host, ""] : [host.slice(0, c), host.slice(c + 1)];
};

test("hostname and port split at the port colon, never inside an IPv6 literal", () => {
  expect(split("example.com")).toEqual(["example.com", ""]);
  expect(split("example.com:8080")).toEqual(["example.com", "8080"]);
  expect(split("[::1]")).toEqual(["[::1]", ""]);
  expect(split("[::1]:9")).toEqual(["[::1]", "9"]);
  expect(split("[64:ff9b::7f00:2]:443")).toEqual(["[64:ff9b::7f00:2]", "443"]);
});
