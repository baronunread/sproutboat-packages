// The app of test/native-storage-s3-app.ts (design 029 stage S3): what a handler can do around the acknowledgement gate. Every
// route answers JSON that includes the gate's counters, so the test sees the commit position the host would stamp and the
// confirmed position the host would write. (__sbGateSeq and __sbGateConfirmed are the runtime's, always present.)
const state = () => ({
  seq: globalThis.__sbGateSeq(),
  confirmed: globalThis.__sbGateConfirmed(),
});
export class Obj {
  constructor(ctx) {
    this.ctx = ctx;
  }
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/obj/, "");
    if (path === "/put") await this.ctx.storage.put("k", url.searchParams.get("v") ?? "1");
    if (path === "/put-unconfirmed")
      await this.ctx.storage.put("k", url.searchParams.get("v") ?? "1", {
        allowUnconfirmed: true,
      });
    if (path === "/delete-unconfirmed") await this.ctx.storage.delete("k", { allowUnconfirmed: true });
    if (path === "/sync") {
      const t0 = Date.now();
      await this.ctx.storage.put("k", "s");
      await this.ctx.storage.sync();
      return Response.json({ ...state(), waited: Date.now() - t0 });
    }
    if (path === "/get")
      return Response.json({
        ...state(),
        v: (await this.ctx.storage.get("k")) ?? null,
      });
    if (path === "/sync-only") {
      const t0 = Date.now();
      await this.ctx.storage.sync();
      return Response.json({ ...state(), waited: Date.now() - t0 });
    }
    return Response.json(state());
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/state") return Response.json(state());
    if (url.pathname === "/d1") {
      await env.DB.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)");
      await env.DB.prepare("INSERT INTO t (v) VALUES (?)")
        .bind(url.searchParams.get("v") ?? "x")
        .run();
      return Response.json(state());
    }
    if (url.pathname === "/kv") {
      await env.KV.put("k", url.searchParams.get("v") ?? "x");
      return Response.json(state());
    }
    if (url.pathname === "/outgoing") {
      // a write, then a call out: the call must wait for the confirmation (state before it, and the time it took)
      await env.DB.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)");
      await env.DB.prepare("INSERT INTO t (v) VALUES ('o')").run();
      const before = state();
      const t0 = Date.now();
      const r = await fetch(url.searchParams.get("to"));
      return Response.json({
        before,
        after: state(),
        waited: Date.now() - t0,
        status: r.status,
      });
    }
    if (url.pathname === "/outgoing-read-only") {
      const before = state();
      const t0 = Date.now();
      const r = await fetch(url.searchParams.get("to"));
      return Response.json({
        before,
        waited: Date.now() - t0,
        status: r.status,
      });
    }
    if (url.pathname.startsWith("/obj/")) {
      const id = env.OBJ.idFromName("one");
      return env.OBJ.get(id).fetch(request);
    }
    return Response.json(state());
  },
};
