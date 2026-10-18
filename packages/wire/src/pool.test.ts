import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frameOf } from "./broker";

test("shared worker isolates tokens, state and replay IDs, and revokes only one session", async () => {
  const root = mkdtempSync(join(tmpdir(),"sb-pool-test-"));
  const child = Bun.spawn([process.execPath,join(import.meta.dir,"pool.ts"),"2"],{stdin:"pipe",stdout:"pipe",stderr:"inherit"});
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let sequence = 0;
  async function command(id:string,op:string,args?:string[]) {
    child.stdin.write(JSON.stringify({requestId:++sequence,id,op,args})+"\n");
    while (!buffered.includes("\n")) {
      const part=await reader.read();
      if(part.done) throw new Error("worker exited");
      buffered+=decoder.decode(part.value);
    }
    const index=buffered.indexOf("\n");
    // SAFETY: this is the worker's acknowledgement, not a tenant reply.
    const reply=JSON.parse(buffered.slice(0,index)) as {ok:boolean};
    buffered=buffered.slice(index+1);
    return reply;
  }
  async function request(port:number,token:string,op:string,id:number,value="") {
    return new Promise<string>((resolve,reject)=>{
      let bytes=Buffer.alloc(0);
      void Bun.connect({hostname:"127.0.0.1",port,socket:{
        open(socket){socket.write(frameOf(Buffer.from(token+"\n"+JSON.stringify({op,id,ns:"DATA",key:"key",value}))));},
        data(socket,chunk){bytes=Buffer.concat([bytes,chunk]);if(bytes.length>=4&&bytes.length>=bytes.readUInt32LE(0)+4){resolve(bytes.subarray(4).toString());socket.end();}},
        error(_socket,error){reject(error);},
      }}).catch(reject);
    });
  }
  const freePort=()=>{const s=Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}});const p=s.port!;s.stop(true);return p;};
  try {
    const binding=join(root,"bindings.json");writeFileSync(binding,JSON.stringify({kv:["DATA"]}));
    const a=freePort();let b=freePort();while(b===a)b=freePort();
    expect((await command("a","register",["--port",String(a),"--token","token-a","--db",join(root,"a.sqlite"),"--bindings",binding])).ok).toBe(true);
    expect((await command("b","register",["--port",String(b),"--token","token-b","--db",join(root,"b.sqlite"),"--bindings",binding])).ok).toBe(true);
    expect((await command("overflow","register",[])).ok).toBe(false);
    expect(await request(a,"token-b","kv.get",2)).toContain("unauthorized");
    await request(a,"token-a","kv.put",1,"A");
    await request(b,"token-b","kv.put",1,"B");
    expect(await request(a,"token-a","kv.get",2)).toContain('"value":"A"');
    expect(await request(b,"token-b","kv.get",2)).toContain('"value":"B"');
    expect((await command("a","remove")).ok).toBe(true);
    expect(await request(b,"token-b","kv.get",3)).toContain('"value":"B"');
    expect((await command("a","enable")).ok).toBe(false);
  } finally {child.kill(9);await child.exited;reader.releaseLock();rmSync(root,{recursive:true,force:true});}
},10_000);
