import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const JSON_MARKER = "sb_json_utf16_v1";
const ENCODER_MARKER = "sb_text_encoder_scalar_v1";
function replace(source: string, anchor: string, replacement: string): string {
  if (!source.includes(anchor)) throw new Error(`Porffor Unicode patch anchor missing: ${anchor}`);
  return source.replaceAll(anchor, replacement);
}

// Keep Porffor's parser/serializer, but store UTF-16 code units instead of
// truncating them into byte buffers. Dynamic inputs may be either string form.
export function unicodeJsonSource(source: string): string {
  if (source.includes(JSON_MARKER)) return source;
  const start = source.indexOf("export const __Porffor_bytestring_bufferStr");
  const end = source.indexOf("export const __Porffor_json_canSerialize");
  if (start < 0 || end < start) throw new Error("Porffor JSON buffer helpers not found");
  source =
    source.slice(0, start) +
    `
// ${JSON_MARKER}
export const __Porffor_bytestring_bufferStr = (buffer: i32, str: any): i32 => {
  const len: i32 = str.length;
  if (buffer + 4 + len * 2 > __Porffor_json_bufLimit) return buffer + len * 2;
  for (let i: i32 = 0; i < len; i++) Porffor.IR.storeU16(buffer + i * 2, 4, str.charCodeAt(i));
  return buffer + len * 2;
};
export const __Porffor_bytestring_bufferChar = (buffer: i32, char: i32): i32 => {
  if (buffer + 6 > __Porffor_json_bufLimit) return buffer + 2;
  Porffor.IR.storeU16(buffer, 4, char);
  return buffer + 2;
};
export const __Porffor_bytestring_buffer2Char = (buffer: i32, a: i32, b: i32): i32 => {
  buffer = __Porffor_bytestring_bufferChar(buffer, a);
  return __Porffor_bytestring_bufferChar(buffer, b);
};
export const __Porffor_json_appendChar = (out: string, char: i32): void => {
  const len: i32 = out.length;
  Porffor.IR.storeU16(Porffor.IR.ptr(out) + len * 2, 4, char);
  out.length = len + 1;
};
` +
    source.slice(end);
  source = replace(source, "text: bytestring", "text: any");
  source = replace(source, "(_: bytestring)", "(_: any)");
  source = replace(
    source,
    "const out: bytestring = Porffor.malloc(6 + (strEnd - pos));",
    "const out: string = Porffor.malloc(4 + (strEnd - pos) * 2);",
  );
  source = replace(source, "Porffor.bytestring.appendChar(out,", "__Porffor_json_appendChar(out,");
  source = replace(
    source,
    "Porffor.callThis(__ByteString_prototype_slice, text, start, pos)",
    "text.slice(start, pos)",
  );
  source = replace(
    source,
    "let buffer: bytestring = Porffor.malloc(6 + cap);",
    "let buffer: string = Porffor.malloc(4 + cap);",
  );
  source = replace(
    source,
    "buffer = Porffor.malloc(6 + cap);",
    "buffer = Porffor.malloc(4 + cap);",
  );
  source = replace(
    source,
    "buffer.length = out - (buffer as i32);",
    "buffer.length = (out - (buffer as i32)) / 2;",
  );
  source = replace(source, "(buffer - _buffer) > 1", "(buffer - _buffer) > 2");
  source = replace(source, "Porffor.IR.storeU8(buffer, 3,", "Porffor.IR.storeU16(buffer, 2,");
  source = replace(source, "for (const key: bytestring in", "for (const key: any in");
  // Serialize object keys through the string escaping path too.
  source = replace(
    source,
    `      buffer = __Porffor_bytestring_bufferChar(buffer, 34); // "
      buffer = __Porffor_bytestring_bufferStr(buffer, key);
      buffer = __Porffor_bytestring_bufferChar(buffer, 34); // "`,
    "      buffer = __Porffor_json_serialize(buffer, key, depth, undefined);",
  );
  source = replace(
    source,
    `      // todo: support non-bytestrings
      buffer = __Porffor_bytestring_bufferChar(buffer, c);`,
    `      // Well-formed JSON.stringify escapes lone surrogate code units.
      if ((c >= 0xd800 && c <= 0xdbff && (i + 1 >= len || value.charCodeAt(i + 1) < 0xdc00 || value.charCodeAt(i + 1) > 0xdfff)) ||
          (c >= 0xdc00 && c <= 0xdfff && (i == 0 || value.charCodeAt(i - 1) < 0xd800 || value.charCodeAt(i - 1) > 0xdbff))) {
        buffer = __Porffor_bytestring_buffer2Char(buffer, 92, 117);
        for (let shift: i32 = 12; shift >= 0; shift -= 4) {
          const digit: i32 = (c >> shift) & 15;
          buffer = __Porffor_bytestring_bufferChar(buffer, digit < 10 ? digit + 48 : digit + 87);
        }
        continue;
      }
      buffer = __Porffor_bytestring_bufferChar(buffer, c);`,
  );
  // JSON.parse must reject trailing non-whitespace, not just parse a prefix.
  source = replace(
    source,
    "return __Porffor_json_parseValue(_, posPtr, _.length);",
    `const result: any = __Porffor_json_parseValue(_, posPtr, _.length);
  if (__Porffor_json_skipWhitespace(_, Porffor.IR.loadI32(posPtr, 0), _.length) != _.length) throw new SyntaxError('Unexpected trailing JSON input');
  return result;`,
  );
  return source;
}

const ENCODER = `class TextEncoder {
  // ${ENCODER_MARKER}
  get encoding() { return 'utf-8'; }
  encode(input = '') {
    const text = String(input);
    let length = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { length += 4; i++; }
      else length += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    }
    const out = new Uint8Array(length);
    this.encodeInto(text, out);
    return out;
  }
  encodeInto(source, destination) {
    const text = String(source);
    let read = 0;
    let written = 0;
    while (read < text.length) {
      let cp = text.charCodeAt(read);
      let units = 1;
      if (cp >= 0xd800 && cp <= 0xdbff && read + 1 < text.length && text.charCodeAt(read + 1) >= 0xdc00 && text.charCodeAt(read + 1) <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + text.charCodeAt(read + 1) - 0xdc00;
        units = 2;
      } else if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
      const count = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      if (written + count > destination.length) break;
      if (count === 1) destination[written++] = cp;
      else if (count === 2) {
        destination[written++] = 0xc0 | (cp >> 6);
        destination[written++] = 0x80 | (cp & 0x3f);
      } else if (count === 3) {
        destination[written++] = 0xe0 | (cp >> 12);
        destination[written++] = 0x80 | ((cp >> 6) & 0x3f);
        destination[written++] = 0x80 | (cp & 0x3f);
      } else {
        destination[written++] = 0xf0 | (cp >> 18);
        destination[written++] = 0x80 | ((cp >> 12) & 0x3f);
        destination[written++] = 0x80 | ((cp >> 6) & 0x3f);
        destination[written++] = 0x80 | (cp & 0x3f);
      }
      read += units;
    }
    return { read, written };
  }
}

`;
export function unicodeEncoderSource(source: string): string {
  if (source.includes(ENCODER_MARKER)) return source;
  const start = source.indexOf("class TextEncoder {");
  const end = source.indexOf("class TextDecoder {", start);
  if (start < 0 || end < start) throw new Error("Porffor TextEncoder block not found");
  return source.slice(0, start) + ENCODER + source.slice(end);
}

export function unicodeWireSource(source: string): string {
  const marker = "sb_native_utf8_scalar_v1";
  if (source.includes(marker)) return source;
  const start = source.indexOf("  if (value.type == ${TYPES.string}) {");
  const end = source.indexOf("    utf8[out_len_local]", start);
  if (start < 0 || end < start) throw new Error("Porffor UTF-16 wire encoder not found");
  let block = source.slice(start, end);
  block = replace(
    block,
    "      u16 c = chars[i];",
    `      // ${marker}
      u32 c = chars[i];
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < len && chars[i + 1] >= 0xdc00 && chars[i + 1] <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + chars[++i] - 0xdc00;
      } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;`,
  );
  block = replace(
    block,
    `      } else {
        utf8[out_len_local++] = (char)(0xe0 | (c >> 12));
        utf8[out_len_local++] = (char)(0x80 | ((c >> 6) & 0x3f));
        utf8[out_len_local++] = (char)(0x80 | (c & 0x3f));
      }`,
    `      } else if (c < 0x10000) {
        utf8[out_len_local++] = (char)(0xe0 | (c >> 12));
        utf8[out_len_local++] = (char)(0x80 | ((c >> 6) & 0x3f));
        utf8[out_len_local++] = (char)(0x80 | (c & 0x3f));
      } else {
        utf8[out_len_local++] = (char)(0xf0 | (c >> 18));
        utf8[out_len_local++] = (char)(0x80 | ((c >> 12) & 0x3f));
        utf8[out_len_local++] = (char)(0x80 | ((c >> 6) & 0x3f));
        utf8[out_len_local++] = (char)(0x80 | (c & 0x3f));
      }`,
  );
  return source.slice(0, start) + block + source.slice(end);
}

export async function patchUnicode(root: string): Promise<void> {
  const renderPath = resolve(root, "compiler/render.js");
  await writeFile(renderPath, unicodeWireSource(await readFile(renderPath, "utf8")));
  const jsonPath = resolve(root, "compiler/builtins/json.ts");
  const globalsPath = resolve(root, "runtime/fetch-globals.js");
  const json = unicodeJsonSource(await readFile(jsonPath, "utf8"));
  const globals = unicodeEncoderSource(await readFile(globalsPath, "utf8"));
  await writeFile(jsonPath, json);
  await writeFile(globalsPath, globals);
  // Source edits alone do not change the builtin table used by native builds.
  const digest = createHash("sha256").update(json).digest("hex");
  const stamp = resolve(root, "compiler/.sb-unicode-json");
  let previous = "";
  try {
    previous = await readFile(stamp, "utf8");
  } catch {
    /* first build */
  }
  if (previous === digest) return;
  const precompile = await realpath(resolve(root, "compiler/precompile.js"));
  const child = Bun.spawn(["bun", precompile], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`could not precompile Unicode JSON: ${stderr || stdout}`);
  await writeFile(stamp, digest);
}
