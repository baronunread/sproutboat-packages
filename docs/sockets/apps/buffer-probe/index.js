import { Buffer } from "node:buffer";
const tests = {
  alloc: () => Buffer.alloc(4).length,
  allocUnsafe: () => Buffer.allocUnsafe(4).length,
  fromStr: () => Buffer.from("héllo").length,
  fromArr: () => Buffer.from([1, 2, 3]).length,
  fromHex: () => Buffer.from("deadbeef", "hex").length,
  toHex: () => Buffer.from([1, 255]).toString("hex"),
  b64: () => Buffer.from("aGk=", "base64").toString(),
  toB64: () => Buffer.from("hi").toString("base64"),
  concat: () => Buffer.concat([Buffer.from("ab"), Buffer.from("cd")]).toString(),
  writeU32: () => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(0x01020304, 0);
    return Array.from(b).join(",");
  },
  readI32: () => Buffer.from([0, 0, 1, 0]).readInt32BE(0),
  readU16: () => Buffer.from([1, 2]).readUInt16BE(0),
  subarray: () => Buffer.from("abcdef").subarray(1, 3).toString(),
  slice: () => Buffer.from("abcdef").slice(2).toString(),
  byteLength: () => Buffer.byteLength("héllo"),
  utf8: () => Buffer.from([0xc3, 0xa9]).toString("utf8"),
  latin1: () => Buffer.from("abc", "latin1").length,
  isBuffer: () => Buffer.isBuffer(Buffer.alloc(1)),
  instU8: () => Buffer.alloc(1) instanceof Uint8Array,
  copy: () => {
    const a = Buffer.alloc(4);
    Buffer.from("ab").copy(a, 1);
    return Array.from(a).join(",");
  },
  fill: () => Array.from(Buffer.alloc(3).fill(7)).join(","),
  equals: () => Buffer.from("a").equals(Buffer.from("a")),
  write: () => {
    const b = Buffer.alloc(5);
    b.write("hi", 1);
    return Array.from(b).join(",");
  },
  indexOf: () => Buffer.from("abc\0def").indexOf(0),
  rng: () => Buffer.from("abcdef").toString("utf8", 1, 3),
  rngInc: () => {
    const b = Buffer.from("abcdef");
    let i = 1;
    const s = b.toString("utf8", i, (i += 2));
    return s + "|" + i;
  },
  rngInc2: () => {
    const b = Buffer.from("abcdef");
    let i = 1;
    const f = (x) => x;
    const s = f(b.toString("utf8", i, (i += 2)));
    return s + "|" + i;
  },
  dr: () => {
    const x = Buffer.from([0x44, 0, 0, 0, 10, 0, 1, 0, 0, 0, 1, 0x31, 0, 0, 0, 1, 0x78]);
    let index = 7;
    const l = x.readInt32BE(index);
    index += 4;
    const v = x.toString("utf8", index, (index += l));
    return l + ":" + v + ":" + index;
  },
  num: () => {
    const x = Buffer.from("1");
    return +x.toString("utf8", 0, 1);
  },
  v1: () => {
    const x = Buffer.from([0x44, 0, 0, 0, 10, 0, 1, 0, 0, 0, 1, 0x31, 0, 0, 0, 1, 0x78]);
    return x.toString("utf8", 11, 12) + "|" + x.length + "|" + x.toString("utf8", 0, 2).length;
  },
  v2: () => {
    const x = Buffer.from([0x31, 0x32, 0x33]);
    return (
      x.toString("utf8", 0, 1) +
      "|" +
      x.toString("utf8", 1, 3) +
      "|" +
      x.toString("hex", 0, 2) +
      "|" +
      x.toString("latin1")
    );
  },
  v3: () => {
    const x = Buffer.from([0, 0, 0x31, 0x32]);
    return x.toString("utf8", 2, 4) + "|" + x.toString("utf8", 1, 3);
  },
  v4: () => {
    const x = Buffer.from([0x44, 0, 0, 0, 10, 0, 1, 0, 0, 0, 1, 0x31]);
    return x.toString("utf8", 11, 12) + "|" + x.toString("utf8", 7, 12).length;
  },
  w1: () => {
    const x = Buffer.from([0x44, 0, 0, 0, 10, 0, 1, 0, 0, 0, 1, 0x31, 0, 0, 0, 1, 0x78]);
    let index = 7;
    const l = x.readInt32BE(index);
    index += 4;
    return [
      l,
      typeof l,
      index,
      x.toString("utf8", index, index + l),
      x.toString("utf8", 11, 11 + l),
      x.toString("utf8", index, 12),
    ].join("|");
  },
  w2: () => {
    const x = Buffer.from([0x44, 0, 0, 0, 10, 0, 1, 0, 0, 0, 1, 0x31, 0, 0, 0, 1, 0x78]);
    let index = 7;
    const l = x.readInt32BE(index);
    index += 4;
    const e = index + l;
    return x.toString("utf8", index, e) + "|" + e;
  },
  w3: () => {
    const x = Buffer.from([0x44, 0, 0, 0, 10, 0, 1, 0, 0, 0, 1, 0x31, 0, 0, 0, 1, 0x78]);
    let index = 11;
    let l = 1;
    return x.toString("utf8", index, (index += l)) + "|" + index;
  },
  y1: () => {
    const x = Buffer.from([0x31, 0x32]);
    const v = x.toString("utf8", 0, 1);
    return "a" + v + "|" + v.length + "|" + typeof v + "|" + String(v) + "|" + (v === "1");
  },
  y2: () => {
    const x = Buffer.from([0x31, 0x32]);
    const v = x.toString("utf8", 0, 1);
    return v;
  },
  y3: () => {
    const x = Buffer.from([0x31, 0x32]);
    const v = x.toString("utf8", 0, 1);
    const w = v + "!";
    return w;
  },
  y4: () => {
    const x = Buffer.from([0x31, 0x32]);
    let v;
    v = x.toString("utf8", 0, 1);
    return "[" + v + "]";
  },
  y5: () => {
    const x = Buffer.from([0x31, 0x32]);
    const l = 1;
    const v = x.toString("utf8", 0, l);
    return l + ":" + v;
  },
  z1: () => {
    const x = Buffer.from([0, 0, 0, 1, 0x31, 0x32]);
    let i = 0;
    const l = x.readInt32BE(i);
    i = 4;
    const f = (a, b) => a + "," + b;
    return f(i, (i += l));
  },
  z2: () => {
    const x = Buffer.from([0, 0, 0, 1, 0x31, 0x32]);
    let i = 0;
    const l = x.readInt32BE(i);
    i = 4;
    return x.toString("utf8", i, (i += l)) + "|" + i;
  },
  z3: () => {
    const x = Buffer.from([0, 0, 0, 1, 0x31, 0x32]);
    let i = 0;
    const l = 1;
    i = 4;
    return x.toString("utf8", i, (i += l)) + "|" + i;
  },
  z4: () => {
    const x = Buffer.from([0, 0, 0, 1, 0x31, 0x32]);
    let i = 0;
    const l = x.readInt32BE(i);
    i = 4;
    const s = "abcdef";
    return s.slice(i, (i += l)) + "|" + i;
  },
  z5: () => {
    const x = Buffer.from([0, 0, 0, 1, 0x31, 0x32]);
    let i = 0;
    const l = x.readInt32BE(i);
    i = 4;
    return Array.from(x.subarray(i, (i += l))).join(",") + "|" + i;
  },
  readBig: () => String(Buffer.from([0, 0, 0, 0, 0, 0, 0, 5]).readBigUInt64BE(0)),
};
export default {
  async fetch() {
    const out = {};
    for (const k of Object.keys(tests)) {
      try {
        out[k] = tests[k]();
      } catch (e) {
        out[k] = "THROW " + (e && e.message);
      }
    }
    return new Response(JSON.stringify(out, null, 0));
  },
};
