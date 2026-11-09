import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileNative } from "./native-compile";
import { EMPTY_BINDINGS, preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";
import { isSafeInteger, isString, jsonObject, parseJsonValue, type JsonObject } from "../../wire/src/json";

// #268 — SB_LOG=json makes a standalone binary write one JSON line per request and one per uncaught
// error to stderr: correlated by id, bounded, with no bodies, headers, query strings or secret values.
// Without it the output is the plain text it always was.
const SECRET = "hunter2-secret-value";
const handler = `export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/boom") throw new Error("upstream rejected token ${SECRET}");
    if (path === "/async-boom") {
      await Promise.resolve();
      throw new TypeError("async failure ${SECRET}");
    }
    if (path === "/unawaited") {
      async function failNow() { throw new Error("background failure"); }
      failNow();
      return new Response("fired");
    }
    if (path === "/wait") {
      ctx.waitUntil(Promise.reject(new Error("waitUntil failure")));
      return new Response("queued");
    }
    if (request.method === "POST") return new Response("echo:" + (await request.text()));
    return new Response("ok");
  }
};`;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

type Run = { get: (path: string, init?: RequestInit) => Promise<Response>; stop: () => Promise<string> };

async function start(binary: string, workdir: string, extra: Record<string, string>): Promise<Run> {
  const port = freePort();
  const server = Bun.spawn([binary], {
    cwd: workdir,
    env: { ...process.env, PORT: String(port), SB_BROKER_TOKEN: "native-test-token", TOKEN: SECRET, ...extra },
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = new Response(server.stderr).text();
  let ready = false;
  for (let attempt = 0; attempt < 50 && !ready; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
      ready = true;
    } catch {
      if (server.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  assert(ready, "compiled handler did not start");
  return {
    get: (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init),
    stop: async () => {
      server.kill(9);
      await server.exited;
      return stderr;
    },
  };
}

function records(log: string): JsonObject[] {
  const found: JsonObject[] = [];
  for (const line of log.split("\n")) {
    // The binary also prints a startup banner of its own; every line that is JSON must be a record.
    if (!line.startsWith("{")) continue;
    const record = jsonObject(parseJsonValue(line));
    assert(record, `a stderr line is not a JSON record: ${line}`);
    found.push(record);
  }
  return found;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-request-log-"));
try {
  const [core, broker] = await Promise.all([readFile(preludePath, "utf8"), readFile(transportPath("broker"), "utf8")]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const generated = join(workdir, "log.generated.js");
  const binary = join(workdir, "log-native");
  await writeFile(
    generated,
    wrapNativeFetchHandler(
      handler,
      core.replace(TRANSPORT_MARKER, broker),
      undefined,
      { ...EMPTY_BINDINGS, secrets: ["TOKEN"] },
      undefined,
      "2026-11-07",
    ),
  );
  await compileNative({ generated, binary, dir: workdir });

  // Off by default: the plain text line, no records.
  const plain = await start(binary, workdir, {});
  assert.equal(await (await plain.get("/ok")).text(), "ok");
  assert.equal((await plain.get("/boom")).status, 500);
  const plainLog = await plain.stop();
  assert(plainLog.includes("Uncaught (in fetch)"), `the default error line changed: ${plainLog}`);
  assert(!plainLog.includes('"type"'), `records were written without SB_LOG=json: ${plainLog}`);

  // On: request and error records.
  const json = await start(binary, workdir, { SB_LOG: "json" });
  assert.equal(
    await (await json.get("/ok?token=abc123&page=2", { headers: { authorization: "Bearer topsecret" } })).text(),
    "ok",
  );
  assert.equal(
    await (
      await json.get("/echo", { method: "POST", headers: { cookie: "sid=cookiesecret" }, body: "body-payload-xyz" })
    ).text(),
    "echo:body-payload-xyz",
  );
  assert.equal((await json.get("/boom")).status, 500);
  assert.equal((await json.get("/async-boom")).status, 500);
  assert.equal(await (await json.get("/unawaited")).text(), "fired");
  assert.equal(await (await json.get("/wait")).text(), "queued");
  await Bun.sleep(300);
  const log = await json.stop();
  for (const leaked of ["abc123", "topsecret", "cookiesecret", "body-payload-xyz", SECRET, "Uncaught"]) {
    assert(!log.includes(leaked), `"${leaked}" reached the log: ${log}`);
  }
  const all = records(log);
  const requests = all.filter((record) => record.type === "request");
  const errors = all.filter((record) => record.type === "error");
  const request = (path: string) => {
    const found = requests.find((record) => record.path === path);
    assert(found, `no request record for ${path}: ${log}`);
    return found;
  };

  const ok = request("/ok");
  assert.equal(ok.v, 1);
  assert.equal(ok.method, "GET");
  assert.equal(ok.status, 200);
  assert.equal(ok.outcome, "ok");
  assert(isString(ok.id) && ok.id.length > 0);
  assert(isSafeInteger(ok.durationMs) && ok.durationMs >= 0);
  assert(isSafeInteger(ok.timestamp) && Math.abs(ok.timestamp - Date.now()) < 60_000);
  assert.deepEqual(
    Object.keys(ok).sort(),
    ["durationMs", "id", "method", "outcome", "path", "status", "timestamp", "type", "v"],
    "a request record carries exactly these fields",
  );
  assert.equal(request("/echo").method, "POST");

  for (const [path, name] of [
    ["/boom", "Error"],
    ["/async-boom", "TypeError"],
  ] as const) {
    const failed = request(path);
    assert.equal(failed.status, 500);
    assert.equal(failed.outcome, "exception");
    const error = errors.find((record) => record.id === failed.id);
    assert(error, `no error record shares the id of ${path}: ${log}`);
    assert.equal(error.source, "fetch");
    assert.equal(error.name, name);
    assert(String(error.message).includes("[redacted]"), `the secret was not redacted: ${error.message}`);
  }
  const background = errors.find((record) => record.source === "promise");
  assert(background, `no record for the unawaited rejection: ${log}`);
  assert.equal(background.id, null);
  const waitUntil = errors.find((record) => record.source === "waitUntil");
  assert(waitUntil, `no record for the waitUntil rejection: ${log}`);
  assert.equal(waitUntil.id, request("/wait").id);

  // Bounded: a burst past 200 lines a second is counted, not written, and the count is reported.
  const flood = await start(binary, workdir, { SB_LOG: "json" });
  const burst = 700;
  for (let sent = 0; sent < burst; sent += 50) {
    await Promise.all(Array.from({ length: 50 }, () => flood.get("/ok")));
  }
  await Bun.sleep(1100);
  await flood.get("/ok");
  await Bun.sleep(200);
  const floodRecords = records(await flood.stop());
  const written = floodRecords.filter((record) => record.type === "request").length;
  const dropped = floodRecords
    .filter((record) => record.type === "dropped")
    .reduce((sum, record) => sum + Number(record.count), 0);
  assert(dropped > 0, "a burst past the rate limit was not reported as dropped");
  assert.equal(written + dropped, burst + 2, "every request is either written or counted as dropped");
  console.log("Native request and error records are structured, correlated, redacted and bounded");
} finally {
  await rm(workdir, { recursive: true, force: true });
}
