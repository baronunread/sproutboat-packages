import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ensurePorfforPatched } from "./patch";

test("a response's strings are read in place by the patched shim", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "sb-response-write-"));
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
    const start = shim.indexOf("static void write_response_value(");
    const end = shim.indexOf("\n}\n", start);
    const body = shim.slice(start, end);
    expect(body).not.toContain("porf_native_fetch_read_value(");
    expect(body.split("sb_read_value_fast(").length - 1).toBeGreaterThanOrEqual(5);
    // The helper falls back to the copying read for anything but a plain ASCII bytestring.
    const helper = shim.slice(shim.indexOf("static inline int sb_read_value_fast("), start);
    expect(helper).toContain("value.type == 195");
    expect(helper).toContain("0x8080808080808080ULL");
    expect(helper).toContain("return porf_native_fetch_read_value(value, out_buf, out_len, out_owned);");
    expect(shim).toContain("// sproutboat: a response's ASCII strings are written in place");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
