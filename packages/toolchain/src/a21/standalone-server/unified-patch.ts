/**
 * A small unified-diff applier for the vendored uWebSockets patches (`uws-patches/`): exact context,
 * no fuzz, no git or `patch` binary (the CLI applies them on machines that have neither). A hunk whose
 * result is already in the file counts as applied, so applying twice is a no-op; a hunk that matches
 * neither way throws, loudly, naming the file.
 */

export type FilePatch = { path: string; hunks: { oldLines: string[]; newLines: string[] }[] };

/** Parse a unified diff (git or plain `---`/`+++` headers) into per-file hunks. */
export function parseUnifiedPatch(patch: string): FilePatch[] {
  const files: FilePatch[] = [];
  let file: FilePatch | undefined;
  let hunk: FilePatch["hunks"][number] | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of patch.split("\n")) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const tag = line[0];
      const text = line.slice(1);
      if (tag === " " || (tag === undefined && line === "")) {
        hunk.oldLines.push(text);
        hunk.newLines.push(text);
        oldLeft--;
        newLeft--;
      } else if (tag === "-") {
        hunk.oldLines.push(text);
        oldLeft--;
      } else if (tag === "+") {
        hunk.newLines.push(text);
        newLeft--;
      } else if (tag === "\\") continue;
      else throw new Error(`unified patch: unexpected line inside a hunk: ${line}`);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const name = line.slice(4).split("\t")[0]!;
      file = { path: name.replace(/^b\//, ""), hunks: [] };
      files.push(file);
    } else if (line.startsWith("@@")) {
      const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (!m || !file) throw new Error(`unified patch: bad hunk header: ${line}`);
      oldLeft = m[1] === undefined ? 1 : Number(m[1]);
      newLeft = m[2] === undefined ? 1 : Number(m[2]);
      hunk = { oldLines: [], newLines: [] };
      file.hunks.push(hunk);
    }
  }
  if (oldLeft > 0 || newLeft > 0) throw new Error("unified patch: truncated hunk");
  return files;
}

function indexOfBlock(lines: string[], block: string[], from: number): number {
  if (block.length === 0) return from;
  outer: for (let i = from; i + block.length <= lines.length; i++) {
    for (let j = 0; j < block.length; j++) if (lines[i + j] !== block[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * Apply one file's hunks to its text. Returns the new text, or null when every hunk is already
 * applied (the text is returned unchanged by the caller). Throws when a hunk fits neither state.
 */
export function applyFileHunks(source: string, file: FilePatch): string | null {
  const lines = source.split("\n");
  let cursor = 0;
  let applied = 0;
  for (const hunk of file.hunks) {
    const at = indexOfBlock(lines, hunk.oldLines, cursor);
    if (at >= 0) {
      lines.splice(at, hunk.oldLines.length, ...hunk.newLines);
      cursor = at + hunk.newLines.length;
      continue;
    }
    if (indexOfBlock(lines, hunk.newLines, 0) >= 0) {
      applied++;
      continue;
    }
    throw new Error(`${file.path}: a hunk matches neither the original nor the patched text`);
  }
  return applied === file.hunks.length ? null : lines.join("\n");
}
