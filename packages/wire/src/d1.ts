/** D1's synchronous storage contract, shared by dedicated and SQL-worker modes. */
import { budgetExtension } from "./build-d1-budget";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isBoolean, isString, jsonObject, type JsonObject, type JsonValue } from "./json";
import type { Frame } from "./broker";

const isNumber = (value: JsonValue): value is number => Number.isFinite(value);
type SqlParam = string | number | null;
const str = (v: JsonValue | undefined) => (isString(v) ? v : String(v ?? ""));
const params = (v: JsonValue | undefined): SqlParam[] =>
  Array.isArray(v)
    ? v.map((p) => (p === null || isNumber(p) || isString(p) ? p : isBoolean(p) ? Number(p) : String(p)))
    : [];
export type D1Request = { owner: string; key: string; path: string; name: string; msg: Frame };

export function createD1Store(executionMs = 0, capability = "") {
  if (executionMs && !/^[a-f0-9]{64}$/.test(capability)) throw new Error("invalid host budget capability");
  const connections = new Map<string, { db: Database; owners: Set<string> }>();
  const run = (db: Database, sql: string, values: SqlParam[]) => {
    const started = performance.now();
    const results = db.query<JsonObject, SqlParam[]>(sql).all(...values);
    const meta = db
      .query<{ changes: number; last_row_id: number }, []>(
        "SELECT changes() AS changes, last_insert_rowid() AS last_row_id",
      )
      .get();
    return {
      results,
      meta: {
        duration: performance.now() - started,
        changes: meta?.changes ?? 0,
        last_row_id: meta?.last_row_id ?? 0,
        rows_read: results.length,
      },
    };
  };
  return {
    execute({ owner, key, path, name, msg }: D1Request): Frame {
      let entry = connections.get(key);
      if (!entry) {
        if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
        const db = new Database(path, { create: true });
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA synchronous = NORMAL");
        if (executionMs) {
          try {
            db.loadExtension(
              process.env.SPROUTBOAT_D1_BUDGET_EXTENSION || budgetExtension,
              "sqlite3_sproutbudget_init",
            );
            db.query("SELECT sb_sql_budget(?, ?)").get(capability, 0);
          } catch (error) {
            db.close();
            throw new Error(`SQL budget extension unavailable; run wire build:sql-budget: ${String(error)}`);
          }
        }
        entry = { db, owners: new Set() };
        connections.set(key, entry);
      }
      entry.owners.add(owner);
      const db = entry.db;
      const deadline = performance.now() + executionMs;
      const guard = executionMs ? db.query("SELECT sb_sql_budget(?, ?)") : null;
      guard?.get(capability, executionMs);
      const disarm = () => {
        try {
          guard?.get(capability, 0);
        } catch (error) {
          // The expired one-shot callback can interrupt the cleanup SELECT itself.
          if (error instanceof Error && "code" in error && error.code === "SQLITE_INTERRUPT") guard?.get(capability, 0);
          else throw error;
        }
      };
      try {
        switch (msg.op) {
          case "d1.query":
            return { ok: true, ...run(db, str(msg.sql), params(msg.params)) };
          case "d1.exec":
            db.exec(str(msg.sql));
            return { ok: true };
          case "d1.batch": {
            const statements = Array.isArray(msg.statements) ? msg.statements.map((s) => jsonObject(s) ?? {}) : [];
            return {
              ok: true,
              results: db.transaction(() =>
                statements.map((s) => {
                  if (executionMs && performance.now() >= deadline)
                    throw new Error("D1 execution deadline exceeded; batch rolled back");
                  return run(db, str(s.sql), params(s.params));
                }),
              )(),
            };
          }
          case "d1.backup": {
            if (path === ":memory:") throw new Error("d1 backup needs a file-backed database");
            const requested = str(msg.name);
            const file = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(requested)
              ? requested
              : `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`;
            const dir = join(dirname(dirname(resolve(path))), "backups");
            mkdirSync(dir, { recursive: true });
            const dest = join(dir, file);
            if (existsSync(dest)) rmSync(dest);
            try {
              db.run("VACUUM INTO ?", [dest]);
            } catch (error) {
              rmSync(dest, { force: true });
              throw error;
            }
            const copy = new Database(dest, { readonly: true });
            try {
              if (executionMs) {
                const remaining = Math.floor(deadline - performance.now());
                if (remaining <= 0) throw new Error("D1 execution deadline exceeded during backup");
                copy.loadExtension(
                  process.env.SPROUTBOAT_D1_BUDGET_EXTENSION || budgetExtension,
                  "sqlite3_sproutbudget_init",
                );
                copy.query("SELECT sb_sql_budget(?, ?)").get(capability, remaining);
              }
              if (
                copy.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !== "ok"
              ) {
                rmSync(dest, { force: true });
                throw new Error("integrity check failed on the backup");
              }
            } catch (error) {
              rmSync(dest, { force: true });
              throw error;
            } finally {
              copy.close();
            }
            return { ok: true, path: dest, bytes: statSync(dest).size };
          }
          default:
            throw new Error("unknown D1 operation");
        }
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "SQLITE_INTERRUPT")
          throw new Error(
            `D1 execution deadline exceeded; SQL was not retried${msg.op === "d1.exec" ? "; earlier exec statements may have committed" : ""}`,
          );
        throw error;
      } finally {
        disarm();
      }
    },
    release(owner: string) {
      for (const [key, entry] of connections) {
        entry.owners.delete(owner);
        if (!entry.owners.size) {
          entry.db.close();
          connections.delete(key);
        }
      }
    },
    close() {
      for (const entry of connections.values()) entry.db.close();
      connections.clear();
    },
  };
}
