import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../../toolchain/src/acquire";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../src/wrap";

const expected = { chunks: ["a", "b"], transformed: ["X", "Y"], first: { value: "hello", done: false },
  done: true, locked: false, lockError: true, cancelReason: "stop", error: "broken",
  tee: [[1, 2], [1, 2]], pulled: [3, 4], pending: "later", bytes: [7, 8], byob: [9, 10] };
const handler = `export default { async fetch(request) {
  if (new URL(request.url).pathname === "/null") return new Response(null);
  const stream = new ReadableStream({start(c){c.enqueue("hello");c.close();}});
  const reader = stream.getReader(); let lockError = false;
  try { stream.getReader(); } catch { lockError = true; }
  const first = await reader.read(); const done = (await reader.read()).done;
  reader.releaseLock();
  const chunks = []; await ReadableStream.from(["a", "b"]).pipeTo(new WritableStream({write(x){chunks.push(x);}}));
  const transformed = [];
  await ReadableStream.from(["x", "y"]).pipeThrough(new TransformStream({transform(x,c){c.enqueue(x.toUpperCase());}}))
    .pipeTo(new WritableStream({write(x){transformed.push(x);}}));
  let cancelReason; await new ReadableStream({cancel(reason){cancelReason=reason;}}).cancel("stop");
  let error; const broken = new ReadableStream({start(c){c.error(new Error("broken"));}}).getReader();
  try { await broken.read(); } catch(e) { error=e.message; }
  const branches=ReadableStream.from([1,2]).tee(); const tee=[[],[]];
  await Promise.all(branches.map((branch,i)=>branch.pipeTo(new WritableStream({write(x){tee[i].push(x);}}))));
  let value=3; const pulled=[];
  await new ReadableStream({pull(c){if(value===5)c.close();else c.enqueue(value++);}})
    .pipeTo(new WritableStream({write(x){pulled.push(x);}}));
  let controller; const pendingReader=new ReadableStream({start(c){controller=c;}}).getReader();
  const read=pendingReader.read(); controller.enqueue("later");controller.close();const pending=(await read).value;
  const byteReader=new ReadableStream({type:"bytes",start(c){c.enqueue(new Uint8Array([7,8]));c.close();}}).getReader();
  const bytes=Array.from((await byteReader.read()).value);
  const byobReader=new ReadableStream({type:"bytes",start(c){c.enqueue(new Uint8Array([9,10]));c.close();}}).getReader({mode:"byob"});
  const byob=Array.from((await byobReader.read(new Uint8Array(2))).value);
  return Response.json({bytes,byob,chunks, transformed, first, done, locked:stream.locked,lockError,cancelReason,error,tee,pulled,pending});
} };`;

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

const workdir = await mkdtemp(join(tmpdir(), "sb-native-streams-"));
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  const porffor = await ensurePorffor();
  const node = Bun.which("node");
  if (!node) throw new Error("native streams test needs node on PATH");

  const [core, broker] = await Promise.all([
    readFile(preludePath, "utf8"),
    readFile(transportPath("broker"), "utf8"),
  ]);
  assert(core.includes(TRANSPORT_MARKER), "runtime prelude is missing its transport marker");
  const prelude = core.replace(TRANSPORT_MARKER, broker);
  const generated = join(workdir, "streams.generated.js");
  const binary = join(workdir, "streams-native");
  await writeFile(generated, wrapNativeFetchHandler(handler, prelude));
  await rm(binary, { force: true });

  const compile = Bun.spawn([node, resolve(porffor, "runtime/index.js"), "native", generated, "-o", binary, "-s", "-O0"], {
    cwd: workdir,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    compile.exited,
    new Response(compile.stdout).text(),
    new Response(compile.stderr).text(),
  ]);
  assert.equal(exitCode, 0, `Porffor native compile failed:\n${stderr}\n${stdout}`);

  const port = freePort();
  server = Bun.spawn([binary], {
    cwd: workdir,
    env: { ...process.env, PORT: String(port) },
    stdout: "ignore",
    stderr: "inherit",
  });
  let response: Response | undefined;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
      break;
    } catch {
      if (server.exitCode !== null) break;
      await Bun.sleep(100);
    }
  }
  assert(response, "compiled streams handler did not start");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  const empty = await fetch(`http://127.0.0.1:${port}/null`);
  assert.equal(empty.status, 200);
  assert.equal(await empty.text(), "");
  console.log("Native Web Streams pass reads, locks, cancellation, errors, piping, transforms, tee and pulls");
} finally {
  if (server) {
    server.kill(9);
    await server.exited;
  }
  await rm(workdir, { recursive: true, force: true });
}
