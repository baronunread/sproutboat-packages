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
  for (const address of PUBLIC)
    expect([address, blockedRange(address)]).toEqual([address, null]);
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
  const block = source.slice(
    source.indexOf("// EGRESS:BEGIN"),
    source.indexOf("// EGRESS:END"),
  );
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
    const fromTs = addresses.map(
      (a) => egressRefusal("h", a, egressAllowList(ALLOW)) ?? "ok",
    );
    expect(fromC).toEqual(fromTs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#174: fetch() needs no config, so every sprout gets it", () => {
  const handler = `export default { async fetch() { return await fetch("https://api.example.com/"); } };`;
  expect(validateHttpSyncSource(handler)).toEqual({ ok: true });
  const prelude = readFileSync(
    new URL("./native-fetch-prelude.js", import.meta.url),
    "utf8",
  );
  expect(wrapNativeFetchHandler(handler, prelude)).toContain(
    "__sbInstallFetch();",
  );
});

test("SB_EGRESS_FD: the host connects, the sprout gets the socket", () => {
  const source = readFileSync(transportFile, "utf8");
  const block = source.slice(
    source.indexOf("// EGRESS-FD:BEGIN"),
    source.indexOf("// EGRESS-FD:END"),
  );
  const dir = mkdtempSync(join(tmpdir(), "sb-egress-fd-"));
  try {
    // A fake host on one end of a socketpair: "up" gets a socket whose peer says
    // "hello", "down" a refusal, and the third question is never answered.
    writeFileSync(
      join(dir, "check.c"),
      `#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/wait.h>
${block}
static void answer(int via, const char* text, int fd) {
  union { struct cmsghdr align; char space[CMSG_SPACE(sizeof(int))]; } control;
  struct iovec io = { (void*)text, strlen(text) };
  struct msghdr msg;
  memset(&msg, 0, sizeof(msg));
  msg.msg_iov = &io; msg.msg_iovlen = 1;
  if (fd >= 0) {
    msg.msg_control = control.space; msg.msg_controllen = sizeof(control.space);
    struct cmsghdr* c = CMSG_FIRSTHDR(&msg);
    c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS; c->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(c), &fd, sizeof(fd));
  }
  sendmsg(via, &msg, 0);
}
int main(void) {
  int pair[2];
  socketpair(AF_UNIX, SOCK_STREAM, 0, pair);
  if (fork() == 0) {
    close(pair[0]);
    char line[512];
    ssize_t n = read(pair[1], line, sizeof(line) - 1); line[n > 0 ? n : 0] = 0;
    printf("asked %s", line); fflush(stdout);
    int remote[2];
    socketpair(AF_UNIX, SOCK_STREAM, 0, remote);
    write(remote[1], "hello", 5);
    answer(pair[1], "ok\\n", remote[0]);
    n = read(pair[1], line, sizeof(line) - 1); line[n > 0 ? n : 0] = 0;
    printf("asked %s", line); fflush(stdout);
    answer(pair[1], "no fetch() refused: down.test is not allowed\\n", -1);
    n = read(pair[1], line, sizeof(line) - 1);
    _exit(0);  // closes without answering
  }
  close(pair[1]);
  char refused[512] = "";
  int fd = sb_egress_fd_connect(pair[0], "up.test", 443, refused, sizeof(refused));
  char got[6] = "";
  if (fd >= 0) read(fd, got, 5);
  printf("fd %s %s\\n", fd >= 0 ? "yes" : "no", got);
  fd = sb_egress_fd_connect(pair[0], "down.test", 80, refused, sizeof(refused));
  printf("fd %s %s\\n", fd >= 0 ? "yes" : "no", refused);
  refused[0] = 0;
  printf("fd %s\\n", sb_egress_fd_connect(pair[0], "gone.test", 80, refused, sizeof(refused)) >= 0 ? "yes" : "no");
  printf("fd %s\\n", sb_egress_fd_connect(pair[0], "after.test", 80, refused, sizeof(refused)) >= 0 ? "yes" : "no");
  wait(0);
  return 0;
}
`,
    );
    const cc = Bun.spawnSync([
      "cc",
      "-Wall",
      "-Werror",
      "-Wno-unused-result",
      "-o",
      join(dir, "check"),
      join(dir, "check.c"),
    ]);
    expect(cc.stderr.toString()).toBe("");
    const run = Bun.spawnSync([join(dir, "check")]);
    expect(run.stdout.toString().trimEnd().split("\n").sort()).toEqual(
      [
        "asked up.test 443",
        "fd yes hello",
        "asked down.test 80",
        "fd no fetch() refused: down.test is not allowed",
        "fd no",
        "fd no",
      ].sort(),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the Host header carries a non-default port", () => {
  const source = readFileSync(transportFile, "utf8");
  const between = (from: string, to: string) =>
    source.slice(source.indexOf(from), source.indexOf(to));
  const buffer = between(
    "typedef struct { char* p; size_t len; size_t cap; } sb_buf;",
    "static void sb_putjson(",
  );
  const builder = between(
    "// body_len, not strlen(body)",
    "// Turn a whole raw response",
  );
  const dir = mkdtempSync(join(tmpdir(), "sb-host-"));
  try {
    writeFileSync(
      join(dir, "check.c"),
      `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
${buffer}
${builder}
static void show(int port, int default_port) {
  sb_buf req = { 0, 0, 0 };
  sb_build_request(&req, "example.com", port, default_port, "/", "GET", "", 0, 0);
  printf("%s", strstr(req.p, "Host: "));
  free(req.p);
}
int main(void) { show(80, 80); show(8080, 80); show(443, 443); show(8443, 443); return 0; }
`,
    );
    const cc = Bun.spawnSync([
      "cc",
      "-Wall",
      "-Werror",
      "-Wno-unused-function",
      "-o",
      join(dir, "check"),
      join(dir, "check.c"),
    ]);
    expect(cc.stderr.toString()).toBe("");
    const hosts = Bun.spawnSync([join(dir, "check")])
      .stdout.toString()
      .split("\r\n")
      .filter((l) => l.startsWith("Host: "));
    expect(hosts).toEqual([
      "Host: example.com",
      "Host: example.com:8080",
      "Host: example.com",
      "Host: example.com:8443",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("async fetch: requests run on threads and come back through the host", () => {
  const source = readFileSync(transportFile, "utf8");
  const block = source.slice(
    source.indexOf("// ASYNC:BEGIN"),
    source.indexOf("// ASYNC:END"),
  );
  const dir = mkdtempSync(join(tmpdir(), "sb-async-"));
  try {
    // Stand-ins: a client that takes 200 ms, and a host that records which timers fire.
    writeFileSync(
      join(dir, "check.c"),
      `#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <pthread.h>
typedef unsigned int u32;
static void sb_init_anchors(void) {}
static char* sb_error_json(const char* a, const char* b) { char* s = malloc(256); snprintf(s, 256, "%s%s", a, b); return s; }
static char* sb_http_request(const char* host, int port, const char* path, const char* method,
                             const char* headers, const char* body, size_t body_len, int tls) {
  (void)port; (void)method; (void)headers; (void)body_len; (void)tls;
  usleep(200000);
  char* s = malloc(256); snprintf(s, 256, "%s%s %s", host, path, body); return s;
}
static int fired = 0;
void porf_native_fetch_timer_clear(u32 id) { (void)id; }
const char* sb_async_reply(u32 id);
void porf_native_fetch_fire_timer(u32 id) { printf("%u %s\\n", id, sb_async_reply(id)); fired++; }
static char* copy(const char* s) { return strdup(s); }
${block}
int main(void) {
  int fd = sb_async_enable();
  if (fd < 0 || !sb_async_enabled()) return 1;
  struct timespec a, b;
  clock_gettime(CLOCK_MONOTONIC, &a);
  for (u32 i = 1; i <= 16; i++) {
    char path[16]; snprintf(path, sizeof(path), "/%u", i);
    sb_async_submit(i, 80, 0, copy("h"), copy(path), copy("GET"), copy(""), copy("body"), 4);
  }
  while (fired < 16) { struct pollfd p = { fd, POLLIN, 0 }; poll(&p, 1, 5000); sb_async_drain(); }
  clock_gettime(CLOCK_MONOTONIC, &b);
  long ms = (b.tv_sec - a.tv_sec) * 1000 + (b.tv_nsec - a.tv_nsec) / 1000000;
  printf("elapsed %s\\n", ms < 1000 ? "overlapped" : "serial");
  printf("outside a callback %s\\n", sb_async_reply(1) ? "leaks" : "nothing");
  return 0;
}
`,
    );
    const cc = Bun.spawnSync([
      "cc",
      "-Wall",
      "-Werror",
      "-Wno-unused-function",
      "-pthread",
      "-o",
      join(dir, "check"),
      join(dir, "check.c"),
    ]);
    expect(cc.stderr.toString()).toBe("");
    const lines = Bun.spawnSync([join(dir, "check")])
      .stdout.toString()
      .trimEnd()
      .split("\n");
    // 16 requests of 200 ms on 8 threads: two rounds, not sixteen.
    expect(lines.slice(0, 16).sort()).toEqual(
      Array.from({ length: 16 }, (_, i) => `${i + 1} h/${i + 1} body`).sort(),
    );
    expect(lines.slice(16)).toEqual([
      "elapsed overlapped",
      "outside a callback nothing",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
