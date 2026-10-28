#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
typedef struct sqlite3 sqlite3; typedef struct sqlite3_stmt sqlite3_stmt;
extern int sqlite3_open(const char*, sqlite3**);
extern int sqlite3_exec(sqlite3*, const char*, void*, void*, char**);
extern int sqlite3_prepare_v2(sqlite3*, const char*, int, sqlite3_stmt**, const char**);
extern int sqlite3_step(sqlite3_stmt*); extern int sqlite3_finalize(sqlite3_stmt*);
extern int sqlite3_reset(sqlite3_stmt*); extern int sqlite3_bind_int64(sqlite3_stmt*,int,long long);
extern int sqlite3_bind_text(sqlite3_stmt*,int,const char*,int,void*);
extern const unsigned char* sqlite3_column_text(sqlite3_stmt*, int);
extern const char* sqlite3_errmsg(sqlite3*);
static double now(void){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return t.tv_sec+t.tv_nsec*1e-9;}
static double cpu(void){struct timespec t;clock_gettime(CLOCK_PROCESS_CPUTIME_ID,&t);return t.tv_sec+t.tv_nsec*1e-9;}
int main(int argc,char**argv){
  const char*path=argv[1], *mode=argv[2], *begin=argv[3]; int n=atoi(argv[4]);
  sqlite3*db; sqlite3_open(path,&db);
  char sql[128]; snprintf(sql,128,"PRAGMA journal_mode=%s",mode);
  sqlite3_stmt*st; sqlite3_prepare_v2(db,sql,-1,&st,0); sqlite3_step(st); printf("journal_mode=%s ",sqlite3_column_text(st,0)); sqlite3_finalize(st);
  sqlite3_exec(db,"PRAGMA synchronous=NORMAL",0,0,0);
  int rc=sqlite3_exec(db,"CREATE TABLE IF NOT EXISTS p(id INTEGER PRIMARY KEY, u INT, b TEXT, c TEXT DEFAULT CURRENT_TIMESTAMP)",0,0,0); if(rc) printf("create rc=%d %s\n",rc,sqlite3_errmsg(db));
  sqlite3_exec(db,"CREATE INDEX IF NOT EXISTS pi ON p(c,id)",0,0,0);
  sqlite3_stmt*ins; rc=sqlite3_prepare_v2(db,"INSERT INTO p(u,b) VALUES(?,?) RETURNING id,c",-1,&ins,0); if(rc){printf("prep rc=%d %s\n",rc,sqlite3_errmsg(db));return 1;}
  double t0=now(),c0=cpu(); int bad=0;
  for(int i=0;i<n;i++){
    if(begin[0]) { rc=sqlite3_exec(db,begin,0,0,0); if(rc){bad++; if(bad==1)printf("begin rc=%d %s\n",rc,sqlite3_errmsg(db)); continue;} }
    sqlite3_reset(ins); sqlite3_bind_int64(ins,1,i); sqlite3_bind_text(ins,2,"hello world post body text",-1,(void*)-1);
    rc=sqlite3_step(ins); while(rc==100) rc=sqlite3_step(ins);
    if(rc!=101){bad++; if(bad==1)printf("step rc=%d %s\n",rc,sqlite3_errmsg(db));}
    if(begin[0]) sqlite3_exec(db,"COMMIT",0,0,0);
  }
  double t1=now(),c1=cpu();
  printf("n=%d bad=%d wall_us/op=%.1f cpu_us/op=%.1f\n",n,bad,(t1-t0)*1e6/n,(c1-c0)*1e6/n);
  return 0;
}
