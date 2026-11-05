let seed = 1; const out=[]; for (let i=0;i<60;i++){ seed = seed * 1103515245 + 12345; out.push(seed); }
console.log(out.join(","));
