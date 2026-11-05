import { AsyncLocalStorage } from "node:async_hooks";
const als = new AsyncLocalStorage();
als.run({id:1}, async ()=>{ await null; console.log(als.getStore()?.id); setTimeout(()=>console.log("t",als.getStore()?.id),1); });
