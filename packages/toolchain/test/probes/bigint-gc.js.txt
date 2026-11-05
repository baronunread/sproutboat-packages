function churn(n){let t="";let k=0;for(let i=0;i<n;i++){t="pad"+i+"-x";if(i%50==0)k++;}return k;}
const keep=[];
let acc = 2n**70n + 12345n;
for (let i=0;i<2000;i++){ acc = acc * 3n + BigInt(i); keep.push(acc); if (acc > 2n**200n) acc = acc % (2n**100n); }
const m = new Map(); for (let i=0;i<500;i++) m.set(i, 2n**BigInt(64+i));
const o = {}; for (let i=0;i<300;i++) o["k"+i] = 10n**BigInt(30+i%20);
function mk(){ let x = 7n**40n; return () => x*2n; }
const f = mk();
for (let r=0;r<6;r++) churn(1500000);
let h=0n; for (const v of keep) h = (h*31n + v) % (2n**89n-1n);
let s=0n; for (const [k,v] of m) s += v>>BigInt(k);
let p=0n; for (const k in o) p += o[k];
console.log(String(h), String(s), String(p), String(f()));
