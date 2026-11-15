import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { standaloneWebClasses } from "../standalone";
import { standaloneShimSource } from "../standalone-build";
import manifest from "./sources.json";
import { applyFileHunks, parseUnifiedPatch } from "./unified-patch";
import {
  PROVENANCE_END,
  UWS_COMMIT,
  UWS_PATCHES,
  applyUwsPatches,
  stripProvenance,
  uwsShimSource,
  webClassesSource,
} from "./index";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("vendored standalone server sources", () => {
  test("the shim and the web classes are the content sources.json records", () => {
    expect(sha(uwsShimSource())).toBe(manifest.files["uws-shim.cpp"].contentSha256);
    expect(sha(webClassesSource())).toBe(manifest.files["web-classes.js"].contentSha256);
  });

  test("the shim rewritten for the flat bridge is what the alpha 19 chain produced", () => {
    // origin.composedShimA22Sha256 was recorded from the chain's output (standaloneShimSource(alpha19Root))
    // when the shim was vendored; the vendored source through the same rewrite must give the same bytes.
    expect(sha(standaloneShimSource())).toBe(manifest.origin.composedShimA22Sha256);
  });

  test("the web classes are the eight classes the prelude expects", () => {
    expect(standaloneWebClasses()).toBe(webClassesSource());
  });

  test("every vendored text file carries a provenance header that ends at the marker", async () => {
    for (const name of ["uws-shim.cpp", "web-classes.js"]) {
      const text = await readFile(join(import.meta.dir, name), "utf8");
      const head = text.slice(0, text.indexOf(PROVENANCE_END));
      expect(head.startsWith("// Vendored source:")).toBe(true);
      expect(head).toContain("Why it is here");
      expect(head).toContain("Equivalence");
      expect(stripProvenance(text, name)).not.toContain("Vendored source:");
    }
    expect(() => stripProvenance("// none\n", "x")).toThrow("no provenance header end marker");
  });

  test("the patches match sources.json and pin the uWebSockets commit", async () => {
    expect(UWS_COMMIT).toBe(manifest.uWebSockets.commit);
    expect(UWS_PATCHES.map((p) => `uws-patches/${p.name}`)).toEqual(manifest.uWebSockets.patches.map((p) => p.file));
    for (const [i, p] of UWS_PATCHES.entries()) expect(sha(p.text)).toBe(manifest.uWebSockets.patches[i]!.sha256);
  });

  test("nothing in the vendored sources reads an alpha 19 tree", async () => {
    for (const name of ["index.ts", "unified-patch.ts"]) {
      const text = await readFile(join(import.meta.dir, name), "utf8");
      expect(text).not.toContain("compiler/uwebsockets.js");
      expect(text).not.toContain("ensurePorffor(");
    }
  });
});

describe("unified patch applier", () => {
  // A fixture file for a patch: every hunk's old lines, separated by filler, so each hunk's context exists exactly once.
  const fixtureFor = (patch: string) => {
    const files = parseUnifiedPatch(patch);
    expect(files.length).toBeGreaterThan(0);
    return files.map((f) => ({
      file: f,
      text: f.hunks.map((h, i) => [`// filler ${i}`, ...h.oldLines].join("\n")).join("\n") + "\n// end\n",
    }));
  };

  for (const { name, text } of UWS_PATCHES) {
    test(`${name} applies once, is a no-op the second time, and rejects drifted text`, () => {
      for (const { file, text: source } of fixtureFor(text)) {
        const patched = applyFileHunks(source, file);
        expect(patched).not.toBeNull();
        expect(patched).not.toBe(source);
        for (const hunk of file.hunks) expect(patched).toContain(hunk.newLines.join("\n"));
        expect(applyFileHunks(patched!, file)).toBeNull();
        const drifted = source.replace(
          file.hunks[0]!.oldLines.find((l) => l.trim().length > 8)!,
          "// drifted",
        );
        expect(() => applyFileHunks(drifted, file)).toThrow("matches neither");
      }
    });
  }

  test("the HTTP/1.0 patch is the edit the old chain made (anchors, markers)", () => {
    const http10 = UWS_PATCHES.find((p) => p.name === "0003-http10.patch")!.text;
    expect(http10).toContain("sb_http10_request");
    expect(http10).toContain("req->ancientHttp = sb_http10_request;");
    expect(http10).toContain('memcmp(" HTTP/1.0\\r\\n"');
  });

  test("applyUwsPatches patches a checkout laid out as uWebSockets, idempotently", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sb-uws-test-"));
    try {
      const files = new Map<string, string>();
      for (const { text } of UWS_PATCHES)
        for (const f of parseUnifiedPatch(text)) {
          const prior = files.get(f.path) ?? "";
          files.set(
            f.path,
            prior + f.hunks.map((h, i) => [`// filler ${i}`, ...h.oldLines].join("\n")).join("\n") + "\n",
          );
        }
      for (const [path, text] of files) {
        await mkdir(join(dir, path, ".."), { recursive: true });
        await writeFile(join(dir, path), text);
      }
      expect(await applyUwsPatches(dir)).toBe(true);
      const once = await Promise.all([...files.keys()].map((p) => readFile(join(dir, p), "utf8")));
      expect(await applyUwsPatches(dir)).toBe(false);
      const twice = await Promise.all([...files.keys()].map((p) => readFile(join(dir, p), "utf8")));
      expect(twice).toEqual(once);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
