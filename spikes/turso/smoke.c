#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
typedef struct sqlite3 sqlite3; typedef struct sqlite3_stmt sqlite3_stmt;
extern int sqlite3_open(const char*, sqlite3**);
extern int sqlite3_open_v2(const char*, sqlite3**, int, const char*);
extern int sqlite3_exec(sqlite3*, const char*, void*, void*, char**);
extern int sqlite3_prepare_v2(sqlite3*, const char*, int, sqlite3_stmt**, const char**);
extern int sqlite3_step(sqlite3_stmt*); extern int sqlite3_finalize(sqlite3_stmt*);
extern const unsigned char* sqlite3_column_text(sqlite3_stmt*, int);
extern int sqlite3_column_count(sqlite3_stmt*);
extern const char* sqlite3_errmsg(sqlite3*);
extern void sqlite3_progress_handler(sqlite3*, int, int(*)(void*), void*);
extern void sqlite3_interrupt(sqlite3*);
extern int sqlite3_close(sqlite3*);
static int calls = 0;
static int prog(void*p){ calls++; return calls > 3; }
static void run(sqlite3*db,const char*sql){
  char*err=0; int rc=sqlite3_exec(db,sql,0,0,&err);
  printf("%-60.60s rc=%d %s\n", sql, rc, rc? sqlite3_errmsg(db):"");
}
static void q(sqlite3*db,const char*sql){
  sqlite3_stmt*st=0; int rc=sqlite3_prepare_v2(db,sql,-1,&st,0);
  if(rc||!st){printf("%-60.60s prepare rc=%d %s\n",sql,rc,sqlite3_errmsg(db));return;}
  int n=sqlite3_column_count(st); int s; printf("%-60.60s ->",sql);
  while((s=sqlite3_step(st))==100){ for(int i=0;i<n;i++) printf(" %s",sqlite3_column_text(st,i)); printf(" |"); }
  printf(" step=%d %s\n", s, s!=101?sqlite3_errmsg(db):""); sqlite3_finalize(st);
}
int main(int argc,char**argv){
  const char*path=argv[1]; sqlite3*db=0;
  int rc=sqlite3_open(path,&db); printf("open rc=%d\n",rc);
  run(db,"PRAGMA journal_mode=WAL");
  q(db,"PRAGMA journal_mode");
  run(db,"PRAGMA synchronous=NORMAL");
  run(db,"PRAGMA busy_timeout=5000");
  run(db,"PRAGMA cache_size=-2000");
  run(db,"PRAGMA journal_size_limit=16777216");
  run(db,"PRAGMA foreign_keys=ON");
  run(db,"PRAGMA wal_autocheckpoint=0");
  q(db,"PRAGMA user_version");
  run(db,"CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, a TEXT, b REAL)");
  run(db,"INSERT INTO t(a,b) VALUES('x',1.5),('y',2)");
  q(db,"SELECT * FROM t");
  q(db,"SELECT sqlite_version()");
  q(db,"WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<2000000) SELECT count(*) FROM c");
  sqlite3_progress_handler(db,1000,prog,0);
  calls=0;
  q(db,"WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<2000000) SELECT count(*) FROM c");
  printf("progress calls=%d\n",calls);
  sqlite3_progress_handler(db,0,0,0);
  q(db,"SELECT count(*) FROM t");
  sqlite3_close(db);
  sqlite3*ro=0; rc=sqlite3_open_v2(path,&ro,1,0); printf("open ro rc=%d\n",rc);
  q(ro,"SELECT count(*) FROM t");
  run(ro,"INSERT INTO t(a) VALUES('z')");
  sqlite3_close(ro);
  return 0;
}
