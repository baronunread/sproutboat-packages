/** Build at package/image preparation time, never on a tenant request. */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
export const budgetExtension = resolve(
  import.meta.dir,
  `../native/d1-budget-${process.platform}-${process.arch}.${process.platform === "darwin" ? "dylib" : "so"}`,
);
if (import.meta.main) {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("SQL budget supports Linux and macOS");
  mkdirSync(dirname(budgetExtension), { recursive: true });
  const include =
    process.env.SQLITE_INCLUDE ||
    (process.platform === "darwin"
      ? ["/opt/homebrew/opt/sqlite/include", "/usr/local/opt/sqlite/include"].find((p) =>
          existsSync(`${p}/sqlite3ext.h`),
        )
      : undefined);
  const child = Bun.spawnSync(
    [
      process.env.CC || "cc",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-fPIC",
      ...(process.platform === "darwin" ? ["-dynamiclib"] : ["-shared"]),
      ...(include ? ["-I", include] : []),
      resolve(import.meta.dir, "d1-budget.c"),
      "-o",
      budgetExtension,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (child.exitCode !== 0)
    throw new Error("SQL budget extension build failed; install a C compiler and SQLite development headers");
  console.log(budgetExtension);
}
