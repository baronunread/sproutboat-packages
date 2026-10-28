import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// Per-request CPU (design 02): x-sb-cpu-ms counts the thread CPU time of the slices in which one
// request ran. A spinner interleaved with requests that wait is charged for its own work, the
// waiters for theirs, whatever order they run in. An async handler reports it from compatibility
// date 2026-11-02; before that only a handler that answers synchronously does.
const handler = `export default {async fetch(request) {
  const url = new URL(request.url);
  const ms = Number(url.searchParams.get("ms") || 0);
  const sleep = (n) => new Promise((resolve) => setTimeout(resolve, n));
  // Work, not wall time: a loaded machine deschedules the process, and CPU time must not follow wall time.
  const spin = (n) => { let x = 1; for (let i = 0; i < n * 40000; i++) x = (x * 1.0000001 + i) % 1000003; return x; };
  if (url.pathname === "/spin") {
    await sleep(5);
    spin(ms / 2);
    await sleep(5);
    spin(ms / 2);
    return new Response("spun");
  }
  if (url.pathname === "/wait") {
    await sleep(ms);
    return new Response("waited");
  }
  if (url.pathname === "/sync") {
    spin(ms);
    return new Response("sync");
  }
  return new Response("none", { status: 404 });
}};`;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-cpu-requests-"));
const servers: ReturnType<typeof Bun.spawn>[] = [];
async function build(date: string): Promise<number> {
  const porffor = await ensurePorffor();
  const node = Bun.which("node");
  if (!node) throw new Error("native cpu test needs node on PATH");
  const [core, broker] = await Promise.all([readFile(preludePath, "utf8"), readFile(transportPath("broker"), "utf8")]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const generated = join(workdir, `cpu-${date}.generated.js`);
  const binary = join(workdir, `cpu-${date}`);
  await writeFile(
    generated,
    wrapNativeFetchHandler(handler, core.replace(TRANSPORT_MARKER, broker), undefined, undefined, undefined, date),
  );
  const compile = Bun.spawn(
    [node, resolve(porffor, "runtime/index.js"), "native", generated, "-o", binary, "-s", "-O0"],
    {
      cwd: workdir,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    compile.exited,
    new Response(compile.stdout).text(),
    new Response(compile.stderr).text(),
  ]);
  assert.equal(exitCode, 0, `Porffor native compile failed:\n${stderr}\n${stdout}`);
  const port = freePort();
  const server = Bun.spawn([binary], {
    cwd: workdir,
    env: { ...process.env, PORT: String(port) },
    stdout: "ignore",
    stderr: "inherit",
  });
  servers.push(server);
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/none`, { signal: AbortSignal.timeout(500) });
      return port;
    } catch {
      if (server.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  throw new Error("compiled handler did not start");
}

try {
  const port = await build("2026-11-02");
  const cpu = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    await response.text();
    const header = response.headers.get("x-sb-cpu-ms");
    assert(header !== null, `${path} has no x-sb-cpu-ms`);
    return Number(header);
  };

  const alone = await cpu("/spin?ms=200");
  assert(alone > 10, `a spinner alone reports only ${alone} ms`);
  const sync = await cpu("/sync?ms=200");
  assert(
    sync > alone * 0.5 && sync < alone * 2,
    `a synchronous spinner of the same work reports ${sync} ms, the async one ${alone}`,
  );
  const idle = await cpu("/wait?ms=50");
  assert(idle < alone / 4 && idle < 30, `a request that only waits reports ${idle} ms (a spinner: ${alone})`);

  // Together: the spinner next to eight waiters, repeated so the slices interleave differently.
  for (let round = 0; round < 3; round++) {
    const results = await Promise.all([
      cpu("/spin?ms=200"),
      ...Array.from({ length: 8 }, (_, i) => cpu(`/wait?ms=${150 + i * 20}`)),
    ]);
    const [spinner, ...waiters] = results;
    assert(
      spinner > alone * 0.5 && spinner < alone * 2,
      `round ${round}: the spinner reports ${spinner} ms, alone it did ${alone}`,
    );
    for (const waiter of waiters)
      assert(
        waiter < alone / 4 && waiter < 60,
        `round ${round}: a waiter was charged ${waiter} ms (the spinner: ${spinner})`,
      );
  }
  // Two spinners at once are each charged their own work, not both.
  const [a, b] = await Promise.all([cpu("/spin?ms=200"), cpu("/spin?ms=200")]);
  assert(
    a > alone * 0.5 && a < alone * 1.6 && b > alone * 0.5 && b < alone * 1.6,
    `two spinners report ${a} and ${b} ms, one alone ${alone}`,
  );
  console.log(`per-request CPU holds under interleaving (a spinner ${alone.toFixed(0)} ms, waiters a few ms)`);

  // Before 2026-11-02 an async handler still reports nothing.
  const oldPort = await build("2026-11-01");
  const old = await fetch(`http://127.0.0.1:${oldPort}/spin?ms=20`);
  await old.text();
  assert.equal(old.headers.get("x-sb-cpu-ms"), null, "an async handler is stamped before 2026-11-02");
  const oldSync = await fetch(`http://127.0.0.1:${oldPort}/sync?ms=20`);
  await oldSync.text();
  assert.equal(
    oldSync.headers.get("x-sb-cpu-ms"),
    null,
    "this handler is async, so it is not stamped before 2026-11-02",
  );
  console.log("before 2026-11-02 an async handler is not stamped");
} finally {
  for (const server of servers) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
