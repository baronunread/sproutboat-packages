/**
 * Linear string building: `s += e` in loops, `replace(regex, fn)` and JSON.parse.
 *
 * Porffor strings are immutable `[length][chars]` buffers, and every `s += e` copied
 * all of s, so a loop that builds a string was quadratic. sproutd's heavy regex-scan
 * benchmark (3,000 appends, then `replace(/\d+/g, fn)`) spent 36.7 ms per request on
 * othello against workerd's 3.8. Three parts:
 *
 * - STRING_APPEND_PASS, an AST pass run after parsing: an eligible local's `s += e;`
 *   statements append in place while the variable exclusively owns its buffer.
 * - STRING_APPEND_BUILTIN, the append itself: write into the GC block's spare room,
 *   or copy into a block twice the size.
 * - RegExp replace with a callback collects match positions instead of exec result
 *   objects and joins the pieces once (it was a strcat per match too).
 *
 * Plus two character-read fast paths: String.prototype.charCodeAt with an in-range
 * number index, and JSON.parse reading characters directly instead of through
 * charCodeAt (half of JSON.parse's time).
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** compiler/sb-string-append.js. No template literals inside: it is a String.raw. */
export const STRING_APPEND_PASS = String.raw`
// sproutboat: linear 's += e' string building.
//
// Porffor strings are immutable buffers, so 's += e' copies all of s every time and a
// loop that builds a string is quadratic. This pass gives an eligible local a hidden
// flag that is true only while the variable holds a buffer made by its own last
// append that nothing else has seen. While it is true, __Porffor_strAppend can write
// e into the buffer's spare room in place (or grow it geometrically), because no
// other reference can observe the change. Every other read or write of the variable
// clears the flag first, so an aliased buffer is never written. A read of an owned
// buffer (it may escape now) first settles it with __Porffor_strSettle, which gives the
// spare room back, so a string that outlives its loop costs what an exact copy would.
//
// Eligible: a 'let' or 'var' declared once in a function (in a block, not a for head
// or switch case), never named in a nested function or class, never a destructuring,
// for-in/of or delete target, in a function without 'with' or 'eval', with every
// reference inside the declaring block ('let'). Only 's += e;' statements append;
// 's.length' reads leave the flag alone, everything else clears it.

const isFn = (n) => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';
const isNested = (n) => isFn(n) || n.type === 'ClassDeclaration' || n.type === 'ClassExpression';
const skipKey = (key) => key[0] === '_' || key === 'start' || key === 'end' || key === 'loc' || key === 'range';
const isPattern = (n) => n.type === 'ArrayPattern' || n.type === 'ObjectPattern' || n.type === 'RestElement' || n.type === 'AssignmentPattern';

const children = function* (node) {
  for (const key in node) {
    if (skipKey(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object' && typeof x.type === 'string') yield [ x, key ]; }
    else if (v && typeof v === 'object' && typeof v.type === 'string') yield [ v, key ];
  }
};

// any identifier with this name anywhere below node
const mentions = (node, name) => {
  if (node.type === 'Identifier' || node.type === 'JSXIdentifier') if (node.name === name) return true;
  for (const [ c ] of children(node)) if (mentions(c, name)) return true;
  return false;
};

const allNames = (node, out = new Set()) => {
  if (node.type === 'Identifier') out.add(node.name);
  for (const [ c ] of children(node)) allNames(c, out);
  return out;
};

// is the identifier 'node' (child 'key' of 'parent') a variable reference?
const isRef = (node, parent, key) => {
  if (!parent) return true;
  switch (parent.type) {
    case 'MemberExpression': return key !== 'property' || parent.computed;
    case 'Property': return key === 'value' || parent.computed;
    case 'MethodDefinition': case 'PropertyDefinition': return key !== 'key' || parent.computed;
    case 'LabeledStatement': case 'BreakStatement': case 'ContinueStatement': return key !== 'label';
    case 'MetaProperty': return false;
    case 'ExportSpecifier': case 'ImportSpecifier': case 'ImportDefaultSpecifier': case 'ImportNamespaceSpecifier': return false;
  }
  return true;
};

const appendStatement = (stmt, name) =>
  stmt.type === 'ExpressionStatement' && stmt.expression.type === 'AssignmentExpression' &&
  stmt.expression.operator === '+=' && stmt.expression.left.type === 'Identifier' && stmt.expression.left.name === name;

// everything about 'name' inside fn's own scope (nested functions and classes excluded)
const survey = (fn, name) => {
  const info = { decls: [], refs: 0, bad: false, appends: 0 };
  const visit = (node, parent, key, ancestors) => {
    if (info.bad) return;
    if (node !== fn && isNested(node)) {
      if (mentions(node, name)) info.bad = true;
      return;
    }
    if (node.type === 'Identifier' && node.name === name && isRef(node, parent, key)) {
      if (parent && parent.type === 'VariableDeclarator' && key === 'id') {
        info.decls.push({ declarator: parent, declaration: ancestors[ancestors.length - 2], block: ancestors[ancestors.length - 3] });
      } else {
        if (ancestors.some(isPattern)) info.bad = true;
        if (parent && (parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') && key === 'left') info.bad = true;
        if (parent && parent.type === 'UnaryExpression' && parent.operator === 'delete') info.bad = true;
        if (parent && parent.type === 'CatchClause') info.bad = true;
        info.refs++;
      }
    }
    if (node.type === 'ExpressionStatement' && appendStatement(node, name)) info.appends++;
    ancestors.push(node);
    for (const [ c, k ] of children(node)) visit(c, node, k, ancestors);
    ancestors.pop();
  };
  // fn's own name and params are bindings of their own
  if (fn.id && fn.id.name === name) info.bad = true;
  for (const p of fn.params) if (mentions(p, name)) info.bad = true;
  visit(fn.body, fn, 'body', [ fn ]);
  return info;
};

const ident = (name, at) => ({ type: 'Identifier', name, start: at.start, end: at.end });
const lit = (value, at) => ({ type: 'Literal', value, raw: String(value), start: at.start, end: at.end });
const seq = (exprs, at) => ({ type: 'SequenceExpression', expressions: exprs, start: at.start, end: at.end });
const assign = (left, right, at, operator = '=') => ({ type: 'AssignmentExpression', operator, left, right, start: at.start, end: at.end });
const clear = (flag, at) => assign(ident(flag, at), lit(false, at), at);
// before a read: the buffer may escape, so give back its spare room (only if owned)
const settle = (name, flag, at) => ({ type: 'LogicalExpression', operator: '&&', left: ident(flag, at), start: at.start, end: at.end,
  right: assign(ident(name, at), { type: 'CallExpression', optional: false, callee: ident('__Porffor_strSettle', at), arguments: [ ident(name, at) ], start: at.start, end: at.end }, at) });

const rewriteFunction = (fn, used) => {
  if (fn.body.type !== 'BlockStatement') return;
  // names that only a 's += e;' statement could make worth it
  const candidates = new Set();
  const collect = (node) => {
    if (node !== fn && isNested(node)) return;
    if (node.type === 'WithStatement' || node.type.startsWith('TS')) candidates.add('#with');
    if (node.type === 'Identifier' && node.name === 'eval') candidates.add('#eval');
    if (node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression' &&
        node.expression.operator === '+=' && node.expression.left.type === 'Identifier') candidates.add(node.expression.left.name);
    for (const [ c ] of children(node)) collect(c);
  };
  collect(fn.body);
  if (candidates.has('#with') || candidates.has('#eval')) return;

  for (const name of candidates) {
    const info = survey(fn, name);
    if (info.bad || info.decls.length !== 1 || info.appends === 0) continue;
    const { declarator, declaration, block } = info.decls[0];
    if (declaration.type !== 'VariableDeclaration' || (declaration.kind !== 'let' && declaration.kind !== 'var')) continue;
    if (!block || block.type !== 'BlockStatement' || !block.body.includes(declaration)) continue;
    const scope = declaration.kind === 'let' ? block : fn.body;
    // a let's references must all resolve to it: count those inside its block
    if (declaration.kind === 'let' && !(survey({ ...fn, id: null, params: [], body: block }, name).refs === info.refs)) continue;

    let flag = 'sb$own$' + name;
    for (let i = 0; used.has(flag) || used.has(flag + '$o') || used.has(flag + '$t'); i++) flag = 'sb$own' + i + '$' + name;
    rewriteName(scope, name, flag);
    // zero width at the scope start, so no reference to the flag is taken as before its declaration
    const at = { start: scope.start + 1, end: scope.start + 1 };
    // a var declaration can run again (in a loop): its initializer is a write
    if (declaration.kind === 'var' && declarator.init) {
      const i = block.body.indexOf(declaration);
      block.body.splice(i + 1, 0, { type: 'ExpressionStatement', expression: clear(flag, declaration), start: declaration.end, end: declaration.end });
    }
    // after any directive prologue
    let first = 0;
    while (first < scope.body.length && scope.body[first].type === 'ExpressionStatement' && scope.body[first].expression.type === 'Literal' && typeof scope.body[first].expression.value === 'string') first++;
    scope.body.splice(first, 0, {
      type: 'VariableDeclaration', kind: declaration.kind, start: at.start, end: at.end,
      declarations: [ { type: 'VariableDeclarator', id: ident(flag, at), init: lit(false, at), start: at.start, end: at.end } ]
    });
  }
};

// within scope (not nested functions): 'name += e;' appends, 'name.length' is left alone,
// any other reference clears the flag first
const rewriteName = (scope, name, flag) => {
  const appendBlock = (stmt) => {
    // the temporaries are declared (zero width) at the statement start and read at its end,
    // so Porffor's position-based TDZ check sees every read after its declaration
    const decl = { start: stmt.start, end: stmt.start };
    const at = { start: stmt.end, end: stmt.end };
    const o = flag + '$o', t = flag + '$t';
    const right = visit(stmt.expression.right, stmt.expression, 'right');
    const call = { type: 'CallExpression', optional: false, callee: ident('__Porffor_strAppend', at), arguments: [ ident(o, at), ident(t, at), ident(flag, at) ], start: at.start, end: at.end };
    const isString = (n) => ({ type: 'BinaryExpression', operator: '===', left: { type: 'UnaryExpression', operator: 'typeof', prefix: true, argument: ident(n, at), start: at.start, end: at.end }, right: lit('string', at), start: at.start, end: at.end });
    const exprStmt = (e) => ({ type: 'ExpressionStatement', expression: e, start: at.start, end: at.end });
    return {
      type: 'BlockStatement', start: stmt.start, end: stmt.end, body: [
        { type: 'VariableDeclaration', kind: 'let', start: decl.start, end: decl.end, declarations: [
          { type: 'VariableDeclarator', id: ident(o, decl), init: ident(name, stmt.expression.left), start: decl.start, end: decl.end },
          { type: 'VariableDeclarator', id: ident(t, decl), init: right, start: decl.start, end: decl.end }
        ] },
        { type: 'IfStatement', start: at.start, end: at.end,
          test: { type: 'LogicalExpression', operator: '&&', left: isString(o), right: isString(t), start: at.start, end: at.end },
          consequent: { type: 'BlockStatement', start: at.start, end: at.end, body: [
            exprStmt(assign(ident(name, at), call, at)),
            exprStmt(assign(ident(flag, at), lit(true, at), at))
          ] },
          alternate: { type: 'BlockStatement', start: at.start, end: at.end, body: [
            exprStmt(assign(ident(name, at), { type: 'BinaryExpression', operator: '+', left: ident(o, at), right: ident(t, at), start: at.start, end: at.end }, at)),
            exprStmt(clear(flag, at))
          ] }
        }
      ]
    };
  };

  // returns the replacement for node
  const visit = (node, parent, key) => {
    if (isNested(node)) return node;
    if (node.type === 'ExpressionStatement' && appendStatement(node, name)) return appendBlock(node);

    if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && node.object.name === name &&
        node.property.type === 'Identifier' && node.property.name === 'length') return node;

    // writes: clear, then the original write (which reads first, unless it is '=')
    if ((node.type === 'AssignmentExpression' && node.left.type === 'Identifier' && node.left.name === name) ||
        (node.type === 'UpdateExpression' && node.argument.type === 'Identifier' && node.argument.name === name)) {
      if (node.type === 'AssignmentExpression') node.right = visit(node.right, node, 'right');
      if (node.type === 'AssignmentExpression' && node.operator === '=') return seq([ clear(flag, node), node ], node);
      return seq([ settle(name, flag, node), clear(flag, node), node ], node);
    }

    if (node.type === 'Identifier' && node.name === name && isRef(node, parent, key) && !(parent?.type === 'VariableDeclarator' && key === 'id')) {
      if (parent?.type === 'Property' && parent.shorthand) parent.shorthand = false;
      return seq([ settle(name, flag, node), clear(flag, node), { ...node } ], node);
    }

    for (const k in node) {
      if (skipKey(k)) continue;
      const v = node[k];
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) if (v[i] && typeof v[i] === 'object' && typeof v[i].type === 'string') v[i] = visit(v[i], node, k);
      } else if (v && typeof v === 'object' && typeof v.type === 'string') node[k] = visit(v, node, k);
    }
    return node;
  };

  for (let i = 0; i < scope.body.length; i++) scope.body[i] = visit(scope.body[i], scope, 'body');
};

const walk = (node, used) => {
  if (isFn(node)) rewriteFunction(node, used);
  for (const [ c ] of children(node)) walk(c, used);
};

export default (ast) => {
  if (globalThis.precompile) return ast;
  walk(ast, allNames(ast));
  return ast;
};
`;

const APPEND_MARKER = "export const __Porffor_strAppend = ";

/**
 * Appended to compiler/builtins/string.ts. `owned` is the pass's flag: a then holds the
 * buffer made by its variable's last append and nothing else has seen it. The capacity
 * is the GC block's size (size classes and page spans both round up); a block that is
 * full is replaced by one twice the needed size, so n appends copy O(n) bytes. When a
 * is not owned the result is an exact-size copy, as __Porffor_strcat makes.
 */
export const STRING_APPEND_BUILTIN = String.raw`

// sproutboat: in-place append for the 's += e;' statements of sb-string-append.js
export const __Porffor_strAppend = (a: any, b: any, owned: boolean): any => {
  const aBytes: boolean = Porffor.type(a) == Porffor.TYPES.bytestring;
  const bBytes: boolean = Porffor.type(b) == Porffor.TYPES.bytestring;
  if (Porffor.fastAnd(aBytes, !bBytes)) return Porffor.strcat(a, b);
  const al: i32 = Porffor.IR.loadI32(a, 0);
  const bl: i32 = Porffor.IR.loadI32(b, 0);
  const aPtr: i32 = Porffor.IR.ptr(a);
  const bPtr: i32 = Porffor.IR.ptr(b);
  const n: i32 = al + bl;
  const unit: i32 = aBytes ? 1 : 2;
  let out: i32 = aPtr;
  let cap: i32 = 0;
  if (owned) Porffor.c${"`"}
#if PORF_GC_ENABLED
  // by page kind: a slot bumped since the last collection has no allocation bit yet
  if (porf_gc_in_heap(aPtr)) {
    const u32 pg = (u32)aPtr >> PORF_GC_SPAGE_SHIFT;
    if (porf_gc_page_kind[pg] == PORF_GC_PK_SMALL) {
      if (((u32)aPtr - porf_gc_chunk_start(pg)) % porf_gc_pages[pg].cls == 0u) cap = (i32)porf_gc_pages[pg].cls;
    } else if (porf_gc_page_kind[pg] == PORF_GC_PK_SPAN && ((u32)aPtr & PORF_GC_SPAGE_MASK) == 0u) cap = (i32)(porf_gc_pages[pg].aux << PORF_GC_SPAGE_SHIFT);
  }
#endif
  ${"`"};
  if (6 + n * unit > cap) {
    // a full buffer is copied into one twice the size; a buffer it does not own, exactly
    out = Porffor.malloc(6 + (owned ? n * 2 : n) * unit);
    Porffor.IR.copy(out + 4, aPtr + 4, al * unit);
  }
  if (Porffor.fastOr(aBytes, !bBytes)) Porffor.IR.copy(out + 4 + al * unit, bPtr + 4, bl * unit);
    else for (let i: i32 = 0; i < bl; i++) Porffor.IR.storeU16(out + (al + i) * 2, 4, Porffor.IR.loadU8(bPtr + i, 4));
  Porffor.IR.storeI32(out, 0, n);
  if (aBytes) return out as bytestring;
  return out as string;
};

// sproutboat: an owned buffer is about to be read (and may escape): give back the spare
// room. A page span returns its whole free tail pages in place; a small block that a
// smaller size class would hold is copied to one, as an exact copy would have been.
export const __Porffor_strSettle = (s: any): any => {
  const t: i32 = Porffor.type(s);
  if (Porffor.fastAnd(t != Porffor.TYPES.bytestring, t != Porffor.TYPES.string)) return s;
  const ptr: i32 = Porffor.IR.ptr(s);
  const len: i32 = Porffor.IR.loadI32(s, 0);
  const bytes: i32 = 6 + (t == Porffor.TYPES.bytestring ? len : len * 2);
  let smaller: i32 = 0;
  Porffor.c${"`"}
#if PORF_GC_ENABLED
  if (porf_gc_in_heap(ptr)) {
    const u32 pg = (u32)ptr >> PORF_GC_SPAGE_SHIFT;
    if (porf_gc_page_kind[pg] == PORF_GC_PK_SPAN && ((u32)ptr & PORF_GC_SPAGE_MASK) == 0u) {
      const u32 npg = porf_gc_pages[pg].aux;
      const u32 keep = ((u32)bytes + PORF_GC_SPAGE_MASK) >> PORF_GC_SPAGE_SHIFT;
      if (keep < npg) {
        porf_gc_release_run(pg + keep, npg - keep);
        porf_gc_pages[pg].aux = keep;
      }
    } else if (porf_gc_page_kind[pg] == PORF_GC_PK_SMALL && (u32)bytes <= PORF_GC_MAX_SMALL &&
               ((u32)ptr - porf_gc_chunk_start(pg)) % porf_gc_pages[pg].cls == 0u) {
      smaller = porf_gc_cls_size[porf_gc_cls_lut[((u32)bytes + 7u) >> 3]] < porf_gc_pages[pg].cls;
    }
  }
#endif
  ${"`"};
  if (smaller == 0) return s;
  const out: i32 = Porffor.malloc(bytes);
  Porffor.IR.copy(out, ptr, bytes - 2);
  if (t == Porffor.TYPES.bytestring) return out as bytestring;
  return out as string;
};
`;

const PARSE_IMPORT_ANCHOR = "import sbClassSelf from './sb-class-self.js';\n";
const PARSE_CALL_ANCHOR = "  sbClassSelf(ast); // sproutboat #256\n";
const PARSE_MARKER = "sbStringAppend(ast)";

/** The pass and its builtin. After patchClassSelfName, whose parse.js lines it follows. */
export async function patchStringAppend(root: string): Promise<void> {
  await writeFile(resolve(root, "compiler/sb-string-append.js"), STRING_APPEND_PASS.trimStart());
  const parse = resolve(root, "compiler/parse.js");
  let src = await readFile(parse, "utf8");
  if (!src.includes(PARSE_MARKER)) {
    if (!src.includes(PARSE_IMPORT_ANCHOR) || !src.includes(PARSE_CALL_ANCHOR))
      throw new Error(`could not patch Porffor's string append pass: anchor not found in ${parse}`);
    src = src
      .replace(PARSE_IMPORT_ANCHOR, () => PARSE_IMPORT_ANCHOR + "import sbStringAppend from './sb-string-append.js';\n")
      .replace(PARSE_CALL_ANCHOR, () => PARSE_CALL_ANCHOR + "  sbStringAppend(ast); // sproutboat: linear s += e\n");
    await writeFile(parse, src);
  }
  const strings = resolve(root, "compiler/builtins/string.ts");
  const builtins = await readFile(strings, "utf8");
  if (!builtins.includes(APPEND_MARKER)) await writeFile(strings, builtins + STRING_APPEND_BUILTIN);
}

// --- RegExp.prototype[Symbol.replace] ---

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

// --- character reads ---

const CHAR_CODE_MARKER = "sproutboat: in-range number index";
const charCodeAnchor = (name: string, type: string) =>
  `export const __${name}_prototype_charCodeAt = function (this: ${type}, _index: any) {\n  const len: i32 = this.length;\n`;
const charCodeFast = (load: string) =>
  `  // ${CHAR_CODE_MARKER}: no ToIntegerOrInfinity call (trunc is the same there)\n` +
  "  if (Porffor.type(_index) == Porffor.TYPES.number) {\n" +
  "    const d: number = _index;\n" +
  "    if (d >= 0 && d < len) {\n" +
  "      const i: i32 = d;\n" +
  `      return ${load};\n` +
  "    }\n" +
  "  }\n";

/** String.prototype.charCodeAt(i) for an in-range number i. Before the precompile. */
export async function patchCharCodeAt(root: string): Promise<void> {
  const file = resolve(root, "compiler/builtins/string_f64.ts");
  let src = await readFile(file, "utf8");
  if (src.includes(CHAR_CODE_MARKER)) return;
  for (const [name, type, load] of [
    ["String", "string", "Porffor.IR.loadU16(Porffor.IR.ptr(this) + i * 2, 4)"],
    ["ByteString", "bytestring", "Porffor.IR.loadU8(Porffor.IR.ptr(this) + i, 4)"],
  ] as const) {
    const anchor = charCodeAnchor(name, type);
    if (src.split(anchor).length !== 2)
      throw new Error(`could not patch Porffor's ${name} charCodeAt: anchor not found in ${file}`);
    src = src.replace(anchor, () => anchor + charCodeFast(load));
  }
  await writeFile(file, src);
}

const JSON_PARSE_START = "export const __Porffor_json_skipWhitespace = ";
const JSON_PARSE_END = "export const __Porffor_json_internalize = ";
const JSON_CHAR_MARKER = "export const __Porffor_json_cc = ";
const JSON_CHAR_HELPER = `// sproutboat: the parser's character reads, without a charCodeAt call (and its
// ToIntegerOrInfinity) each. Every caller checks the position against len first;
// past the end it is -1, which no comparison there accepts.
${JSON_CHAR_MARKER}(text: any, pos: i32): i32 => {
  if (Porffor.fastOr(pos < 0, pos >= Porffor.IR.loadI32(text, 0))) return -1;
  if (Porffor.type(text) == Porffor.TYPES.bytestring) return Porffor.IR.loadU8(Porffor.IR.ptr(text) + pos, 4);
  return Porffor.IR.loadU16(Porffor.IR.ptr(text) + pos * 2, 4);
};

`;
/** text.charCodeAt reads in Porffor's JSON.parse at alpha 19 (fails loudly if that moves). */
const JSON_CHAR_READS = 29;

/** JSON.parse reads characters directly. Before the precompile. */
export async function patchJsonParseChars(root: string): Promise<void> {
  const file = resolve(root, "compiler/builtins/json.ts");
  const src = await readFile(file, "utf8");
  if (src.includes(JSON_CHAR_MARKER)) return;
  const start = src.indexOf(JSON_PARSE_START);
  const end = src.indexOf(JSON_PARSE_END, start);
  if (start < 0 || end < 0) throw new Error(`could not find Porffor's JSON.parse in ${file}`);
  const parser = src.slice(start, end);
  const reads = parser.split("text.charCodeAt(").length - 1;
  if (reads !== JSON_CHAR_READS || parser.replaceAll("text.charCodeAt(", "").includes(".charCodeAt("))
    throw new Error(
      `could not patch Porffor's JSON.parse character reads: expected ${JSON_CHAR_READS} text.charCodeAt reads in ${file}, found ${reads}`,
    );
  await writeFile(
    file,
    src.slice(0, start) +
      JSON_CHAR_HELPER +
      parser.replaceAll("text.charCodeAt(", "__Porffor_json_cc(text, ") +
      src.slice(end),
  );
}
