// bun /tmp/af/slow.ts PORT : /slow?delay=ms answers "slow-<i>" after delay; /echo returns the body
Bun.serve({
  port: Number(process.argv[2] || 19100),
  hostname: "0.0.0.0",
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/slow") {
      await Bun.sleep(Number(u.searchParams.get("delay") || 100));
      return new Response("slow-" + (u.searchParams.get("i") ?? "x"));
    }
    if (u.pathname === "/echo")
      return new Response("echo:" + (await req.text()) + ":" + req.headers.get("x-test"), {
        headers: { "content-type": "text/x-echo" },
      });
    return new Response("nf", { status: 404 });
  },
});
