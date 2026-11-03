import postgres from "postgres";
const PORTS = { scram: 55433, md5: 55434, ssl: 55435 };
export default {
  async fetch(req) {
    const url = new URL(req.url);
    const auth = url.searchParams.get("auth") || "scram";
    const n = Number(url.searchParams.get("n") || 0);
    const opts = {
      host: "127.0.0.1",
      port: PORTS[auth],
      user: "postgres",
      password: "pw",
      database: "postgres",
      ssl: auth === "ssl" ? "require" : false,
      max: Number(url.searchParams.get("max") || 3),
      idle_timeout: 2,
      connect_timeout: 5,
    };
    const sql = postgres(opts);
    const out = {};
    const t = async (k, f) => {
      try {
        out[k] = await f();
      } catch (e) {
        out[k] = "THROW " + (e && e.name) + ": " + (e && e.message) + (e && e.code ? " [" + e.code + "]" : "");
      }
    };
    await t("simple", async () => (await sql`select 1 as one`)[0].one);
    await t("params", async () => {
      const r =
        await sql`select ${1}::int as a, ${"héllo"}::text as b, ${true}::bool as c, ${1.5}::float8 as d, ${null}::text as e`;
      return JSON.stringify(r[0]);
    });
    await t("types", async () => {
      const r =
        await sql`select '{"a":1}'::jsonb as j, now()::timestamptz as ts, '\\xdeadbeef'::bytea as by, array[1,2,3] as arr, 12345678901234::bigint as big, 3.14::numeric as num`;
      const x = r[0];
      return JSON.stringify({
        j: x.j,
        ts: typeof x.ts + ":" + (x.ts instanceof Date),
        by: Array.from(x.by).join(","),
        arr: x.arr,
        big: String(x.big),
        num: x.num,
      });
    });
    await t("ddl+insert", async () => {
      await sql`drop table if exists spike_t`;
      await sql`create table spike_t (id serial primary key, name text unique, n int)`;
      const r = await sql`insert into spike_t (name, n) values (${"a"}, ${1}), (${"b"}, ${2}) returning id`;
      return r.length;
    });
    await t("select-many", async () => (await sql`select * from spike_t order by id`).map((r) => r.name).join(","));
    await t("tx-commit", async () => {
      await sql.begin(async (tx) => {
        await tx`insert into spike_t (name, n) values ('c', 3)`;
      });
      return (await sql`select count(*)::int as c from spike_t`)[0].c;
    });
    await t("tx-rollback", async () => {
      try {
        await sql.begin(async (tx) => {
          await tx`insert into spike_t (name, n) values ('d', 4)`;
          throw new Error("boom");
        });
      } catch (e) {}
      return (await sql`select count(*)::int as c from spike_t`)[0].c;
    });
    await t("err-syntax", async () => {
      try {
        await sql`selec 1`;
        return "no error";
      } catch (e) {
        return e.code + ":" + e.message;
      }
    });
    await t("err-unique", async () => {
      try {
        await sql`insert into spike_t (name, n) values ('a', 9)`;
        return "no error";
      } catch (e) {
        return e.code + ":" + e.constraint_name;
      }
    });
    await t("after-error", async () => (await sql`select 2 as two`)[0].two);
    await t("pool-concurrent", async () => {
      const r = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => sql`select ${i}::int as i, pg_sleep(0.05)`));
      return r.map((x) => x[0].i).join(",");
    });
    await t("unsafe", async () => (await sql.unsafe("select 'x' as y"))[0].y);
    if (n > 0) {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) await sql`select ${i}::int as i`;
      const t1 = performance.now();
      out.us_per_query = Math.round(((t1 - t0) * 1000) / n);
    }
    await t("end", async () => {
      await sql.end({ timeout: 2 });
      return "ok";
    });
    return new Response(JSON.stringify(out, null, 1), { headers: { "content-type": "application/json" } });
  },
};
