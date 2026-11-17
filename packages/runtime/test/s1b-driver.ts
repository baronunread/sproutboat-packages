import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The driver of design 029 stage S1b's tests: the exact inline C of the embedded transport (the LTX and handle-table
// regions), compiled against SQLite, taking one command per line on stdin (the handle table is process-global).
//
//   sql KIND NAME SQL        run SQL and the after-statement step, as the runtime does: "RC TEXT"
//   sqld KIND NAME SQL       the same with the commit held back (group commit): "D RC", an ack only after flush
//   flush                    the group flush: "0 flushed" (the ack of every sqld before it) or "-1 failed"
//   owed                     "1" when a commit is owed or uncaptured, else "0"
//   open / close KIND NAME   the handle table's open and close
//   state KIND NAME          JSON: txid, synced, frames, pending, offset, mode, epoch of the capture state
//   stats                    JSON counters (opens, syncs)
//   quit
// KIND is d1 NAME, store, do CLASS/HEX or vol, as in native-storage-s1.ts.
export type Driver = {
  send(line: string): Promise<string>;
  quit(): Promise<void>;
  kill(): Promise<void>;
  pid: number;
};

export async function buildDriver(work: string): Promise<string> {
  const transport = await readFile(new URL("../src/transport-embedded.js", import.meta.url), "utf8");
  const ltxStart = transport.indexOf("// BEGIN LTX NATIVE"),
    ltxEnd = transport.indexOf("// END LTX NATIVE", ltxStart);
  const tableStart = transport.indexOf("// BEGIN DB TABLE NATIVE"),
    tableEnd = transport.indexOf("// END DB TABLE NATIVE", tableStart);
  assert(ltxStart > 0 && ltxEnd > ltxStart && tableStart > ltxEnd && tableEnd > tableStart);
  const source = `
#define _GNU_SOURCE
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <time.h>
#include <errno.h>
#include <signal.h>
#define SB_MAX_DB 64
static sqlite3* sb_dbs[SB_MAX_DB];
static char sb_db_names[SB_MAX_DB][256];
static int sb_db_count = 0;
${transport.slice(ltxStart, ltxEnd)}
${transport.slice(tableStart, tableEnd)}
static char root[512];
static int path_of(char* out, const char* kind, const char* name) {
  if (!strcmp(kind, "d1")) return snprintf(out, 700, "%s/data/d1/%s.sqlite", root, name);
  if (!strcmp(kind, "store")) return snprintf(out, 700, "%s/data/store.sqlite", root);
  if (!strcmp(kind, "do")) return snprintf(out, 700, "%s/data/do-sql/%s.sqlite", root, name);
  return snprintf(out, 700, "%s/data/volatile.sqlite", root);
}
int main(int argc, char** argv) {
  snprintf(root, sizeof root, "%s", argv[1]);
  sb_ltx_compat = 1;
  char *line = 0; size_t cap = 0;
  setvbuf(stdout, 0, _IOLBF, 0);
  puts("ready");
  while (getline(&line, &cap, stdin) > 0) {
    line[strcspn(line, "\\n")] = 0;
    char cmd[16] = "", kind[8] = "", name[200] = "", p[800];
    int n = 0;
    sscanf(line, "%15s %7s %199s%n", cmd, kind, name, &n);
    const char* rest = line + n; if (*rest == ' ') rest++;
    if (!strcmp(cmd, "quit")) break;
    if (!strcmp(cmd, "flush")) { printf("%d %s\\n", sb_ltx_group('f'), "flushed"); continue; }
    if (!strcmp(cmd, "owed")) { printf("%d\\n", sb_ltx_group('o')); continue; }
    if (!strcmp(cmd, "stats")) {
      printf("{\\"fresh\\":%lu,\\"cheap\\":%lu,\\"full\\":%lu,\\"resume\\":%lu,\\"open\\":%d,\\"vfsSyncs\\":%lu,\\"deferredSyncs\\":%lu,\\"fsyncs\\":%lu,\\"flushes\\":%lu}\\n",
             sb_ltx_stat_fresh, sb_ltx_stat_cheap, sb_ltx_stat_full, sb_ltx_stat_resume, sb_open_dbs(),
             sb_ltx_stat_vfs_syncs, sb_ltx_stat_deferred_syncs, sb_ltx_stat_fsyncs, sb_ltx_stat_flushes);
      continue;
    }
    path_of(p, kind, name);
    if (!strcmp(cmd, "open")) {
      struct timespec a, b; clock_gettime(CLOCK_MONOTONIC, &a);
      int idx = sb_db_for(p);
      clock_gettime(CLOCK_MONOTONIC, &b);
      printf("%d %ld\\n", idx, (long)((b.tv_sec - a.tv_sec) * 1000 + (b.tv_nsec - a.tv_nsec) / 1000000));
      continue;
    }
    if (!strcmp(cmd, "close")) { printf("%d\\n", sb_db_close_path(p)); continue; }
    if (!strcmp(cmd, "state")) {
      int idx = sb_db_for(p);
      if (idx < 0) { puts("{}"); continue; }
      sb_ltx_state* s = &sb_ltx_states[idx];
      printf("{\\"txid\\":%llu,\\"synced\\":%llu,\\"frames\\":%u,\\"pending\\":%u,\\"offset\\":%llu,\\"mode\\":\\"%c\\",\\"epoch\\":\\"%s\\",\\"failed\\":%d}\\n",
             (unsigned long long)s->txid, (unsigned long long)s->synced_txid, s->frames_seen, s->pending_frames,
             (unsigned long long)s->offset, s->checkpointed ? 'C' : 'W', s->epoch, s->failed);
      continue;
    }
    if (!strcmp(cmd, "sql") || !strcmp(cmd, "sqld")) {
      int deferred = cmd[3] == 'd';
      int idx = sb_db_for(p);
      if (idx < 0) { printf("-1 cannot open\\n"); continue; }
      char* err = 0;
      if (deferred) sb_ltx_group('d');
      int rc = sb_ltx_states[idx].failed ? 10 : sqlite3_exec(sb_dbs[idx], rest, 0, 0, &err);
      if (sb_ltx_after(idx)) rc = 10;
      if (deferred) sb_ltx_group('n');
      if (deferred) printf("D %d\\n", rc);
      else printf("%d %s\\n", rc, err ? err : "ok");
      sqlite3_free(err);
      continue;
    }
    printf("?\\n");
  }
  return 0;
}
`;
  await writeFile(join(work, "driver.c"), source);
  const binary = join(work, "driver");
  const amalgamation = process.env.SB_TEST_SQLITE_DIR;
  const compile = Bun.spawnSync(
    amalgamation
      ? [
          "cc",
          "-O2",
          `-I${amalgamation}`,
          join(work, "driver.c"),
          join(amalgamation, "sqlite3.o"),
          "-lm",
          "-ldl",
          "-lpthread",
          "-o",
          binary,
        ]
      : ["cc", "-O1", join(work, "driver.c"), "-lsqlite3", "-o", binary],
  );
  assert.equal(compile.exitCode, 0, compile.stderr.toString());
  return binary;
}

export const baseEnv = {
  SB_LTX_ENABLE: "1",
  SB_LTX_SCOPE: "d1,store,do-sql",
  SB_OWNER_LOCK: "1",
};

export async function spawnDriver(
  binary: string,
  dir: string,
  env: Record<string, string> = {},
  wrap: string[] = [],
): Promise<Driver> {
  const child = Bun.spawn([...wrap, binary, dir], {
    env: {
      PATH: process.env.PATH ?? "",
      SB_LTX_ROOT: join(dir, "spool"),
      SB_DATA_DIR: join(dir, "data"),
      ...baseEnv,
      ...env,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  let buffer = "";
  async function line(): Promise<string> {
    while (!buffer.includes("\n")) {
      const r = await reader.read();
      if (r.done) throw new Error("driver exited: " + (await new Response(child.stderr).text()));
      buffer += new TextDecoder().decode(r.value);
    }
    const i = buffer.indexOf("\n");
    const out = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    return out;
  }
  assert.equal(await line(), "ready");
  return {
    pid: child.pid,
    async send(text: string) {
      child.stdin.write(text + "\n");
      child.stdin.flush();
      return line();
    },
    async quit() {
      child.stdin.write("quit\n");
      child.stdin.end();
      await child.exited;
    },
    async kill() {
      child.kill("SIGKILL");
      await child.exited;
    },
  };
}
