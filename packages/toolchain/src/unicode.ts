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
  // Every parser helper and JSON.parse's own `const text` (Alpha 19 types the argument any).
  source = replace(source, "text: bytestring", "text: any");
  source = replace(
    source,
    "const out: bytestring = Porffor.malloc(6 + (strEnd - pos));",
    "const out: string = Porffor.malloc(4 + (strEnd - pos) * 2);",
  );
  source = replace(source, "Porffor.bytestring.appendChar(out,", "__Porffor_json_appendChar(out,");
  // Number literals and, since Alpha 19, the reviver's source text records.
  source = replace(source, "Porffor.callThis(__ByteString_prototype_slice, text, start, ", "text.slice(start, ");
  source = replace(
    source,
    "let buffer: bytestring = Porffor.malloc(6 + cap);",
    "let buffer: string = Porffor.malloc(4 + cap);",
  );
  source = replace(source, "buffer = Porffor.malloc(6 + cap);", "buffer = Porffor.malloc(4 + cap);");
  source = replace(source, "buffer.length = out - (buffer as i32);", "buffer.length = (out - (buffer as i32)) / 2;");
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
  // sproutboat: read each character straight from the string and store the ones that need no
  // escape, instead of a charCodeAt call (and the checks behind it) per character, which was a
  // quarter of a 20-row feed response. Everything that needs escaping, and every surrogate,
  // still takes the branches below, so the output is unchanged.
  source = replace(
    source,
    `    const len: i32 = value.length;
    for (let i: i32 = 0; i < len; i++) {
      const c: i32 = value.charCodeAt(i);
      if (c < 0x20) {`,
    `    const len: i32 = value.length;
    const base: i32 = Porffor.IR.ptr(value);
    const narrow: boolean = Porffor.type(value) == Porffor.TYPES.bytestring;
    for (let i: i32 = 0; i < len; i++) {
      let c: i32 = 0;
      if (narrow) c = Porffor.IR.loadU8(base + i, 4);
        else c = Porffor.IR.loadU16(base + i * 2, 4);
      if (c >= 0x20) if (c != 0x22) if (c != 0x5c) if (c < 0xd800 || c > 0xdfff) {
        if (buffer + 6 <= __Porffor_json_bufLimit) Porffor.IR.storeU16(buffer, 4, c);
        buffer += 2;
        continue;
      }
      if (c < 0x20) {`,
  );
  return source;
}

// The UTF-8 loop of TextEncoder.encode in C, run once to count (__o is null) and once to
// fill. A valid surrogate pair is four bytes, a lone surrogate U+FFFD; __wide says the string is
// UTF-16, otherwise it holds one unit per byte. No backtick or dollar-brace in here: it is
// spliced into a template literal in the generated JavaScript.
const ENCODE_LOOP = `
        size_t __k = 0;
        for (size_t __i = 0; __i < __len; __i++) {
          uint32_t __c = __wide ? (uint32_t)((const uint16_t*)__s)[__i] : (uint32_t)__s[__i];
          if (__c < 0x80) { if (__o) __o[__k] = (unsigned char)__c; __k += 1; continue; }
          if (__c < 0x800) {
            if (__o) { __o[__k] = (unsigned char)(0xc0 | (__c >> 6)); __o[__k + 1] = (unsigned char)(0x80 | (__c & 0x3f)); }
            __k += 2; continue;
          }
          if (__c >= 0xd800 && __c <= 0xdbff && __i + 1 < __len) {
            const uint32_t __d = (uint32_t)((const uint16_t*)__s)[__i + 1];
            if (__d >= 0xdc00 && __d <= 0xdfff) {
              const uint32_t __cp = 0x10000 + ((__c - 0xd800) << 10) + (__d - 0xdc00);
              if (__o) {
                __o[__k] = (unsigned char)(0xf0 | (__cp >> 18)); __o[__k + 1] = (unsigned char)(0x80 | ((__cp >> 12) & 0x3f));
                __o[__k + 2] = (unsigned char)(0x80 | ((__cp >> 6) & 0x3f)); __o[__k + 3] = (unsigned char)(0x80 | (__cp & 0x3f));
              }
              __k += 4; __i++; continue;
            }
          }
          if (__c >= 0xd800 && __c <= 0xdfff) __c = 0xfffd;
          if (__o) {
            __o[__k] = (unsigned char)(0xe0 | (__c >> 12)); __o[__k + 1] = (unsigned char)(0x80 | ((__c >> 6) & 0x3f));
            __o[__k + 2] = (unsigned char)(0x80 | (__c & 0x3f));
          }
          __k += 3;
        }`;
const BT = "`";
const ENCODER = `class TextEncoder {
  // ${ENCODER_MARKER}
  get encoding() { return 'utf-8'; }
  encode(input = '') {
    const text = String(input);
    // Two C passes (size, then fill) for a string; the JS loops below stay for anything else.
    let size = -1;
    let bytes = null;
    let filled = 0;
    Porffor.c${BT}
      if (text.type == 195 || text.type == 67) {
        const int __wide = text.type == 67;
        const size_t __len = (size_t)*(u32*)(MEM + (u32)text.val);
        const unsigned char* __s = (const unsigned char*)(MEM + (u32)text.val + 4);
        unsigned char* __o = 0;
        ${ENCODE_LOOP}
        size = (f64)__k;
      }
    ${BT};
    if (size === 0) return new Uint8Array(0);
    if (size > 0) {
      bytes = new Uint8Array(size);
      Porffor.c${BT}
        if (bytes.type == 81 && *(int32_t*)(MEM + (u32)bytes.val) == (int32_t)size) {
          const int __wide = text.type == 67;
          const size_t __len = (size_t)*(u32*)(MEM + (u32)text.val);
          const unsigned char* __s = (const unsigned char*)(MEM + (u32)text.val + 4);
          unsigned char* __o = MEM + *(u32*)(MEM + (u32)bytes.val + 4) + 4;
          ${ENCODE_LOOP}
          filled = (f64)1;
        }
      ${BT};
      if (filled === 1) return bytes;
    }
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
