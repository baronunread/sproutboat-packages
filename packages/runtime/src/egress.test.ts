import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blockedRange,
  egressAllowList,
  egressRefusal,
  parseAddress,
  spliceEgressTable,
} from "./egress";
import { validateHttpSyncSource } from "./source";
import { wrapNativeFetchHandler } from "./wrap";

const BLOCKED = [
  "0.0.0.0",
  "10.1.2.3",
  "100.64.0.1",
  "100.127.255.255",
  "127.0.0.1",
  "127.255.255.254",
  "169.254.169.254",
  "172.16.0.1",
  "172.31.255.255",
  "192.0.0.8",
  "192.0.2.1",
  "192.168.1.1",
  "198.18.0.1",
  "198.19.255.255",
  "224.0.0.1",
  "255.255.255.255",
  "::",
  "::1",
  "::ffff:127.0.0.1",
  "64:ff9b::7f00:1",
  "64:ff9b::a00:1",
  "64:ff9b:1::1",
  "2002:7f00:1::1",
  "2001:db8::1",
  "fc00::1",
  "fd12::1",
  "fe80::1",
  "ff02::1",
];
const PUBLIC = [
  "1.1.1.1",
  "8.8.8.8",
  "100.128.0.1",
  "172.15.255.255",
  "172.32.0.1",
  "198.20.0.1",
  "::ffff:8.8.8.8",
  "64:ff9b::808:808",
  "2002:808:808::1",
  "2001:4860:4860::8888",
  "2606:4700::1111",
];
const ALLOW = "8.8.4.4, 10.9.9.9";

test("private and reserved addresses are blocked, public ones are not", () => {
  for (const address of BLOCKED)
    expect([address, blockedRange(address)]).not.toEqual([address, null]);
  for (const address of PUBLIC) expect([address, blockedRange(address)]).toEqual([address, null]);
  expect(blockedRange("::ffff:127.0.0.1")).toBe("127.0.0.0/8");
  expect(blockedRange("64:ff9b::a00:1")).toBe("10.0.0.0/8");
});

test("the operator allow list lets an exact address or everything through", () => {
  expect(egressRefusal("db", "10.9.9.9", egressAllowList(ALLOW))).toBeNull();
  expect(egressRefusal("db", "10.9.9.8", egressAllowList(ALLOW))).toContain(
    "SB_EGRESS_ALLOW=10.9.9.8",
  );
  expect(egressRefusal("db", "127.0.0.1", ["*"])).toBeNull();
  expect(egressRefusal("x", "169.254.169.254", [])).toBe(
    "fetch() refused: x resolves to 169.254.169.254, a private or reserved address (169.254.0.0/16). An operator can allow it with SB_EGRESS_ALLOW=169.254.169.254",
  );
});

test("parseAddress rejects what is not an address", () => {
  for (const bad of [
    "",
    "1.2.3",
    "256.1.1.1",
    "example.com",
    "1::2::3",
    "1:2:3:4:5:6:7:8:9",
    "12345::",
  ])
    expect([bad, parseAddress(bad)]).toEqual([bad, null]);
});

const transportFile = new URL("./transport-embedded.js", import.meta.url);

test("the C table in transport-embedded.js is generated from this one (bun run gen:egress)", () => {
  const source = readFileSync(transportFile, "utf8");
  expect(spliceEgressTable(source)).toBe(source);
});

test("the C check gives the same answer and message as the TS one", () => {
  const source = readFileSync(transportFile, "utf8");
  const block = source.slice(source.indexOf("// EGRESS:BEGIN"), source.indexOf("// EGRESS:END"));
  const dir = mkdtempSync(join(tmpdir(), "sb-egress-"));
  try {
    writeFileSync(
      join(dir, "check.c"),
      `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
${block}
int main(int argc, char** argv) {
  for (int i = 1; i < argc; i++) {
    struct sockaddr_storage ss;
    memset(&ss, 0, sizeof(ss));
    struct sockaddr_in* v4 = (struct sockaddr_in*)&ss;
    struct sockaddr_in6* v6 = (struct sockaddr_in6*)&ss;
    if (inet_pton(AF_INET, argv[i], &v4->sin_addr) == 1) v4->sin_family = AF_INET;
    else if (inet_pton(AF_INET6, argv[i], &v6->sin6_addr) == 1) v6->sin6_family = AF_INET6;
    else { printf("unparsed\\n"); continue; }
    char msg[512];
    printf("%s\\n", sb_egress_refused("h", (struct sockaddr*)&ss, msg, sizeof(msg)) ? msg : "ok");
  }
  return 0;
}
`,
    );
    const cc = Bun.spawnSync([
      "cc",
      "-Wall",
      "-Werror",
      "-o",
      join(dir, "check"),
      join(dir, "check.c"),
    ]);
    expect(cc.stderr.toString()).toBe("");
    const addresses = [...BLOCKED, ...PUBLIC, "10.9.9.9"];
    const run = Bun.spawnSync([join(dir, "check"), ...addresses], {
      env: { ...process.env, SB_EGRESS_ALLOW: ALLOW },
    });
    const fromC = run.stdout.toString().trimEnd().split("\n");
    const fromTs = addresses.map((a) => egressRefusal("h", a, egressAllowList(ALLOW)) ?? "ok");
    expect(fromC).toEqual(fromTs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#174: fetch() needs no config, so every sprout gets it", () => {
  const handler = `export default { async fetch() { return await fetch("https://api.example.com/"); } };`;
  expect(validateHttpSyncSource(handler)).toEqual({ ok: true });
  const prelude = readFileSync(new URL("./native-fetch-prelude.js", import.meta.url), "utf8");
  expect(wrapNativeFetchHandler(handler, prelude)).toContain("__sbInstallFetch();");
});
