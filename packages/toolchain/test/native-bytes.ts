import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensurePorffor } from "../src/acquire";
import { preludePath, TRANSPORT_MARKER, wrapNativeFetchHandler } from "../../runtime/src/wrap";

const work = await mkdtemp(join(tmpdir(), "sb-native-bytes-"));
const porffor = await ensurePorffor();
const node = Bun.which("node");
assert(node, "native compiler test needs Node at build time");
const core = await readFile(preludePath, "utf8");
const embedded = await readFile(new URL("../../runtime/src/transport-embedded.js", import.meta.url), "utf8");
const start = embedded.indexOf("static uint64_t sb_ltx_crc_table");
const end = embedded.indexOf("static uint64_t sb_ltx_page_crc", start);
assert(start > 0 && end > start);
// Test the one actual runtime kernel, not a copied implementation or mock.
const provider =
  "Porffor.c`\n#include <fcntl.h>\n" + embedded.slice(start, end) + "`;\nfunction __sbCall() { return '{}'; }\n";
const wrap = (handler: string, transport = provider) =>
  wrapNativeFetchHandler(handler, core.replace(TRANSPORT_MARKER, transport));
let serial = 0;
async function compile(source: string, flags: string[], native = false, compiler = porffor) {
  const file = join(work, "input.js"),
    output = join(work, "output" + serial++ + (native ? "" : ".c"));
  await writeFile(file, source);
  await rm(output, { force: true });
  const child = Bun.spawn(
    [node!, resolve(compiler, "runtime/index.js"), native ? "native" : "c", file, "-o", output, "-s", "-O0", ...flags],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr, output };
}
let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  const calls = [
    "__Porffor_sproutboat_crc64_v1(new Uint8Array(8),new Uint8Array(0),0,0)",
    "__Porffor_sproutboat_file_ctl_v1(2,'',1,0)",
    "__Porffor_sproutboat_file_io_v1(0,1,new Uint8Array(0),0,0,0)",
    "__Porffor_sproutboat_view_v1(new Uint8Array(0),0,0,false)",
    "__Porffor_sproutboat_fd_v1(0)",
    "__Porffor_sproutboat_position_v1(0,0)",
  ];
  for (const call of calls) {
    const result = await compile(wrap(`export default {fetch(){${call};return new Response('tenant');}};`), []);
    assert.notEqual(result.code, 0, call);
    assert(result.stderr.includes("native bytes v1 is disabled"), result.stderr);
    assert(!(await Bun.file(result.output).exists()), "disabled ABI emitted an output");
  }
  const releaseTenant = await compile(wrap(`export default {fetch(){${calls[1]};return new Response('tenant');}};`), [
    "-O3",
  ]);
  assert.notEqual(releaseTenant.code, 0);
  assert(releaseTenant.stderr.includes("is disabled"));
  const aliasTenant = await compile(
    wrap(
      "const privileged = __Porffor_sproutboat_file_ctl_v1;\nexport default {fetch(){return new Response(String(privileged(2,'',1,0)));}};",
    ),
    [],
  );
  assert.notEqual(aliasTenant.code, 0);
  assert(aliasTenant.stderr.includes("is disabled"));
  const probe = wrap(`export default {fetch(){${calls[0]};return new Response('probe');}};`);
  const falseFlag = await compile(probe, ["--sb-native-bytes-v1=false"]);
  assert.notEqual(falseFlag.code, 0);
  assert(falseFlag.stderr.includes("is disabled"));
  const stale = await compile(
    wrap(
      `export default {fetch(){${calls[0]};return new Response('probe');}};`,
      provider.replaceAll("sb_ltx_crc", "old_crc"),
    ),
    ["--sb-native-bytes-v1"],
  );
  assert.notEqual(stale.code, 0);
  assert(stale.stderr.includes("actual embedded transport"), stale.stderr);
  const plain = wrap("export default {fetch(){return new Response('unchanged');}};");
  const off = await compile(plain, []),
    onUnused = await compile(plain, ["--sb-native-bytes-v1"]);
  assert.equal(off.code, 0, off.stderr);
  assert.equal(onUnused.code, 0, onUnused.stderr);
  for (const name of ["app.c", "server.cpp"])
    assert.deepEqual(
      await readFile(join(off.output, name)),
      await readFile(join(onUnused.output, name)),
      "unused opt-in changes generated C",
    );
  assert(!(await readFile(join(off.output, "app.c"), "utf8")).includes("p_builtins___Porffor_sproutboat_"));
  if (process.env.SB_NATIVE_BYTES_BASELINE_PORFFOR) {
    const baseline = await compile(plain, [], false, process.env.SB_NATIVE_BYTES_BASELINE_PORFFOR);
    assert.equal(baseline.code, 0, baseline.stderr);
    for (const name of ["app.c", "server.cpp"])
      assert.deepEqual(
        await readFile(join(off.output, name)),
        await readFile(join(baseline.output, name)),
        "default C differs from the pre-patch compiler",
      );
    console.log("PASS: default app/server C byte-identical to the pre-patch compiler");
  }
  console.log(
    "PASS: six tenant builtin references rejected; false flag rejected; actual-provider guard; unused option C identical",
  );

  const handler = `
function check(ok) { if (!ok) throw new Error('native bytes check failed'); }
function rejects(f) { try { f(); } catch(e) { return e.name; } return 'accepted'; }
function sum(state) { let out=''; for(let i=0;i<8;i++) out += ((state[i]^255)&255).toString(16).padStart(2,'0'); return out; }
export default {async fetch(request) {
  if (new URL(request.url).pathname === '/crc') {
    const input = new Uint8Array(await request.arrayBuffer());
    const storage = new Uint8Array(input.length+10); storage.set(input,5);
    const data = storage.subarray(3,storage.length-2);
    const states = new Uint8Array(24); states.fill(17);
    const a = states.subarray(4,12), b = states.subarray(14,22); a.fill(255);b.fill(255);
    __Porffor_sproutboat_crc64_v1(a,data,2,input.length);
    for(let at=0;at<input.length;at+=137) __Porffor_sproutboat_crc64_v1(b,data,2+at,Math.min(137,input.length-at));
    const expected=sum(a);check(sum(b)===expected);b.fill(255);
    __Porffor_sproutboat_crc64_v1(b,data,2,input.length);check(sum(b)===expected);
    check(states[3]===17 && states[12]===17 && states[13]===17 && states[22]===17);
    return new Response(expected);
  }
  const path=__sbEnv('SB_BYTES_TEST_FILE');
  const fd=__Porffor_sproutboat_file_ctl_v1(1,path,0,0);check(fd>=0);
  const data=new Uint8Array([99,98,1,2,3,4,5,97,96]).subarray(1,8);
  check(__Porffor_sproutboat_file_io_v1(1,fd,data,1,5,0)===5);
  check(__Porffor_sproutboat_file_ctl_v1(2,'',fd,0)===5);
  const read=new Uint8Array(12);read.fill(88);const view=read.subarray(2,10);
  check(__Porffor_sproutboat_file_io_v1(0,fd,view,1,7,0)===5);
  check(read[2]===88 && read[3]===1 && read[7]===5 && read[8]===88 && read[10]===88);
  check(__Porffor_sproutboat_file_io_v1(0,fd,view,8,0,0)===0);
  const state=new Uint8Array(8);
  let coerced=0; const operationObject={valueOf(){coerced++;return 0;}};
  check(rejects(()=>__Porffor_sproutboat_file_io_v1(operationObject,fd,data,0,1,0))==='RangeError');
  check(coerced===0);
  check(rejects(()=>__Porffor_sproutboat_file_ctl_v1(0,'x'.repeat(4096),0,0))==='RangeError');
  const detachedBuffer=new ArrayBuffer(8), detached=new Uint8Array(detachedBuffer); detachedBuffer.transfer();
  const immutable=new Uint8Array(new ArrayBuffer(8).transferToImmutable());
  const errors=[
    rejects(()=>__Porffor_sproutboat_crc64_v1(state,new Int8Array(8),0,1)),
    rejects(()=>__Porffor_sproutboat_crc64_v1(state,new Uint8Array(3),-1,1)),
    rejects(()=>__Porffor_sproutboat_crc64_v1(state,new Uint8Array(3),0,4)),
    rejects(()=>__Porffor_sproutboat_crc64_v1(state,new Uint8Array(3),0.5,1)),
    rejects(()=>__Porffor_sproutboat_crc64_v1(new Uint8Array(7),data,0,1)),
    rejects(()=>__Porffor_sproutboat_crc64_v1(state,new Uint8Array(new ArrayBuffer(8,{maxByteLength:16})),0,1)),
    rejects(()=>__Porffor_sproutboat_crc64_v1(state,new Uint8Array(new SharedArrayBuffer(8)),0,1)),
    rejects(()=>__Porffor_sproutboat_file_io_v1(0,-1,data,0,1,0)),
    rejects(()=>__Porffor_sproutboat_file_io_v1(0,fd,data,0,1,Infinity)),
    rejects(()=>__Porffor_sproutboat_file_io_v1(0,fd,new Uint8Array(131073),0,131073,0)),
    rejects(()=>__Porffor_sproutboat_file_ctl_v1(2.5,'',fd,0)),
    rejects(()=>__Porffor_sproutboat_file_ctl_v1(5,'',fd,0.5)),
    rejects(()=>__Porffor_sproutboat_crc64_v1(state,detached,0,1)),
    rejects(()=>__Porffor_sproutboat_crc64_v1(state,immutable,0,1))
  ];
  check(__Porffor_sproutboat_file_ctl_v1(4,'',fd,0)===0);
  check(__Porffor_sproutboat_file_ctl_v1(5,'',fd,2)===0);
  check(__Porffor_sproutboat_file_ctl_v1(2,'',fd,0)===2);
  check(__Porffor_sproutboat_file_ctl_v1(3,'',fd,0)===0);
  check(__Porffor_sproutboat_file_io_v1(0,fd,data,0,1,0)<0);
  check(__Porffor_sproutboat_file_ctl_v1(0,path+'-missing',0,0)<0);
  check(__Porffor_sproutboat_file_ctl_v1(0,'bad\\0path',0,0)<0);
  check(__Porffor_sproutboat_file_ctl_v1(0,path+'-link',0,0)<0);
  return Response.json(errors);
}};`;
  const built = await compile(wrap(handler), ["--sb-native-bytes-v1"], true);
  assert.equal(built.code, 0, built.stderr + built.stdout);
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  await symlink(join(work, "bytes.bin"), join(work, "bytes.bin-link"));
  server = Bun.spawn([built.output], {
    env: { ...process.env, PATH: "/nonexistent", PORT: String(port), SB_BYTES_TEST_FILE: join(work, "bytes.bin") },
    stdout: "ignore",
    stderr: "pipe",
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    if (server.exitCode !== null) break;
    await Bun.sleep(50);
  }
  assert(ready, "native bytes server failed");
  const response = await fetch(`http://127.0.0.1:${port}/io`);
  const errors = await response.json();
  assert.deepEqual(errors, [
    "TypeError",
    "RangeError",
    "RangeError",
    "RangeError",
    "RangeError",
    "TypeError",
    "TypeError",
    "RangeError",
    "RangeError",
    "RangeError",
    "RangeError",
    "RangeError",
    "TypeError",
    "TypeError",
  ]);
  const table: bigint[] = [];
  for (let i = 0; i < 256; i++) {
    let c = BigInt(i);
    for (let j = 0; j < 8; j++) c = (c >> 1n) ^ (c & 1n ? 0xd800000000000000n : 0n);
    table.push(c);
  }
  let seed = 0x1337;
  const next = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  for (let i = 0; i < 300; i++) {
    const data = new Uint8Array(i < 10 ? [0, 1, 7, 8, 255, 256, 512, 4096, 65536, 1048576][i] : next() % 8192);
    for (let at = 0; at < data.length; at++) data[at] = next() & 255;
    let crc = 0xffffffffffffffffn;
    for (const byte of data) crc = table[Number((crc ^ BigInt(byte)) & 255n)] ^ (crc >> 8n);
    const reply = await fetch(`http://127.0.0.1:${port}/crc`, { method: "POST", body: data });
    assert.equal(await reply.text(), (crc ^ 0xffffffffffffffffn).toString(16).padStart(16, "0"), "CRC input " + i);
  }
  console.log(
    "PASS: native file operations, 14 rejected inputs, 300 independent CRC vectors; views/reset/two hashers; GC on, runtime PATH excludes Node/Bun",
  );
} catch (error) {
  console.error("failure artifacts:", work);
  throw error;
} finally {
  if (server) {
    server.kill("SIGKILL");
    await server.exited;
  }
}
await rm(work, { recursive: true, force: true });
