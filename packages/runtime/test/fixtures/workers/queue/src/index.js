export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/who") return new Response(__sbEnv("SB_WORKER_INDEX") || "solo");
    await env.JOBS.send({ at: Date.now() });
    return new Response("queued");
  },
  async queue(batch) {
    for (const m of batch.messages) m.ack();
  },
};
