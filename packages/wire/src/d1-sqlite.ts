/** Bun shares its SQLite library across threads: select it before any DB opens. */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
export function configureBudgetSQLite() {
  if (process.platform !== "darwin") return;
  const library =
    process.env.SPROUTBOAT_D1_SQLITE_LIBRARY ||
    ["/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", "/usr/local/opt/sqlite/lib/libsqlite3.dylib"].find(existsSync);
  if (!library)
    throw new Error("Shared SQL budgets need extension-capable SQLite on macOS; set SPROUTBOAT_D1_SQLITE_LIBRARY");
  Database.setCustomSQLite(library);
}
// Also used as the package test preload, before dedicated-broker tests open DBs.
configureBudgetSQLite();
