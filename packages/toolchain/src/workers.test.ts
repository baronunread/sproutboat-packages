import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  patchAsyncWaker,
  patchQuietCollection,
  patchRenderJs,
  patchRequestCollectionInterval,
  patchStreamingRequests,
  patchStreamingResponses,
  patchUwebsockets,
  patchWebSockets,
  patchWorkers,
} from "./patch";
import { EXIT_SINGLE_INSTANCE, WORKERS_EDITS, WORKERS_MARKER } from "./workers";

async function snapshot(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else
        files.set(
          path.slice(root.length + 1),
          createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
        );
    }
  };
  await walk(root);
  return files;
}

test("SB_WORKERS edits only the standalone shim; every file sproutd compiles is byte-identical", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "sb-workers-patch-"));
  try {
    execFileSync("tar", [
      "-xzf",
      resolve(import.meta.dir, "../vendor/porffor-0c135ce.tar.gz"),
      "--strip-components=1",
      "-C",
      root,
    ]);
    // The shim edits, in the order ensurePorfforPatched applies them, up to where workers goes.
    await patchUwebsockets(root);
    await patchRenderJs(root);
    await patchStreamingResponses(root);
    await patchQuietCollection(root);
    await patchRequestCollectionInterval(root);
    await patchAsyncWaker(root);
    await patchStreamingRequests(root);
    await patchWebSockets(root);
    const before = await snapshot(root);
    await patchWorkers(root);
    const after = await snapshot(root);

    const changed = [...after.keys()].filter((name) => before.get(name) !== after.get(name));
    expect(changed).toEqual(["compiler/uwebsockets.js"]);
    expect([...before.keys()].sort()).toEqual([...after.keys()].sort());
    // sproutd runs render.js's own server; none of this reaches it.
    expect(after.get("compiler/render.js")).toBe(before.get("compiler/render.js"));

    const shim = await readFile(resolve(root, "compiler/uwebsockets.js"), "utf8");
    expect(shim).toContain(WORKERS_MARKER);
    // SB_WORKERS=1 (and an app that must be one instance) takes the old main() with no fork.
    expect(shim).toContain(
      "int main(void) {\n  const int count = sb_worker_count();\n  if (count <= 1) return sb_worker_main();",
    );
    expect(shim).toContain(
      "static int sb_worker_main(void) {\n  sb_worker_setup();\n  porf_native_fetch_runtime_init();",
    );
    expect(shim).toContain("static void sb_worker_setup(void) {\n  if (sb_worker < 0) return;");
    expect(shim).toContain(`#define SB_EXIT_SINGLE_INSTANCE ${EXIT_SINGLE_INSTANCE}`);
    // The old main()'s body is still there, once.
    expect(shim.split("porf_native_fetch_runtime_init();\n  porf_native_fetch_static_init();").length).toBe(2);
    expect(shim.split("int main(void)").length).toBe(2);

    // Idempotent.
    await patchWorkers(root);
    expect(await readFile(resolve(root, "compiler/uwebsockets.js"), "utf8")).toBe(shim);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every worker edit has an anchor that occurs once, and a missing one fails the patch", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "sb-workers-anchors-"));
  try {
    execFileSync("tar", [
      "-xzf",
      resolve(import.meta.dir, "../vendor/porffor-0c135ce.tar.gz"),
      "--strip-components=1",
      "-C",
      root,
    ]);
    const file = resolve(root, "compiler/uwebsockets.js");
    await writeFile(file, (await readFile(file, "utf8")).replace("struct PendingRequest {", "struct Moved {"));
    await patchWorkers(root).then(
      () => {
        throw new Error("patched an unpatched shim");
      },
      (error: Error) => expect(error.message).toContain("could not patch Porffor's worker processes"),
    );
    expect(WORKERS_EDITS.length).toBeGreaterThan(5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
