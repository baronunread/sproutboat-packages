import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drive, startUpstream } from "./concurrent-driver";

// Concurrent requests in one process (design 02, milestone 1). A standalone binary serves many
// requests at once: they interleave on timers, request and response body streams, KV, D1 and
// in-worker WebSockets, and each reply must hold only its own request's values (headers, body,
// cookie, env, ctx, cf, errors, ctx.waitUntil results). The same app and driver run against a
// sproutd worker (test/concurrency-smoke.py, which serves up to 8 requests per process).
const cli = process.env.SB_CLI;
if (!cli) {
  console.log("skipped: set SB_CLI to a sproutboat-cli checkout linked to this checkout (it builds the sprouts)");
  process.exit(0);
}

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = mkdtempSync(join(tmpdir(), "sb-native-concurrent-"));
const upstream = startUpstream();
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  const project = join(workdir, "app");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src/index.js"), readFileSync(new URL("./fixtures/concurrent-app.js", import.meta.url)));
  writeFileSync(
    join(project, "sproutboat.jsonc"),
    JSON.stringify({
      name: "conc",
      main: "src/index.js",
      compatibility_date: process.env.SB_COMPAT ?? "2026-11-01",
      vars: { GREETING: "hi" },
      kv_namespaces: ["KV"],
      d1_databases: ["DB"],
    }),
  );
  const built = Bun.spawnSync(["bun", join(cli, "src/main.ts"), "build", "--standalone", "--target", "host"], {
    cwd: project,
    stdout: "inherit",
    stderr: "inherit",
  });
  assert.equal(built.exitCode, 0, "the CLI could not build the sprout");
  const port = freePort();
  server = Bun.spawn([join(project, "dist/conc")], {
    cwd: project,
    env: { ...process.env, PORT: String(port), SB_EGRESS_ALLOW: "127.0.0.1", SB_DATA_DIR: join(project, "data") },
    stdout: "ignore",
    stderr: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100 && !ready; attempt++) {
    try {
      await fetch(`${base}/ping`, { signal: AbortSignal.timeout(500) });
      ready = true;
    } catch {
      if (server.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  assert(ready, "the standalone app did not start");

  const { requests, failures } = await drive({
    base,
    upstream: `http://127.0.0.1:${upstream.port}`,
    requests: Number(process.env.SB_CONC_REQUESTS ?? 40),
    rounds: Number(process.env.SB_CONC_ROUNDS ?? 5),
    clientSockets: false,
    store: true,
  });
  assert.equal(failures.length, 0, `cross-request leaks or failures:\n${failures.slice(0, 20).join("\n")}`);
  assert.equal(server.exitCode, null, "the server exited");
  console.log(`Standalone: ${requests} interleaved requests, no value crossed between them`);
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  upstream.stop(true);
  rmSync(workdir, { recursive: true, force: true });
}
