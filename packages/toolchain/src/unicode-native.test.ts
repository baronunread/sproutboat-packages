import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePorffor } from "./acquire";
import { ensurePorfforPatched } from "./patch";
import { preludePath, TRANSPORT_MARKER, transportPath, wrapNativeFetchHandler } from "../../runtime/src/wrap";

// Bun tests alone cannot expose Porffor's string representations or native
// wire encoding. Compile a real HTTP handler and compare it with Bun vectors.
test("native Unicode JSON and UTF-8 encoding preserve code points and buffer boundaries", async () => {
  const work = await mkdtemp(join(tmpdir(), "sb-unicode-native-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    // Start from the verified pinned checkout, then patch only a private copy.
    // SPROUTBOAT_PORFFOR_DIR can point at an already-isolated dev compiler.
    const compiler = await ensurePorffor();
    const isolated = join(work, "porffor");
    await cp(compiler, isolated, { recursive: true });
    await ensurePorfforPatched(isolated);
    const inputs = ["ASCII", "caffè", "東京", "🚤", "x🚤y", "\ud800", "\udc00", "\ud800x"];
    const source = join(work, "unicode.js");
    const binary = join(work, "unicode-native");
    const code = `export default { fetch() {
      const values = ${JSON.stringify(inputs)};
      const encoded = [];
      const into = [];
      for (const value of values) {
        encoded.push(Array.from(new TextEncoder().encode(value)));
        const rows = [];
        for (let size = 0; size <= 6; size++) {
          const dest = new Uint8Array(size);
          const counts = new TextEncoder().encodeInto(value, dest);
          rows.push({ counts, bytes: Array.from(dest) });
        }
        into.push(rows);
      }
      const nested = JSON.parse('{"東京":{"id":"🚤","plain":"caffè"}}');
      const escaped = JSON.parse('"\\\\ud83d\\\\udea4"');
      const long = "🚤".repeat(4096);
      const growth = JSON.parse(JSON.stringify({ value: long })).value;
      const negatives = [];
      for (const invalid of ['{', '{} trailing', '"\\\\uZZZZ"', '[1,]']) {
        let rejected = false;
        try { JSON.parse(invalid); } catch { rejected = true; }
        negatives.push(rejected);
      }
      const lone = JSON.parse(JSON.stringify({ value: String.fromCharCode(0xd800) }));
      const quotedKey = JSON.parse(JSON.stringify({ ['quote"key']: "🚤" }));
      // The reviver sees each primitive's source text, sliced from UTF-16 input.
      const sources = [];
      JSON.parse('{"東京":{"id":"🚤","n":1.25},"l":[-3e2,"é"]}', (k, v, ctx) => { sources.push([k, ctx.source ?? null]); return v; });
      return Response.json({ encoded, into, nested, escaped, growth, negatives, lone, quotedKey, sources });
    } };`;
    const [prelude, transport] = await Promise.all([
      readFile(preludePath, "utf8"),
      readFile(transportPath("broker"), "utf8"),
    ]);
    await writeFile(source, wrapNativeFetchHandler(code, prelude.replace(TRANSPORT_MARKER, transport)));
    const compile = Bun.spawnSync(["bun", join(isolated, "runtime/index.js"), "native", source, "-o", binary, "-s"], {
      cwd: work,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(compile.exitCode, compile.stderr.toString()).toBe(0);
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = listener.port;
    listener.stop(true);
    child = Bun.spawn([binary], {
      env: { ...process.env, PORT: String(port) },
      stdout: "ignore",
      stderr: "pipe",
    });
    let response: Response | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
        break;
      } catch {}
      if (child.exitCode !== null) break;
      await Bun.sleep(50);
    }
    expect(response).toBeDefined();
    const actual = await response!.json();
    expect(actual.encoded).toEqual(inputs.map((input) => Array.from(new TextEncoder().encode(input))));
    expect(actual.into).toEqual(
      inputs.map((input) =>
        Array.from({ length: 7 }, (_, size) => {
          const bytes = new Uint8Array(size);
          return { counts: new TextEncoder().encodeInto(input, bytes), bytes: Array.from(bytes) };
        }),
      ),
    );
    expect(actual.nested).toEqual({ 東京: { id: "🚤", plain: "caffè" } });
    expect(actual.escaped).toBe("🚤");
    expect(actual.growth).toBe("🚤".repeat(4096));
    expect(actual.lone).toEqual({ value: "\ud800" });
    expect(actual.quotedKey).toEqual({ 'quote"key': "🚤" });
    expect(actual.negatives).toEqual([true, true, true, true]);
    expect(actual.sources).toEqual([
      ["id", '"🚤"'],
      ["n", "1.25"],
      ["東京", null],
      ["0", "-3e2"],
      ["1", '"é"'],
      ["l", null],
      ["", null],
    ]);
  } finally {
    if (child) {
      child.kill(9);
      await child.exited;
    }
    await rm(work, { recursive: true, force: true });
  }
  // An optimised native build of the whole prelude: about 17 s warm, but 50 to 110 s cold
  // (a new patch fingerprint or prelude recompiles everything), which 60 s did not cover.
}, 180_000);
