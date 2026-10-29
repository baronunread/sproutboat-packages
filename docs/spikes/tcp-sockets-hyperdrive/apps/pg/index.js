import pg from "pg";
const PORTS = { scram: 55433, md5: 55434, ssl: 55435 };
export default {
  async fetch(req) {
    const url = new URL(req.url);
    const auth = url.searchParams.get("auth") || "scram";
    const n = Number(url.searchParams.get("n") || 0);
    const cfg = {
      host: "127.0.0.1",
      port: PORTS[auth],
      user: "postgres",
      password: "pw",
      database: "postgres",
      ssl: auth === "ssl" ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 2000,
      max: 3,
    };
    const out = {};
    const t = async (k, f) => {
      try {
        out[k] = await f();
      } catch (e) {
        out[k] = "THROW " + (e && e.name) + ": " + (e && e.message) + (e && e.code ? " [" + e.code + "]" : "");
      }
    };
    await t(
      "isCloudflare",
      async () => typeof navigator + ":" + (typeof navigator === "object" ? navigator.userAgent : ""),
    );
    const client = new pg.Client(cfg);
    await t("connect", async () => {
      await client.connect();
      return "ok";
    });
    await t("simple", async () => (await client.query("select 1 as one")).rows[0].one);
    await t("params", async () =>
      JSON.stringify(
        (
          await client.query("select $1::int as a, $2::text as b, $3::bool as c, $4::float8 as d, $5::text as e", [
            1,
            "héllo",
            true,
            1.5,
            null,
          ])
        ).rows[0],
      ),
    );
    await t("types", async () => {
      const x = (
        await client.query(
          "select '{\"a\":1}'::jsonb as j, now()::timestamptz as ts, '\\xdeadbeef'::bytea as by, array[1,2,3] as arr, 12345678901234::bigint as big, 3.14::numeric as num",
        )
      ).rows[0];
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
      await client.query("drop table if exists spike_p");
      await client.query("create table spike_p (id serial primary key, name text unique, n int)");
      const r = await client.query("insert into spike_p (name, n) values ($1,$2),($3,$4) returning id", [
        "a",
        1,
        "b",
        2,
      ]);
      return r.rows.length;
    });
    await t("select-many", async () =>
      (await client.query("select * from spike_p order by id")).rows.map((r) => r.name).join(","),
    );
    await t("tx-commit", async () => {
      await client.query("begin");
      await client.query("insert into spike_p (name, n) values ('c', 3)");
      await client.query("commit");
      return (await client.query("select count(*)::int as c from spike_p")).rows[0].c;
    });
    await t("tx-rollback", async () => {
      await client.query("begin");
      await client.query("insert into spike_p (name, n) values ('d', 4)");
      await client.query("rollback");
      return (await client.query("select count(*)::int as c from spike_p")).rows[0].c;
    });
    await t("err-syntax", async () => {
      try {
        await client.query("selec 1");
        return "no error";
      } catch (e) {
        return e.code + ":" + e.message;
      }
    });
    await t("err-unique", async () => {
      try {
        await client.query("insert into spike_p (name, n) values ('a', 9)");
        return "no error";
      } catch (e) {
        return e.code + ":" + e.constraint;
      }
    });
    await t("after-error", async () => (await client.query("select 2 as two")).rows[0].two);
    if (n > 0) {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) await client.query("select $1::int as i", [i]);
      out.us_per_query = Math.round(((performance.now() - t0) * 1000) / n);
    }
    await t("end", async () => {
      await client.end();
      return "ok";
    });
    // pool
    const pool = new pg.Pool(cfg);
    await t("pool-concurrent", async () => {
      const r = await Promise.all(
        [1, 2, 3, 4, 5, 6].map((i) => pool.query("select $1::int as i, pg_sleep(0.05)", [i])),
      );
      return r.map((x) => x.rows[0].i).join(",") + " total=" + pool.totalCount;
    });
    await t("pool-end", async () => {
      await pool.end();
      return "ok";
    });
    return new Response(JSON.stringify(out, null, 1), { headers: { "content-type": "application/json" } });
  },
};
