import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// AsyncLocalStorage (design 02, milestone 2): the store follows the control flow across
// awaits, promise reactions, timers, intervals, microtasks and ctx.waitUntil, and many
// requests interleaved in one process each see only their own. The expected values are what
// workerd (nodejs_compat) answers for test/fixtures/als-app.js.
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

const workdir = mkdtempSync(join(tmpdir(), "sb-native-als-"));
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  const project = join(workdir, "app");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src/index.js"), readFileSync(new URL("./fixtures/als-app.js", import.meta.url)));
  writeFileSync(
    join(project, "sproutboat.jsonc"),
    JSON.stringify({ name: "als", main: "src/index.js", compatibility_date: process.env.SB_COMPAT ?? "2026-11-01" }),
  );
  const built = Bun.spawnSync(["bun", join(cli, "src/main.ts"), "build", "--standalone", "--target", "host"], {
    cwd: project,
    stdout: "inherit",
    stderr: "inherit",
  });
  assert.equal(built.exitCode, 0, "the CLI could not build the sprout");
  const port = freePort();
  server = Bun.spawn([join(project, "dist/als")], {
    cwd: project,
    env: { ...process.env, PORT: String(port), SB_DATA_DIR: join(project, "data") },
    stdout: "ignore",
    stderr: "inherit",
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100 && !ready; attempt++) {
    try {
      await fetch(`${base}/none`, { signal: AbortSignal.timeout(500) });
      ready = true;
    } catch {
      if (server.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  assert(ready, "the standalone app did not start");
  const get = async (path: string) => (await fetch(`${base}${path}`)).json();

  assert.deepEqual(await get("/basic"), [
    null,
    "a",
    "b",
    null,
    ["a", "x"],
    null,
    ["threw", "boom", null],
    ["args", 1, 2],
    7,
  ]);
  const steps = (id: string) => [id, id, id, id, id, id, id, `q${id}`, `i${id}`, `i${id}`, `c${id}`, `s${id}`];
  assert.deepEqual(await get("/await?id=one&d=2"), steps("one"));
  assert.deepEqual(await get("/bind"), ["captured", "captured", "snap", null, "captured"]);
  assert.deepEqual(await get("/nested-async?d=2"), ["outer", "inner", "outer", "outer"]);
  assert.deepEqual(await get("/leak?d=2"), [null, null]);
  await (await fetch(`${base}/wu?id=wu1&d=20`)).text();
  await Bun.sleep(100);
  assert.equal(await (await fetch(`${base}/wu-read`)).text(), "wu1");
  console.log(
    "run, exit and snapshot behave as workerd's; the store follows awaits, timers, intervals, microtasks and waitUntil",
  );

  // Many requests at once, each with its own store and its own delays.
  const ids = Array.from({ length: 60 }, (_, i) => `req${i}`);
  const answers = await Promise.all(ids.map((id, i) => get(`/await?id=${id}&d=${1 + (i % 7)}`)));
  ids.forEach((id, i) => assert.deepEqual(answers[i], steps(id), `request ${id} saw another request's store`));
  const nested = await Promise.all(ids.map((id, i) => get(`/nested-async?id=${id}&d=${1 + (i % 5)}`)));
  nested.forEach((answer) => assert.deepEqual(answer, ["outer", "inner", "outer", "outer"]));
  assert.equal(server.exitCode, null, "the server exited");
  console.log("60 interleaved requests each saw only their own store at every await");
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  rmSync(workdir, { recursive: true, force: true });
}
