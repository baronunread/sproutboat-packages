/** D1's synchronous storage contract, shared by dedicated and SQL-worker modes. */
import { budgetExtension } from "./build-d1-budget";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isBoolean, isString, jsonObject, type JsonObject, type JsonValue } from "./json";
import type { Frame } from "./broker";

const isNumber = (value: JsonValue): value is number => Number.isFinite(value);
type SqlParam = string | number | null | Uint8Array;
const str = (v: JsonValue | undefined) => (isString(v) ? v : String(v ?? ""));
// {"$blob":"HEX"} is the shim's encoding of bytes (an ArrayBuffer or a typed array).
const blobOf = (p: JsonValue): Uint8Array | undefined => {
  const o = jsonObject(p);
  return o && isString(o.$blob) ? Uint8Array.from(Buffer.from(o.$blob, "hex")) : undefined;
};
const params = (v: JsonValue | undefined): SqlParam[] =>
  Array.isArray(v)
    ? v.map((p) => (p === null || isNumber(p) || isString(p) ? p : isBoolean(p) ? Number(p) : (blobOf(p) ?? String(p))))
    : [];
// A BLOB read back: hex for strict calls (the shim makes it an array of byte values, as
// workerd does), one char per byte otherwise (what the embedded transport returns).
// SAFETY: bun:sqlite returns only null, numbers, strings, bigints (off by default) and
// Uint8Array for BLOBs; the Uint8Array case is converted here, the rest are JSON values.
type SqliteValue = JsonValue | Uint8Array | bigint;
// SAFETY: the two non-JSON cases (bytes, bigint) are converted first; what is left is a JSON value.
const cell = (v: SqliteValue, strict: boolean): JsonValue =>
  v instanceof Uint8Array
    ? strict
      ? { $blob: Buffer.from(v).toString("hex") }
      : String.fromCharCode(...v)
    : Object(v) instanceof BigInt
      ? Number(v)
      : (v as JsonValue);
type SqliteFailure = Error & { errno?: number; code?: string; byteOffset?: number };
const isSqliteFailure = (e: Error): e is SqliteFailure => "errno" in e;
const SQLITE_CODES = [
  "",
  "SQLITE_ERROR",
  "SQLITE_INTERNAL",
  "SQLITE_PERM",
  "SQLITE_ABORT",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_NOMEM",
  "SQLITE_READONLY",
  "SQLITE_INTERRUPT",
  "SQLITE_IOERR",
  "SQLITE_CORRUPT",
  "SQLITE_NOTFOUND",
  "SQLITE_FULL",
  "SQLITE_CANTOPEN",
  "SQLITE_PROTOCOL",
  "SQLITE_EMPTY",
  "SQLITE_SCHEMA",
  "SQLITE_TOOBIG",
  "SQLITE_CONSTRAINT",
  "SQLITE_MISMATCH",
  "SQLITE_MISUSE",
  "SQLITE_NOLFS",
  "SQLITE_AUTH",
  "SQLITE_FORMAT",
  "SQLITE_RANGE",
  "SQLITE_NOTADB",
];
/** D1's wording for a SQLite error, as the embedded transport words it for strict calls. */
export function d1Error(error: Error, byteOffset?: number): Error {
  if (!isSqliteFailure(error)) return error;
  let text = `D1_ERROR: ${error.message}`;
  const offset = byteOffset ?? error.byteOffset;
  if (Number.isInteger(offset) && Number(offset) >= 0) text += ` at offset ${offset}`;
  const base = SQLITE_CODES[(Number(error.errno) || 0) & 255];
  if (base) {
    text += `: ${base}`;
    if (base === "SQLITE_CONSTRAINT" && error.code && error.code !== base) text += ` (extended: ${error.code})`;
  }
  return new Error(text);
}
/**
 * Where, in a line of statements, the statement that fails at byte `offset` begins. bun:sqlite counts an
 * error's offset from the start of the whole string; D1 (SQLite's own exec loop) counts it from the first
 * non-space character of the failing statement. A `;` inside a quoted name or string or a comment does not
 * end a statement.
 */
export function statementStart(sql: Uint8Array, offset: number): number {
  const at = (i: number) => (i < sql.length ? sql[i] : 0);
  const space = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
  let start = 0;
  let i = 0;
  while (i < offset) {
    const c = sql[i];
    if (c === 59) {
      i++;
      while (space(at(i))) i++;
      if (i <= offset) start = i;
    } else if (c === 39 || c === 34 || c === 96 || c === 91) {
      const close = c === 91 ? 93 : c;
      i++;
      while (i < sql.length && sql[i] !== close) i++;
      i++;
    } else if (c === 45 && at(i + 1) === 45) {
      while (i < sql.length && sql[i] !== 10) i++;
    } else if (c === 47 && at(i + 1) === 42) {
      i += 2;
      while (i < sql.length && !(sql[i] === 42 && at(i + 1) === 47)) i++;
      i += 2;
    } else i++;
  }
  return start;
}
/** D1's text for the failure of one exec line (from 2026-11-03: with " at offset N: SQLITE_ERROR" and all). */
function execLineError(error: Error, line: string): string {
  const failure = error;
  if (!isSqliteFailure(failure)) return failure.message;
  const offset = Number(failure.byteOffset);
  const own =
    Number.isInteger(offset) && offset > 0
      ? offset - statementStart(new TextEncoder().encode(line), offset)
      : undefined;
  return d1Error(failure, own).message.replace(/^D1_ERROR: /, "");
}
export type D1Request = { owner: string; key: string; path: string; name: string; msg: Frame };

/** maxOpen > 0 (Durable Object SQL, one file per object): at most that many connections stay
 * open, and the one used longest ago is closed for a new one. A closed database reopens on
 * its next call. */
export function createD1Store(executionMs = 0, capability = "", maxOpen = 0) {
  if (executionMs && !/^[a-f0-9]{64}$/.test(capability)) throw new Error("invalid host budget capability");
  const connections = new Map<string, { db: Database; owners: Set<string> }>();
  // Strict calls (the shim's compatibility date 2026-10-24): the parameter count must match
  // and rows come back as arrays with their column names.
  // A read changes nothing: changes() still holds the last write's count, total_changes() does not move.
  const total = (db: Database) => db.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n ?? 0;
  const runStrict = (db: Database, sql: string, values: SqlParam[]) => {
    const started = performance.now();
    const before = total(db);
    let statement;
    try {
      statement = db.query<SqliteValue[], SqlParam[]>(sql);
    } catch (error) {
      throw d1Error(error instanceof Error ? error : new Error(String(error)));
    }
    if (statement.paramsCount !== values.length)
      throw new Error("D1_ERROR: Wrong number of parameter bindings for SQL query.");
    let rows: SqliteValue[][];
    try {
      rows = statement.values(...values) ?? [];
    } catch (error) {
      throw d1Error(error instanceof Error ? error : new Error(String(error)));
    }
    const meta = db
      .query<{ changes: number; last_row_id: number }, []>(
        "SELECT changes() AS changes, last_insert_rowid() AS last_row_id",
      )
      .get();
    return {
      columns: statement.columnNames,
      rows: rows.map((row) => row.map((v) => cell(v, true))),
      meta: {
        duration: performance.now() - started,
        changes: total(db) > before ? (meta?.changes ?? 0) : 0,
        last_row_id: meta?.last_row_id ?? 0,
        rows_read: rows.length,
      },
    };
  };
  const run = (db: Database, sql: string, values: SqlParam[]) => {
    const started = performance.now();
    const before = total(db);
    const results = db
      .query<JsonObject, SqlParam[]>(sql)
      .all(...values)
      .map((row) => {
        for (const k in row) row[k] = cell(row[k], false);
        return row;
      });
    const meta = db
      .query<{ changes: number; last_row_id: number }, []>(
        "SELECT changes() AS changes, last_insert_rowid() AS last_row_id",
      )
      .get();
    return {
      results,
      meta: {
        duration: performance.now() - started,
        changes: total(db) > before ? (meta?.changes ?? 0) : 0,
        last_row_id: meta?.last_row_id ?? 0,
        rows_read: results.length,
      },
    };
  };
  return {
    execute({ owner, key, path, name, msg }: D1Request): Frame {
      let entry = connections.get(key);
      if (entry && maxOpen) {
        // Most recently used last: Map iteration follows insertion order.
        connections.delete(key);
        connections.set(key, entry);
      }
      if (!entry && maxOpen && connections.size >= maxOpen) {
        const [oldest, old] = connections.entries().next().value ?? [];
        if (oldest !== undefined && old) {
          connections.delete(oldest);
          old.db.close();
        }
      }
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
        const strict = msg.strict === true;
        // Foreign keys are enforced from compatibility date 2026-10-24, as in D1. The
        // pragma is per connection and a no-op inside a transaction, so set it per call.
        if (msg.op !== "d1.backup") db.exec(strict ? "PRAGMA foreign_keys = ON" : "PRAGMA foreign_keys = OFF");
        const exec1 = strict ? runStrict : run;
        switch (msg.op) {
          case "d1.query":
            return { ok: true, ...exec1(db, str(msg.sql), params(msg.params)) };
          case "d1.exec": {
            const lines = Array.isArray(msg.lines) ? msg.lines.map(str) : null;
            if (!strict || !lines) {
              db.exec(str(msg.sql));
              return { ok: true };
            }
            // From 2026-10-24: line by line as workerd runs it, all or nothing.
            db.transaction(() =>
              lines.forEach((line, i) => {
                try {
                  db.exec(line);
                } catch (error) {
                  throw new Error(
                    `D1_EXEC_ERROR: Error in line ${i + 1}: ${line}: ${
                      msg.parity === true
                        ? execLineError(error instanceof Error ? error : new Error(String(error)), line)
                        : error instanceof Error
                          ? error.message
                          : String(error)
                    }`,
                  );
                }
              }),
            )();
            return { ok: true };
          }
          case "d1.batch": {
            const statements = Array.isArray(msg.statements) ? msg.statements.map((s) => jsonObject(s) ?? {}) : [];
            return {
              ok: true,
              results: db.transaction(() =>
                statements.map((s) => {
                  if (executionMs && performance.now() >= deadline)
                    throw new Error("D1 execution deadline exceeded; batch rolled back");
                  return exec1(db, str(s.sql), params(s.params));
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
