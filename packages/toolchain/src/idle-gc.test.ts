import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { patchQuietCollection, patchRequestCollectionInterval } from "./patch";

test("idle reclamation preserves unconditional request GC and is idempotent on the pinned compiler", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "sb-quiet-gc-"));
  try {
    execFileSync("tar", [
      "-xzf",
      resolve(import.meta.dir, "../vendor/porffor-0c135ce.tar.gz"),
      "--strip-components=1",
      "-C",
      root,
    ]);
    await patchQuietCollection(root);
    const render = await readFile(resolve(root, "compiler/render.js"), "utf8");
    const shim = await readFile(resolve(root, "compiler/uwebsockets.js"), "utf8");
    const start = shim.indexOf("static void collect_after_request(void) {");
    const end = shim.indexOf("\n}\n", start);
    const body = shim.slice(start, end);
    const normal = body.indexOf("porf_native_fetch_collect_normal_from((void*)&porf_stack_anchor);");
    const guard = body.indexOf("if (porf_native_fetch_needs_quiet_collect()) {");
    expect(normal).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(normal);
    expect(body.slice(0, guard)).not.toContain("return;");
    expect(render).toContain("porf_gc_mark_queue_len == 0 && porf_gc_mark_queue_cap > 4096");
    await patchQuietCollection(root);
    expect(await readFile(resolve(root, "compiler/render.js"), "utf8")).toBe(render);
    expect(await readFile(resolve(root, "compiler/uwebsockets.js"), "utf8")).toBe(shim);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the standalone shim collects every N requests and when idle; render.js is untouched", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "sb-request-gc-"));
  try {
    execFileSync("tar", [
      "-xzf",
      resolve(import.meta.dir, "../vendor/porffor-0c135ce.tar.gz"),
      "--strip-components=1",
      "-C",
      root,
    ]);
    await patchQuietCollection(root);
    const render = await readFile(resolve(root, "compiler/render.js"), "utf8");
    await patchRequestCollectionInterval(root);
    // sproutd's collector lives in render.js: the interval patch must not touch it.
    expect(await readFile(resolve(root, "compiler/render.js"), "utf8")).toBe(render);
    const shim = await readFile(resolve(root, "compiler/uwebsockets.js"), "utf8");
    const wrapper = shim.slice(
      shim.indexOf("static void collect_after_request(void) {"),
      shim.indexOf(
        "static void collect_after_request_now(void) {\n",
        shim.indexOf("static void collect_after_request(void) {"),
      ),
    );
    expect(wrapper).toContain("++sb_gc_since < sb_gc_every()");
    expect(shim).toContain('getenv("SB_GC_EVERY")');
    // The old body is still there, reached every N requests and from the idle timer.
    const now = shim.slice(shim.indexOf("static void collect_after_request_now(void) {\n  sb_gc_since = 0;"));
    expect(now.indexOf("porf_native_fetch_collect_normal_from((void*)&porf_stack_anchor);")).toBeGreaterThan(-1);
    expect(now.indexOf("porf_native_fetch_needs_quiet_collect()")).toBeGreaterThan(-1);
    expect(shim).toContain("collect_after_request_now();\n}\nstatic void collect_after_request(void)");
    await patchRequestCollectionInterval(root);
    expect(await readFile(resolve(root, "compiler/uwebsockets.js"), "utf8")).toBe(shim);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
