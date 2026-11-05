/**
 * Linear `replace(regex, fn | template)`. Alpha 20 made `s += e` linear itself; a 100,000-match
 * callback replace still took 2.3 s on stock alpha 20 (Bun: 18 ms), because the result grew by one
 * strcat, a full copy, per match. Collect the pieces and join once.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPLACE_MARKER = "export const __Porffor_regex_replaceCallback = ";
const REPLACE_FN_ANCHOR =
  "export const __RegExp_prototype_Symbol_replace = function (this: any, string: any, replaceValue: any) {\n";
const REPLACE_FN_END = "export const __RegExp_prototype_Symbol_split = ";

const REPLACE_CALLBACK = String.raw`// sproutboat: replace(globalRegExp, fn) for a pristine regexp without named groups. The
// matches are found first, as the spec's result list is, but kept as positions instead of
// exec result arrays (two property writes and a substring per capture each); the pieces
// are joined once instead of a strcat per match.
export const __Porffor_regex_replaceCallback = (rx: any, s: any, fn: any): any => {
  const sType: i32 = Porffor.type(s);
  const lengthS: i32 = s.length;
  const fullUnicode: boolean = (Porffor.IR.loadU16(rx, 4) & 0b10010000) != 0;
  const nCaps: i32 = Porffor.IR.loadU16(rx, 6);
  const marks: any[] = Porffor.array.new(64);
  Porffor.IR.storeI32(rx, 8, 0);
  let searchIndex: i32 = 0;
  while (true) {
    // sets lastIndex to the match end, or to 0 when there is none
    const matchEnd: i32 = __Porffor_regex_interpretFrom(rx, s, 2, searchIndex);
    if (matchEnd == -1) break;
    const matchStart: i32 = __Porffor_regex_mStart;
    Porffor.array.fastPush(marks, matchStart);
    Porffor.array.fastPush(marks, matchEnd);
    const caps: i32 = __Porffor_regex_capsPtr;
    for (let k: i32 = 0; k < nCaps; k++) {
      Porffor.array.fastPush(marks, Porffor.IR.loadI32(caps + k * 8, 0));
      Porffor.array.fastPush(marks, Porffor.IR.loadI32(caps + k * 8, 4));
    }
    if (matchEnd == matchStart) searchIndex = __Porffor_regex_advance(s, matchEnd, fullUnicode);
      else searchIndex = matchEnd;
  }

  const nMarks: i32 = marks.length;
  if (nMarks == 0) return s;
  const pieces: any[] = Porffor.array.new(0);
  let nextPos: i32 = 0;
  for (let m: i32 = 0; m < nMarks; m += 2 + nCaps * 2) {
    const position: i32 = marks[m];
    const end: i32 = marks[m + 1];
    const args: any[] = Porffor.array.new(nCaps + 3);
    Porffor.array.fastPush(args, __Porffor_regex_inputSubstring(s, sType, position, end));
    for (let k: i32 = 0; k < nCaps; k++) {
      const cs: i32 = marks[m + 2 + k * 2];
      const ce: i32 = marks[m + 3 + k * 2];
      if (cs != -1 && ce != -1) Porffor.array.fastPush(args, __Porffor_regex_inputSubstring(s, sType, cs, ce));
        else Porffor.array.fastPush(args, undefined);
    }
    Porffor.array.fastPush(args, position);
    Porffor.array.fastPush(args, s);
    const replacement: any = ecma262.ToString(Porffor.call(fn, args, undefined, undefined));
    if (position >= nextPos) {
      Porffor.array.fastPush(pieces, __Porffor_regex_inputSubstring(s, sType, nextPos, position));
      Porffor.array.fastPush(pieces, replacement);
      nextPos = end;
    }
  }
  if (nextPos < lengthS) Porffor.array.fastPush(pieces, __Porffor_regex_inputSubstring(s, sType, nextPos, lengthS));
  return Porffor.callThis(__Array_prototype_join, pieces, '');
};

`;

const REPLACE_EDITS = [
  [
    "  if (pristine && !functional && __Porffor_regex_flagIn(replaceValue, 36) == false) return __Porffor_regex_replacePlain(rx, s, replaceValue);\n",
    "  if (pristine && !functional && __Porffor_regex_flagIn(replaceValue, 36) == false) return __Porffor_regex_replacePlain(rx, s, replaceValue);\n" +
      "  // sproutboat: global, no named groups, lastIndex in the header\n" +
      "  if (pristine && functional) if ((Porffor.IR.loadU16(rx, 4) & 0b00000001) != 0) if (Porffor.IR.loadI32(rx, 16) == 0) if (Porffor.IR.loadU8(rx, 20) == 0)\n" +
      "    return __Porffor_regex_replaceCallback(rx, s, replaceValue);\n",
  ],
  [
    "  let acc: any = '';\n",
    "  // sproutboat: pieces joined once, not a strcat (full copy) per match\n  const pieces: any[] = Porffor.array.new(0);\n",
  ],
  [
    "      acc = __Porffor_strcat(__Porffor_strcat(acc, __Porffor_regex_inputSubstring(s, sType, nextPos, position)), replacement);\n",
    "      Porffor.array.fastPush(pieces, __Porffor_regex_inputSubstring(s, sType, nextPos, position));\n      Porffor.array.fastPush(pieces, replacement);\n",
  ],
  [
    "  if (nextPos >= lengthS) return acc;\n  return __Porffor_strcat(acc, __Porffor_regex_inputSubstring(s, sType, nextPos, lengthS));\n",
    "  if (nextPos < lengthS) Porffor.array.fastPush(pieces, __Porffor_regex_inputSubstring(s, sType, nextPos, lengthS));\n  return Porffor.callThis(__Array_prototype_join, pieces, '');\n",
  ],
] as const;

/** Linear replace(regex, fn | template). Before the precompile, which compiles it. */
export async function patchRegexReplace(root: string): Promise<void> {
  const file = resolve(root, "compiler/builtins/regexp.ts");
  let src = await readFile(file, "utf8");
  if (src.includes(REPLACE_MARKER)) return;
  const start = src.indexOf(REPLACE_FN_ANCHOR);
  const end = src.indexOf(REPLACE_FN_END, start);
  if (start < 0 || end < 0) throw new Error(`could not find Porffor's RegExp replace in ${file}`);
  let body = src.slice(start, end);
  for (const [anchor, inject] of REPLACE_EDITS) {
    if (body.split(anchor).length !== 2)
      throw new Error(`could not patch Porffor's RegExp replace: anchor not found once in ${file}`);
    body = body.replace(anchor, () => inject);
  }
  src = src.slice(0, start) + REPLACE_CALLBACK + body + src.slice(end);
  await writeFile(file, src);
}
