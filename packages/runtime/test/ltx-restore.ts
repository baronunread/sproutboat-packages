// LTX chain restore, the same independent checker as native-ltx.ts (copied, so that test
// stays as it is): every file's CRCs, checksums and TXIDs verified, pages applied in order.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Independent CRC baseline in Bun. This intentionally uses BigInt, unlike C.
const table: bigint[] = [];
for (let i = 0; i < 256; i++) {
  let c = BigInt(i);
  for (let j = 0; j < 8; j++) c = (c >> 1n) ^ (c & 1n ? 0xd800000000000000n : 0n);
  table.push(c);
}
function crc(data: Uint8Array, init = 0xffffffffffffffffn) {
  let c = init;
  for (const b of data) c = table[Number((c ^ BigInt(b)) & 255n)] ^ (c >> 8n);
  return c;
}
const flag = 0x8000000000000000n,
  mask = 0xffffffffffffffffn;
function pageCrc(pgno: number, page: Uint8Array) {
  const p = new Uint8Array(4);
  new DataView(p.buffer).setUint32(0, pgno);
  return flag | (crc(page, crc(p)) ^ mask);
}

export async function restore(epoch: string, output: string) {
  const files = (await readdir(epoch)).filter((n) => n.endsWith(".ltx")).sort();
  let db = new Uint8Array(0),
    checksum = 0n,
    txid = 0n;
  for (const file of files) {
    const b = new Uint8Array(await readFile(join(epoch, file)));
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    assert.equal(new TextDecoder().decode(b.subarray(0, 4)), "LTX1");
    const pageSize = v.getUint32(8),
      commit = v.getUint32(12);
    assert.equal(v.getBigUint64(16), txid + 1n);
    assert.equal(v.getBigUint64(40), checksum);
    const next = new Uint8Array(commit * pageSize);
    next.set(db.subarray(0, next.length));
    db = next;
    let offset = 100,
      hash = crc(b.subarray(0, 100));
    const entries = [];
    for (;;) {
      const begin = offset,
        pgno = v.getUint32(offset),
        flags = v.getUint16(offset + 4);
      hash = crc(b.subarray(offset, offset + 6), hash);
      offset += 6;
      if (!pgno) {
        assert.equal(flags, 0);
        break;
      }
      assert.equal(flags, 1);
      assert(pgno <= commit);
      const size = v.getUint32(offset);
      hash = crc(b.subarray(offset, offset + 4), hash);
      offset += 4;
      const stop = offset + size;
      assert(stop <= b.length);
      assert.equal(b[offset++], 0xf0);
      let literals = 15,
        byte;
      do {
        byte = b[offset++];
        literals += byte;
      } while (byte === 255);
      assert.equal(literals, pageSize);
      assert.equal(offset + pageSize, stop);
      const page = b.subarray(offset, stop);
      db.set(page, (pgno - 1) * pageSize);
      hash = crc(page, hash);
      offset = stop;
      entries.push({ pgno, offset: begin, size: stop - begin });
    }
    const indexStart = offset;
    function varint() {
      let n = 0n,
        s = 0n;
      for (let i = 0; i < 10; i++) {
        assert(offset < b.length);
        const c = b[offset++];
        n |= BigInt(c & 127) << s;
        if (c < 128) return Number(n);
        s += 7n;
      }
      throw new Error("varint overflow");
    }
    for (const entry of entries) {
      assert.equal(varint(), entry.pgno);
      assert.equal(varint(), entry.offset);
      assert.equal(varint(), entry.size);
    }
    assert.equal(varint(), 0);
    assert.equal(v.getBigUint64(offset), BigInt(offset - indexStart));
    offset += 8;
    hash = crc(b.subarray(indexStart, offset + 8), hash);
    checksum = flag;
    for (let p = 1; p <= commit; p++)
      checksum = flag | (checksum ^ pageCrc(p, db.subarray((p - 1) * pageSize, p * pageSize)));
    assert.equal(v.getBigUint64(offset), checksum, file);
    assert.equal(v.getBigUint64(offset + 8), flag | (hash ^ mask), file);
    assert.equal(offset + 16, b.length);
    txid = v.getBigUint64(24);
  }
  await writeFile(output, db);
  return { files: files.length, txid };
}
