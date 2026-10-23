import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchNativeBytes } from "./patch";
import {
  NATIVE_BYTES_LAYOUT,
  NATIVE_BYTES_RENDER_ANCHOR,
  NATIVE_BYTES_RENDER_GUARD,
  NATIVE_BYTES_SOURCE,
} from "./native-bytes";

test("native bytes patch is idempotent and refuses changed layout, guard or builtin", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-native-bytes-patch-"));
  try {
    await mkdir(join(root, "compiler/builtins"), { recursive: true });
    const renderer = join(root, "compiler/render.js");
    const layout = join(root, "compiler/builtins/typedarray.js");
    const builtin = join(root, "compiler/builtins/sproutboat-native-bytes.ts");
    await writeFile(renderer, NATIVE_BYTES_RENDER_ANCHOR);
    await writeFile(layout, "changed layout");
    await writeFile(
      join(root, "compiler/builtins/arraybuffer.ts"),
      "// maxByteLength -1 for fixed length, -2 for immutable",
    );
    await expect(patchNativeBytes(root)).rejects.toThrow("layout changed");
    expect(await readFile(renderer, "utf8")).toBe(NATIVE_BYTES_RENDER_ANCHOR);
    await writeFile(layout, NATIVE_BYTES_LAYOUT);
    await patchNativeBytes(root);
    await patchNativeBytes(root);
    expect(await readFile(renderer, "utf8")).toBe(NATIVE_BYTES_RENDER_GUARD + NATIVE_BYTES_RENDER_ANCHOR);
    expect(await readFile(builtin, "utf8")).toBe(NATIVE_BYTES_SOURCE);
    await writeFile(
      renderer,
      (NATIVE_BYTES_RENDER_GUARD + NATIVE_BYTES_RENDER_ANCHOR).replace("!== true", "!== false"),
    );
    await expect(patchNativeBytes(root)).rejects.toThrow("guard changed");
    await writeFile(renderer, NATIVE_BYTES_RENDER_ANCHOR);
    await writeFile(builtin, "modified builtin");
    await expect(patchNativeBytes(root)).rejects.toThrow("unexpected builtin");
    expect(await readFile(renderer, "utf8")).toBe(NATIVE_BYTES_RENDER_ANCHOR);
    await rm(builtin);
    await mkdir(builtin);
    await expect(patchNativeBytes(root)).rejects.toThrow();
    expect(await readFile(renderer, "utf8")).toBe(NATIVE_BYTES_RENDER_ANCHOR);
    await writeFile(renderer, "changed renderer");
    await expect(patchNativeBytes(root)).rejects.toThrow("renderer anchor changed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
