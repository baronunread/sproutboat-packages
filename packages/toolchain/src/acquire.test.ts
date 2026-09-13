import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ensurePorffor, PORFFOR_COMMIT_FULL, PorfforToolchainError } from "./index";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{ archive: string; sha256: string }> {
  const root = await mkdtemp(join(tmpdir(), "sb-porffor-fixture-"));
  temporary.push(root);
  const source = join(root, `porffor-${PORFFOR_COMMIT_FULL}`);
  const files = {
    "runtime/index.js": "fixture:runtime/index.js\n",
    "compiler/render.js":
      "void porf_native_fetch_runtime_init(void) {\n  signal(SIGPIPE, SIG_IGN);\n  porf_init(0, NULL);\n}\n" +
      "f64 porf_native_fetch_get_port(void) {\nfixture:compiler/render.js\n" +
      "  if (value.type == ${TYPES.bytestring}) {\n" +
      "    const u32 ptr = (u32)value.val;\n" +
      "    *out_buf = (const char*)(MEM + ptr + 4);\n" +
      "    *out_len = (size_t)*(u32*)(MEM + ptr);\n" +
      "    return 0;\n" +
      "  }\n",
    "compiler/index.js": "          '-xc', '-', '-c',\n          uSocketsArchive,\n          '-lm'\n",
    "compiler/uwebsockets.js":
      "static const size_t REQUEST_BODY_MAX_BYTES = 1024u * 1024u;\n" +
      "static std::string_view lookup_status_line(i32 status) {\n" +
      '  switch (status) {\n    case 302: return "302 Found";\n    default: return {};\n  }\n}\n' +
      "static i32 collect_headers(uWS::HttpRequest* req) {\n" +
      "  i32 header_capacity = 0;\n" +
      "  const i32 header_bytes = 16 + header_capacity * 8;\n" +
      "  i32 slot = 0;\n  for (auto [key, value] : *req) {\n    slot++;\n  }\n" +
      "  *((i32*)(porf_mem + headers_ptr)) = slot;\n\n  return headers_ptr;\n}\n" +
      "static void on_request(uWS::HttpResponse<false>* res, uWS::HttpRequest* req) {\n" +
      "  const i32 headers_ptr = collect_headers(req);\n}\n",
  };
  for (const [file, contents] of Object.entries(files)) {
    const path = join(source, file);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents);
  }
  const archive = join(root, "porffor.tar.gz");
  const tar = Bun.spawn(["tar", "-czf", archive, "-C", root, basename(source)], { stderr: "pipe" });
  const [code, stderr] = await Promise.all([tar.exited, new Response(tar.stderr).text()]);
  if (code !== 0) throw new Error(`could not create fixture: ${stderr}`);
  const sha256 = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  return { archive, sha256 };
}

test("Porffor acquisition is atomic, shared concurrently, and warm-cache offline", async () => {
  const { archive, sha256 } = await fixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-porffor-cache-"));
  temporary.push(cacheRoot);
  let requests = 0;
  const fetcher = async () => {
    requests += 1;
    await Bun.sleep(5);
    return new Response(Bun.file(archive));
  };
  const options = { cacheRoot, url: "fixture", expectedSha256: sha256, fetcher };
  const roots = await Promise.all(Array.from({ length: 8 }, () => ensurePorffor(options)));
  expect(new Set(roots).size).toBe(1);
  expect(requests).toBe(1);
  expect((await readdir(cacheRoot)).filter((name) => name.startsWith(".porffor-"))).toEqual([]);
  const offline = await ensurePorffor({
    ...options,
    fetcher: async () => {
      throw new Error("offline fetch must not run");
    },
  });
  expect(offline).toBe(roots[0]);
});

test("integrity failures stop acquisition and publish no cache entry", async () => {
  const { archive } = await fixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-porffor-integrity-"));
  temporary.push(cacheRoot);
  const error = await ensurePorffor({
    cacheRoot,
    url: "fixture",
    expectedSha256: "0".repeat(64),
    fetcher: async () => new Response(Bun.file(archive)),
  }).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(PorfforToolchainError);
  if (!(error instanceof PorfforToolchainError)) throw error;
  expect(error.kind).toBe("integrity");
  expect((await readdir(cacheRoot)).some((name) => name.startsWith("porffor-"))).toBe(false);
});

test("a corrupted warm cache is replaced from the verified archive", async () => {
  const { archive, sha256 } = await fixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-porffor-corrupt-"));
  temporary.push(cacheRoot);
  let requests = 0;
  const options = {
    cacheRoot,
    url: "fixture",
    expectedSha256: sha256,
    fetcher: async () => {
      requests += 1;
      return new Response(Bun.file(archive));
    },
  };
  const root = await ensurePorffor(options);
  await writeFile(join(root, "compiler/render.js"), "corrupt");
  await ensurePorffor(options);
  expect(requests).toBe(2);
  expect(await readFile(join(root, "compiler/render.js"), "utf8")).toContain('getenv("PORT")');
});

test("an interrupted stale lock is recovered", async () => {
  const { archive, sha256 } = await fixture();
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-porffor-interrupted-"));
  temporary.push(cacheRoot);
  const lock = join(cacheRoot, `porffor-${PORFFOR_COMMIT_FULL}.lock`);
  await mkdir(lock);
  const stale = new Date(Date.now() - 10 * 60_000);
  await utimes(lock, stale, stale);
  const root = await ensurePorffor({
    cacheRoot,
    url: "fixture",
    expectedSha256: sha256,
    fetcher: async () => new Response(Bun.file(archive)),
  });
  expect(await readFile(join(root, "runtime/index.js"), "utf8")).toContain("fixture:");
  expect((await readdir(cacheRoot)).some((name) => name.endsWith(".lock"))).toBe(false);
});

test("download failures are classified without publishing partial state", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "sb-porffor-download-"));
  temporary.push(cacheRoot);
  let attempts = 0;
  const error = await ensurePorffor({
    cacheRoot,
    url: "https://invalid.test/source.tar.gz",
    fetcher: async () => {
      attempts += 1;
      throw new Error("offline");
    },
  }).catch((cause: unknown) => cause);
  if (!(error instanceof PorfforToolchainError)) throw error;
  expect(error.kind).toBe("download");
  expect(attempts).toBe(2);
  expect(await readdir(cacheRoot)).toEqual([]);
});
