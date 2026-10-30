import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ensurePorfforPatched, patchGracefulRestart } from "./patch";

test("the shim drains, offers uSockets an inherited listening socket and stays out of render.js", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "sb-restart-"));
  try {
    execFileSync("tar", [
      "-xzf",
      resolve(import.meta.dir, "../vendor/porffor-0c135ce.tar.gz"),
      "--strip-components=1",
      "-C",
      root,
    ]);
    await ensurePorfforPatched(root);
    const shim = await readFile(resolve(root, "compiler/uwebsockets.js"), "utf8");
    const render = await readFile(resolve(root, "compiler/render.js"), "utf8");
    expect(shim).toContain('extern "C" int sb_inherited_listen_fd(const char* host, int port)');
    expect(shim).toContain("sb_rs_listening(token);");
    expect(shim).toContain('if (sb_rs_closing) res->writeHeader("Connection", "close");');
    // The flag is declared before write_response_value reads it.
    expect(shim.indexOf("static volatile sig_atomic_t sb_rs_closing")).toBeLessThan(
      shim.indexOf("static void write_response_value("),
    );
    // A binary without the embedded transport (no sb_standalone_app_name) does nothing new.
    expect(shim).toContain("static bool sb_rs_on(void) { return sb_standalone_app_name != nullptr; }");
    // sproutd's code (render.js) is untouched.
    expect(render).not.toContain("sb_rs_");
    const index = await readFile(resolve(root, "compiler/index.js"), "utf8");
    expect(index).toContain("(process.env.SB_MUSL_TARGET || 'x86_64-linux-musl')");
    expect(shim).toContain("process.env.SB_UWS_VARIANT");
    const again = shim;
    await patchGracefulRestart(root);
    expect(await readFile(resolve(root, "compiler/uwebsockets.js"), "utf8")).toBe(again);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
