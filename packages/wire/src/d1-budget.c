/* SQLite's public extension ABI. No Bun internals or additional database engine. */
#include <sqlite3ext.h>
#include <stdint.h>
#include <string.h>
#include <time.h>
SQLITE_EXTENSION_INIT1

typedef struct {
  char key[65];
  int initialized;
  int64_t deadline;
} Budget;

static int64_t now_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (int64_t)ts.tv_sec * 1000000000 + ts.tv_nsec;
}
static int progress(void *context) {
  Budget *budget = context;
  if (budget->deadline && now_ns() >= budget->deadline) {
    /* One-shot interruption lets SQLite and the host finish rollback/cleanup. */
    budget->deadline = 0;
    return 1;
  }
  return 0;
}
static void arm(sqlite3_context *context, int argc, sqlite3_value **argv) {
  Budget *budget = sqlite3_user_data(context);
  const unsigned char *key = argc == 2 ? sqlite3_value_text(argv[0]) : 0;
  if (!key || sqlite3_value_bytes(argv[0]) != 64) {
    sqlite3_result_error(context, "invalid budget capability", -1);
    return;
  }
  if (!budget->initialized) {
    memcpy(budget->key, key, 64);
    budget->initialized = 1;
  }
  unsigned char mismatch = 0;
  for (int i = 0; i < 64; i++) mismatch |= (unsigned char)budget->key[i] ^ key[i];
  if (mismatch) {
    sqlite3_result_error(context, "invalid budget capability", -1);
    return;
  }
  int ms = sqlite3_value_int(argv[1]);
  if (ms < 0 || ms > 30000) {
    sqlite3_result_error(context, "invalid SQL execution budget", -1);
    return;
  }
  budget->deadline = ms ? now_ns() + (int64_t)ms * 1000000 : 0;
  sqlite3_result_int(context, 1);
}
#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_sproutbudget_init(sqlite3 *db, char **error, const sqlite3_api_routines *api) {
  (void)error;
  SQLITE_EXTENSION_INIT2(api);
  Budget *budget = sqlite3_malloc(sizeof(Budget));
  if (!budget) return SQLITE_NOMEM;
  memset(budget, 0, sizeof(Budget));
  int rc = sqlite3_create_function_v2(db, "sb_sql_budget", 2,
    SQLITE_UTF8 | SQLITE_DIRECTONLY, budget, arm, 0, 0, sqlite3_free);
  if (rc != SQLITE_OK) return rc;
  sqlite3_progress_handler(db, 1000, progress, budget);
  return SQLITE_OK;
}
