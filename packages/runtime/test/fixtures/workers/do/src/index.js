export class Counter {
  constructor(state) {
    this.state = state;
    this.n = 0;
  }
  async fetch() {
    this.n++;
    return new Response(String(this.n));
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/who") return new Response(__sbEnv("SB_WORKER_INDEX") || "solo");
    const stub = env.COUNTER.get(env.COUNTER.idFromName("a"));
    return stub.fetch(request);
  },
};
