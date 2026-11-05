process.on && process.on("unhandledRejection",(r)=>console.log("UR",String(r)));
Promise.reject(new Error("boom"));
setTimeout(()=>console.log("still"),10);
