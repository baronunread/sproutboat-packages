// AsyncLocalStorage as Workers has it (nodejs_compat). The same file runs on workerd for the
// comparison, where the class comes from node:async_hooks; here the prelude's global stands in
// until the CLI maps the import.
const ALS = globalThis.__sbAlsForTest || globalThis.AsyncLocalStorage;
const als = new ALS();
const other = new ALS();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(path, id, delay) {
  if (path === "/basic") {
    const out = [];
    out.push(als.getStore());
    out.push(als.run("a", () => als.getStore()));
    out.push(als.run("a", () => als.run("b", () => als.getStore())));
    out.push(als.run("a", () => als.run("b", () => als.exit(() => als.getStore()))));
    out.push(als.run("a", () => other.run("x", () => [als.getStore(), other.getStore()])));
    out.push(als.getStore());
    try {
      als.run("t", () => {
        throw new Error("boom");
      });
    } catch (e) {
      out.push(["threw", e.message, als.getStore()]);
    }
    out.push(als.run("args", (x, y) => [als.getStore(), x, y], 1, 2));
    out.push(als.run("v", () => 7));
    return out;
  }
  if (path === "/await") {
    return als.run({ id }, async () => {
      const seen = [als.getStore().id];
      await sleep(delay);
      seen.push(als.getStore().id);
      await null;
      seen.push(als.getStore().id);
      await Promise.resolve().then(() => seen.push(als.getStore().id));
      await new Promise((resolve) =>
        setTimeout(() => {
          seen.push(als.getStore().id);
          resolve();
        }, delay),
      );
      await Promise.all([
        sleep(delay),
        (async () => {
          await sleep(1);
          seen.push(als.getStore().id);
        })(),
      ]);
      const viaThen = await new Promise((resolve) => {
        sleep(delay).then(() => resolve(als.getStore().id));
      });
      seen.push(viaThen);
      queueMicrotask(() => seen.push("q" + als.getStore().id));
      await sleep(1);
      let ticks = 0;
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          seen.push("i" + als.getStore().id);
          if (++ticks === 2) {
            clearInterval(timer);
            resolve();
          }
        }, 1);
      });
      try {
        await Promise.reject(new Error("r"));
      } catch (e) {
        seen.push("c" + als.getStore().id);
      }
      await Promise.allSettled([Promise.reject(new Error("s"))]);
      seen.push("s" + als.getStore().id);
      return seen;
    });
  }
  if (path === "/bind") {
    const snapped = als.run("captured", () => ALS.snapshot());
    const bound = () => snapped(() => als.getStore());
    const snap = als.run("snap", () => ALS.snapshot());
    const results = [bound(), als.run("other", () => bound()), snap(() => als.getStore()), als.getStore()];
    await sleep(1);
    results.push(
      await als.run("later", async () => {
        await sleep(1);
        return bound();
      }),
    );
    return results;
  }
  if (path === "/nested-async") {
    const inner = async () => {
      await sleep(delay);
      return als.getStore();
    };
    const a = als.run("outer", async () => {
      const x = await inner();
      const y = await als.run("inner", () => inner());
      const z = await inner();
      return [x, y, z, als.getStore()];
    });
    return await a;
  }
  if (path === "/leak") {
    // A run() that finished leaves nothing behind, even while its async work is pending.
    let pending;
    als.run("gone", () => {
      pending = sleep(delay);
    });
    const before = als.getStore();
    await pending;
    return [before, als.getStore()];
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") || "";
    const delay = Number(url.searchParams.get("d") || 1);
    if (url.pathname === "/wu") {
      als.run({ id }, () => {
        ctx.waitUntil(
          (async () => {
            await sleep(delay);
            globalThis.__alsWu = als.getStore().id;
          })(),
        );
      });
      return new Response("scheduled");
    }
    if (url.pathname === "/wu-read") return new Response(String(globalThis.__alsWu));
    const result = await run(url.pathname, id, delay);
    return Response.json(result);
  },
};
