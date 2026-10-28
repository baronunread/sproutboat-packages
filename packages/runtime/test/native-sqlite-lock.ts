import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A standalone binary (the embedded transport, built by the CLI) opens its SQLite databases in
// EXCLUSIVE locking mode by default; SB_SQLITE_EXCLUSIVE=0 opts out and =1 is the default. The
// transport on its own, as sproutd and the broker embed it, stays shared unless the variable is
// set: native-d1.ts covers that. Needs SB_CLI, a sproutboat-cli checkout linked to this one.
const handler = `export default {
  async fetch() {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS t (v INTEGER)").run();
    const row = await env.DB.prepare("PRAGMA locking_mode").first();
    return Response.json({ mode: row.locking_mode });
  },
};`;

const cli = process.env.SB_CLI;
if (!cli) {
  console.log("skipped: set SB_CLI to a sproutboat-cli checkout linked to this checkout (it builds the sprout)");
  process.exit(0);
}

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = mkdtempSync(join(tmpdir(), "sb-native-sqlite-lock-"));
const servers: ReturnType<typeof Bun.spawn>[] = [];
try {
  const project = join(workdir, "lock");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src/index.js"), handler);
  writeFileSync(
    join(project, "sproutboat.jsonc"),
    JSON.stringify({ name: "lock", main: "src/index.js", compatibility_date: "2026-10-28", d1_databases: ["DB"] }),
  );
  const built = Bun.spawnSync(["bun", join(cli, "src/main.ts"), "build", "--standalone", "--target", "host"], {
    cwd: project,
    stdout: "inherit",
    stderr: "inherit",
  });
  assert.equal(built.exitCode, 0, "the CLI could not build the sprout");

  const run = async (label: string, setting: string | undefined, expected: string) => {
    const data = join(workdir, `data-${label}`);
    const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "SB_SQLITE_EXCLUSIVE"));
    const env = setting === undefined ? base : { ...base, SB_SQLITE_EXCLUSIVE: setting };
    const port = freePort();
    const server = Bun.spawn([join(project, "dist/lock")], {
      cwd: project,
      env: { ...env, SB_DATA_DIR: data, PORT: String(port) },
      stdout: "ignore",
      stderr: "inherit",
    });
    servers.push(server);
    let response: Response | undefined;
    for (let attempt = 0; attempt < 100 && !response; attempt++) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      } catch {
        if (server.exitCode !== null) break;
        await Bun.sleep(100);
      }
    }
    assert(response, `${label}: the compiled handler did not start`);
    assert.deepEqual(await response.json(), { mode: expected }, label);
    // Another process can open the database while the binary runs only in shared mode.
    let other = "";
    try {
      const db = new Database(join(data, "d1/DB.sqlite"), { readonly: true });
      other = String(db.query("SELECT count(*) AS n FROM t").get()?.n);
      db.close();
    } catch (error) {
      other = String(error);
    }
    if (expected === "exclusive")
      assert.match(other, /locked|busy/i, `${label}: a second opener is locked out (${other})`);
    else assert.equal(other, "0", `${label}: a second opener can read`);
    server.kill(9);
    await server.exited;
  };
  await run("default", undefined, "exclusive");
  await run("one", "1", "exclusive");
  await run("zero", "0", "normal");
  console.log("standalone SQLite: EXCLUSIVE by default, SB_SQLITE_EXCLUSIVE=0 opts out");
} finally {
  for (const server of servers) server.kill(9);
  rmSync(workdir, { recursive: true, force: true });
}
