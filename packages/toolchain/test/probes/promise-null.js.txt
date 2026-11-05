Promise.resolve(null).then(v=>console.log(v===null));
(async()=>{ const x = await null; console.log("a", x); const y = await Promise.resolve(null); console.log("b", y); })();
