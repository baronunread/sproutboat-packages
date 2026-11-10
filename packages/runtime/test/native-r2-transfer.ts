import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileNative } from "./native-compile";
import { createBroker, listen } from "../../wire/src/broker";
import { EMPTY_BINDINGS, preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

// Direct R2 transfer on the promise-returning binding (compatibility date 2026-10-26 and later): createUploadUrl()
// and createDownloadUrl() exist there as on the legacy binding, return promises, and answer {url, expiresAt}.
const handler = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ping") return new Response("pong");
    const up = env.UPLOADS.createUploadUrl("k", { maxBytes: 10 });
    const upIsPromise = up instanceof Promise;
    const upload = await up;
    await env.UPLOADS.put("k", "hello");
    const down = env.UPLOADS.createDownloadUrl("k");
    const downIsPromise = down instanceof Promise;
    const download = await down;
    return Response.json({
      upIsPromise,
      downIsPromise,
      upload: { url: typeof upload.url, expiresAt: typeof upload.expiresAt },
      download: { url: typeof download.url, expiresAt: typeof download.expiresAt },
    });
  },
};
`;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const port = freePort();
const workdir = await mkdtemp(join(tmpdir(), "sb-native-r2-transfer-"));
const bindings = { ...EMPTY_BINDINGS, r2: ["UPLOADS"] };
const broker = createBroker({
  db: join(workdir, "state.sqlite"),
  token: "native-r2",
  bindings: { ...bindings, resources: {} },
});
const brokerServer = listen(broker, "127.0.0.1", 0);
let server: ReturnType<typeof Bun.spawn> | undefined;
const get = async (path: string) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(20_000) });
  return { status: res.status, text: await res.text() };
};
try {
  const [core, transport] = await Promise.all([
    readFile(preludePath, "utf8"),
    readFile(transportPath("broker"), "utf8"),
  ]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const generated = join(workdir, "r2.generated.js");
  const binary = join(workdir, "r2-native");
  await writeFile(
    generated,
    wrapNativeFetchHandler(handler, core.replace(TRANSPORT_MARKER, transport), {}, bindings, undefined, "2026-10-26"),
  );
  await compileNative({ generated, binary, dir: workdir, cacheRoot: workdir });
  server = Bun.spawn([binary], {
    cwd: workdir,
    env: {
      ...process.env,
      PORT: String(port),
      SB_BROKER_PORT: String(brokerServer.port),
      SB_BROKER_TOKEN: "native-r2",
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  let started = false;
  for (let attempt = 0; attempt < 50 && !started; attempt++) {
    try {
      started = (await get("/ping")).text === "pong";
    } catch {
      if (server.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  assert(started, "compiled R2 handler did not start");
  const answer = await get("/");
  assert.equal(answer.status, 200, answer.text);
  assert.deepEqual(JSON.parse(answer.text), {
    upIsPromise: true,
    downIsPromise: true,
    upload: { url: "string", expiresAt: "string" },
    download: { url: "string", expiresAt: "string" },
  });
  console.log("native R2 direct transfer: ok");
} finally {
  server?.kill();
  brokerServer.stop();
  await rm(workdir, { recursive: true, force: true });
}
