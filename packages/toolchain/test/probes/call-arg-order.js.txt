function f(a,b){return a+","+b}
let i=1; console.log(f(i, i+=5));
const buf = {toString(e,s,t){return e+s+t}}; let idx=2; console.log(buf.toString("u",idx,idx+=3));
