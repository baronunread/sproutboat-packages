class Buf extends Uint8Array { toString(e){ return "X"+e; } }
const b = new Buf(2); console.log(b.toString("hex"));
