import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRedirects, type RedirectRule } from "../../assets/src/assets";
import { compileNative } from "./native-compile";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";
import { REDIRECT_CASES } from "./fixtures/asset-redirect-cases";

// The `_redirects` matcher the compiled prelude runs (`__sbFindAssetRedirect`, used by env.ASSETS.fetch and the
// embedded transport's assets.get) against the cases the portable matcher in @sproutboat/assets is held to
// (packages/runtime/src/asset-rules.test.js reads the same file): Cloudflare's rules, so a trailing slash is
// significant and `/compare /compare/ 308` is one hop. The handler reaches the prelude's function from inside the
// module, so what runs is the Porffor-compiled code, not Bun's reading of it.
const handler = `export default {
  async fetch(request) {
    const { rules, path } = await request.json();
    return Response.json(__sbFindAssetRedirect(rules, path));
  },
};`;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-asset-redirects-"));
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  const [core, broker] = await Promise.all([readFile(preludePath, "utf8"), readFile(transportPath("broker"), "utf8")]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const generated = join(workdir, "redirects.generated.js");
  const binary = join(workdir, "redirects-native");
  await writeFile(generated, wrapNativeFetchHandler(handler, core.replace(TRANSPORT_MARKER, broker)));
  await rm(binary, { force: true });
  await compileNative({ generated, binary, dir: workdir, cacheRoot: workdir });

  const port = freePort();
  server = Bun.spawn([binary], {
    cwd: workdir,
    env: { ...process.env, PORT: String(port) },
    stdout: "ignore",
    stderr: "inherit",
  });
  const ask = async (rules: RedirectRule[], path: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      body: JSON.stringify({ rules, path }),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, body: await response.json() };
  };
  let ready = false;
  for (let attempt = 0; attempt < 50 && !ready; attempt++) {
    try {
      await ask([], "/");
      ready = true;
    } catch {
      if (server.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  assert(ready, "compiled handler did not start");
  for (const [text, path, want] of REDIRECT_CASES) {
    const answer = await ask(parseRedirects(text), path);
    const label = `${JSON.stringify(text)} ${path}`;
    assert.equal(answer.status, 200, `${label}: status`);
    const got = answer.body === null ? null : [answer.body.status, answer.body.location];
    assert.deepEqual(got, want, label);
  }
  console.log(`Native _redirects matching agrees with Cloudflare on ${REDIRECT_CASES.length} cases`);
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
