/**
 * The embedded transport: SQLite compiled into the sprout, no broker at all.
 *
 * Same contract as transport-broker.js — `__sbCall(reqJson) -> replyJson` — so
 * every binding shim above it is unchanged and the conformance suite is the
 * proof that the swap changed no behaviour.
 *
 * The split is deliberate: C does only what JS cannot (open a database, bind
 * parameters, step a statement, encode a row), and every op — which SQL, which
 * partition key, what shape comes back — stays in JS, mirroring broker.ts. That
 * keeps the second implementation of the binding ops as small as it can be,
 * which is the whole worry with having one at all.
 *
 * Paths come from __sbEnv: the launcher-free binary is told its data directory
 * through SB_DATA_DIR, the same way it learns its port.
 */

// oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
Porffor.c`
#include <stdint.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <netdb.h>
#include <arpa/inet.h>
#include <string.h>
#include <strings.h>
#include <sys/time.h>
#include <pthread.h>
#include <bearssl.h>

// sqlite3 is linked in via SB_EXTRA_LINK (see patch-porffor.ts). Declared here
// rather than including sqlite3.h so the build needs no include path.
typedef struct sqlite3 sqlite3;
typedef struct sqlite3_stmt sqlite3_stmt;
extern int sqlite3_open(const char*, sqlite3**);
extern int sqlite3_exec(sqlite3*, const char*, void*, void*, char**);
extern int sqlite3_prepare_v2(sqlite3*, const char*, int, sqlite3_stmt**, const char**);
extern int sqlite3_step(sqlite3_stmt*);
extern int sqlite3_finalize(sqlite3_stmt*);
extern int sqlite3_reset(sqlite3_stmt*);
extern int sqlite3_clear_bindings(sqlite3_stmt*);
extern int sqlite3_column_count(sqlite3_stmt*);
extern int sqlite3_column_type(sqlite3_stmt*, int);
extern const unsigned char* sqlite3_column_text(sqlite3_stmt*, int);
extern int sqlite3_column_bytes(sqlite3_stmt*, int);
extern double sqlite3_column_double(sqlite3_stmt*, int);
extern int sqlite3_column_int(sqlite3_stmt*, int);
extern int64_t sqlite3_column_int64(sqlite3_stmt*, int);
extern const char* sqlite3_column_name(sqlite3_stmt*, int);
extern int sqlite3_bind_null(sqlite3_stmt*, int);
extern int sqlite3_bind_double(sqlite3_stmt*, int, double);
extern int sqlite3_bind_text(sqlite3_stmt*, int, const char*, int, void*);
extern int sqlite3_bind_blob(sqlite3_stmt*, int, const void*, int, void*);
extern int sqlite3_bind_int64(sqlite3_stmt*, int, int64_t);
extern const void* sqlite3_column_blob(sqlite3_stmt*, int);
extern int sqlite3_changes(sqlite3*);
extern int64_t sqlite3_last_insert_rowid(sqlite3*);
extern const char* sqlite3_errmsg(sqlite3*);
extern int sqlite3_close(sqlite3*);
extern int sqlite3_bind_parameter_count(sqlite3_stmt*);
extern int sqlite3_stmt_readonly(sqlite3_stmt*);
extern int sqlite3_extended_errcode(sqlite3*);
extern int sqlite3_error_offset(sqlite3*);
extern const char* sqlite3_sql(sqlite3_stmt*);
extern int sqlite3_total_changes(sqlite3*);

// baronunread/sproutboat#176 — defined in render.js, alongside
// porf_native_fetch_read_value (which every inline-C block below already
// calls with no forward declaration of its own — that one gets one from
// Porffor's own generated prototypes, this one doesn't, since it's a local
// patch addition, not something Porffor knows to prototype early).
extern int porf_native_fetch_read_raw_bytes(jsval value, const char** out_buf, size_t* out_len);

#define SB_SQLITE_ROW 100
#define SB_SQLITE_DONE 101
#define SB_SQLITE_TRANSIENT ((void*)-1)
// SQLITE_STATIC: "this buffer is yours to read and outlives the statement".
// Worth using for an object body — the alternative is sqlite copying it.
#define SB_SQLITE_STATIC ((void*)0)
#define SB_MAX_DB 16

static sqlite3* sb_dbs[SB_MAX_DB];
static char sb_db_names[SB_MAX_DB][256];
static int sb_db_count = 0;

// BEGIN LTX NATIVE: also compiled directly by the replication regression.
#include <dirent.h>
#include <errno.h>
#include <limits.h>
#include <sys/file.h>

// Public SQLite VFS ABI, from sqlite3.h (public domain). Keeping declarations
// here preserves standalone builds without an installed SQLite development SDK.
#ifndef SQLITE3_H
#ifndef _SQLITE3_H_
typedef long long sqlite3_int64;
typedef struct sqlite3_file sqlite3_file;
typedef struct sqlite3_io_methods sqlite3_io_methods;
typedef struct sqlite3_vfs sqlite3_vfs;
struct sqlite3_file {
  const sqlite3_io_methods *pMethods;
};
struct sqlite3_io_methods {
  int iVersion;
  int (*xClose)(sqlite3_file *);
  int (*xRead)(sqlite3_file *, void *, int, sqlite3_int64);
  int (*xWrite)(sqlite3_file *, const void *, int, sqlite3_int64);
  int (*xTruncate)(sqlite3_file *, sqlite3_int64);
  int (*xSync)(sqlite3_file *, int);
  int (*xFileSize)(sqlite3_file *, sqlite3_int64 *);
  int (*xLock)(sqlite3_file *, int);
  int (*xUnlock)(sqlite3_file *, int);
  int (*xCheckReservedLock)(sqlite3_file *, int *);
  int (*xFileControl)(sqlite3_file *, int, void *);
  int (*xSectorSize)(sqlite3_file *);
  int (*xDeviceCharacteristics)(sqlite3_file *);
  int (*xShmMap)(sqlite3_file *, int, int, int, void volatile **);
  int (*xShmLock)(sqlite3_file *, int, int, int);
  void (*xShmBarrier)(sqlite3_file *);
  int (*xShmUnmap)(sqlite3_file *, int);
  int (*xFetch)(sqlite3_file *, sqlite3_int64, int, void **);
  int (*xUnfetch)(sqlite3_file *, sqlite3_int64, void *);
};
struct sqlite3_vfs {
  int iVersion, szOsFile, mxPathname;
  sqlite3_vfs *pNext;
  const char *zName;
  void *pAppData;
  int (*xOpen)(sqlite3_vfs *, const char *, sqlite3_file *, int, int *);
  int (*xDelete)(sqlite3_vfs *, const char *, int);
  int (*xAccess)(sqlite3_vfs *, const char *, int, int *);
  int (*xFullPathname)(sqlite3_vfs *, const char *, int, char *);
  void *(*xDlOpen)(sqlite3_vfs *, const char *);
  void (*xDlError)(sqlite3_vfs *, int, char *);
  void (*(*xDlSym)(sqlite3_vfs *, void *, const char *))(void);
  void (*xDlClose)(sqlite3_vfs *, void *);
  int (*xRandomness)(sqlite3_vfs *, int, char *);
  int (*xSleep)(sqlite3_vfs *, int);
  int (*xCurrentTime)(sqlite3_vfs *, double *);
  int (*xGetLastError)(sqlite3_vfs *, int, char *);
  int (*xCurrentTimeInt64)(sqlite3_vfs *, sqlite3_int64 *);
  int (*xSetSystemCall)(sqlite3_vfs *, const char *, void (*)(void));
  void (*(*xGetSystemCall)(sqlite3_vfs *, const char *))(void);
  const char *(*xNextSystemCall)(sqlite3_vfs *, const char *);
};
#endif
#endif
extern sqlite3_vfs *sqlite3_vfs_find(const char *);
extern int sqlite3_vfs_register(sqlite3_vfs *, int);
extern int sqlite3_open_v2(const char *, sqlite3 **, int, const char *);
extern void *sqlite3_wal_hook(sqlite3 *, int (*)(void *, sqlite3 *, const char *, int), void *);
extern int sqlite3_wal_checkpoint_v2(sqlite3 *, const char *, int, int *, int *);
extern int sqlite3_set_authorizer(sqlite3 *,
                                  int (*)(void *, int, const char *, const char *, const char *,
                                          const char *),
                                  void *);

#define SB_LTX_FLAG UINT64_C(0x8000000000000000)
#define SB_LTX_PATH 1024
static int sb_ltx_compat = 0;
static uint64_t sb_ltx_max_bytes = 16777216;
static sqlite3_vfs sb_ltx_vfs, *sb_ltx_parent;
typedef struct {
  sqlite3_file base;
  sqlite3_file *real;
  int wal;
} sb_ltx_file;
static sqlite3_file *sb_ltx_real(sqlite3_file *f) { return ((sb_ltx_file *)f)->real; }
static int sb_ltx_vclose(sqlite3_file *f) {
  sqlite3_file *r = sb_ltx_real(f);
  return r->pMethods->xClose(r);
}
static int sb_ltx_vread(sqlite3_file *f, void *b, int n, sqlite3_int64 o) {
  sqlite3_file *r = sb_ltx_real(f);
  return r->pMethods->xRead(r, b, n, o);
}
static int sb_ltx_vwrite(sqlite3_file *f, const void *b, int n, sqlite3_int64 o) {
  if (((sb_ltx_file *)f)->wal && (o < 0 || n < 0 || (uint64_t)o > sb_ltx_max_bytes ||
                                  (uint64_t)n > sb_ltx_max_bytes - (uint64_t)o))
    return 13; // SQLITE_FULL, before writing.
  sqlite3_file *r = sb_ltx_real(f);
  return r->pMethods->xWrite(r, b, n, o);
}
static int sb_ltx_vtruncate(sqlite3_file *f, sqlite3_int64 n) {
  sqlite3_file *r = sb_ltx_real(f);
  if (((sb_ltx_file *)f)->wal && (uint64_t)n > sb_ltx_max_bytes)
    return 13;
  return r->pMethods->xTruncate(r, n);
}
static int sb_ltx_vsync(sqlite3_file *f, int n) {
  sqlite3_file *r = sb_ltx_real(f);
  return r->pMethods->xSync(r, n);
}
static int sb_ltx_vsize(sqlite3_file *f, sqlite3_int64 *n) {
  sqlite3_file *r = sb_ltx_real(f);
  return r->pMethods->xFileSize(r, n);
}
static int sb_ltx_vlock(sqlite3_file *f, int n) {
  sqlite3_file *r = sb_ltx_real(f);
  return r->pMethods->xLock(r, n);
}
static int sb_ltx_vunlock(sqlite3_file *f, int n) {
  sqlite3_file *r = sb_ltx_real(f);
  return r->pMethods->xUnlock(r, n);
}
static int sb_ltx_vreserved(sqlite3_file *f, int *n) {
  sqlite3_file *r = sb_ltx_real(f);
  return r->pMethods->xCheckReservedLock(r, n);
}
static int sb_ltx_vcontrol(sqlite3_file *f, int n, void *p) {
  sqlite3_file *r = sb_ltx_real(f);
  if (((sb_ltx_file *)f)->wal) {
    // SIZE_HINT can preallocate inside the parent VFS, bypassing xWrite and
    // xTruncate. Ignore hints beyond the ceiling and disable chunk rounding.
    if (n == 5 && (*(sqlite3_int64 *)p < 0 || (uint64_t)*(sqlite3_int64 *)p > sb_ltx_max_bytes))
      return 0;
    if (n == 6) {
      int zero = 0;
      return r->pMethods->xFileControl(r, n, &zero);
    }
  }
  return r->pMethods->xFileControl(r, n, p);
}
static int sb_ltx_vsector(sqlite3_file *f) {
  sqlite3_file *r = sb_ltx_real(f);
  return r->pMethods->xSectorSize(r);
}
static int sb_ltx_vdevice(sqlite3_file *f) {
  sqlite3_file *r = sb_ltx_real(f);
  return r->pMethods->xDeviceCharacteristics(r);
}
static int sb_ltx_vmap(sqlite3_file *f, int p, int n, int w, void volatile **o) {
  sqlite3_file *r = sb_ltx_real(f);
  return r->pMethods->xShmMap(r, p, n, w, o);
}
static int sb_ltx_vshmlock(sqlite3_file *f, int o, int n, int v) {
  sqlite3_file *r = sb_ltx_real(f);
  return r->pMethods->xShmLock(r, o, n, v);
}
static void sb_ltx_vbarrier(sqlite3_file *f) {
  sqlite3_file *r = sb_ltx_real(f);
  r->pMethods->xShmBarrier(r);
}
static int sb_ltx_vunmap(sqlite3_file *f, int n) {
  sqlite3_file *r = sb_ltx_real(f);
  return r->pMethods->xShmUnmap(r, n);
}
// No mmap: bounds and RSS apply to reads as well as writes.
static int sb_ltx_vfetch(sqlite3_file *f, sqlite3_int64 o, int n, void **p) {
  (void)f;
  (void)o;
  (void)n;
  *p = 0;
  return 0;
}
static int sb_ltx_vunfetch(sqlite3_file *f, sqlite3_int64 o, void *p) {
  (void)f;
  (void)o;
  (void)p;
  return 0;
}
static const sqlite3_io_methods sb_ltx_methods = {3,
                                                  sb_ltx_vclose,
                                                  sb_ltx_vread,
                                                  sb_ltx_vwrite,
                                                  sb_ltx_vtruncate,
                                                  sb_ltx_vsync,
                                                  sb_ltx_vsize,
                                                  sb_ltx_vlock,
                                                  sb_ltx_vunlock,
                                                  sb_ltx_vreserved,
                                                  sb_ltx_vcontrol,
                                                  sb_ltx_vsector,
                                                  sb_ltx_vdevice,
                                                  sb_ltx_vmap,
                                                  sb_ltx_vshmlock,
                                                  sb_ltx_vbarrier,
                                                  sb_ltx_vunmap,
                                                  sb_ltx_vfetch,
                                                  sb_ltx_vunfetch};
static int sb_ltx_vopen(sqlite3_vfs *v, const char *name, sqlite3_file *f, int flags, int *out) {
  (void)v;
  sb_ltx_file *w = (sb_ltx_file *)f;
  memset(w, 0, sizeof(*w));
  w->real = (sqlite3_file *)((char *)f + sizeof(*w));
  w->wal = (flags & 0x80000) != 0;
  int rc = sb_ltx_parent->xOpen(sb_ltx_parent, name, w->real, flags, out);
  if (!rc)
    w->base.pMethods = &sb_ltx_methods;
  return rc;
}
static int sb_ltx_register(void) {
  if (sb_ltx_parent)
    return 0;
  const char *n = getenv("SB_LTX_MAX_WAL_BYTES");
  if (n && *n) {
    char *end = 0;
    unsigned long long value = strtoull(n, &end, 10);
    if (*end || value < 131072 || value > 1073741824)
      return -1;
    sb_ltx_max_bytes = value;
  }
  sb_ltx_parent = sqlite3_vfs_find(0);
  if (!sb_ltx_parent)
    return -1;
  sb_ltx_vfs = *sb_ltx_parent;
  sb_ltx_vfs.zName = "sb-ltx-bounded";
  sb_ltx_vfs.pNext = 0;
  sb_ltx_vfs.szOsFile += (int)sizeof(sb_ltx_file);
  sb_ltx_vfs.xOpen = sb_ltx_vopen;
  return sqlite3_vfs_register(&sb_ltx_vfs, 0);
}

typedef struct {
  sqlite3 *db;
  char path[SB_LTX_PATH], root[SB_LTX_PATH], epoch[64];
  int lock, failed, read_fd, checkpointed;
  uint32_t page_size, commit, salt1, salt2, wal_c1, wal_c2;
  uint64_t txid, offset, checksum;
} sb_ltx_state;
static sb_ltx_state sb_ltx_states[SB_MAX_DB];
static uint64_t sb_ltx_crc_table[256];
static int sb_ltx_crc_ready;
static uint32_t sb_ltx_be32(const unsigned char *p) {
  return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3];
}
static void sb_ltx_put32(unsigned char *p, uint32_t v) {
  for (int i = 3; i >= 0; i--) {
    p[i] = (unsigned char)v;
    v >>= 8;
  }
}
static void sb_ltx_put64(unsigned char *p, uint64_t v) {
  for (int i = 7; i >= 0; i--) {
    p[i] = (unsigned char)v;
    v >>= 8;
  }
}
static uint64_t sb_ltx_crc(uint64_t crc, const void *buf, size_t n) {
  if (!sb_ltx_crc_ready) {
    for (int i = 0; i < 256; i++) {
      uint64_t c = i;
      for (int j = 0; j < 8; j++)
        c = (c >> 1) ^ ((c & 1) ? UINT64_C(0xd800000000000000) : 0);
      sb_ltx_crc_table[i] = c;
    }
    sb_ltx_crc_ready = 1;
  }
  const unsigned char *p = buf;
  while (n--)
    crc = sb_ltx_crc_table[(crc ^ *p++) & 255] ^ (crc >> 8);
  return crc;
}
static uint64_t sb_ltx_page_crc(uint32_t pgno, const void *page, uint32_t size) {
  unsigned char b[4];
  sb_ltx_put32(b, pgno);
  return SB_LTX_FLAG | ~sb_ltx_crc(sb_ltx_crc(UINT64_MAX, b, 4), page, size);
}
static int sb_ltx_read(int fd, void *buf, size_t n, uint64_t offset) {
  size_t done = 0;
  while (done < n) {
    ssize_t r = pread(fd, (char *)buf + done, n - done, (off_t)(offset + done));
    if (r < 0 && errno == EINTR)
      continue;
    if (r <= 0)
      return -1;
    done += (size_t)r;
  }
  return 0;
}
static int sb_ltx_sync_dir(const char *path) {
  int fd = open(path, O_RDONLY | O_DIRECTORY);
  if (fd < 0)
    return -1;
  int rc = fsync(fd);
  if (close(fd) && !rc)
    rc = -1;
  return rc;
}
static int sb_ltx_flush(FILE *f) { return fflush(f) || fsync(fileno(f)) ? -1 : 0; }
#ifdef SB_LTX_TESTING
static int sb_ltx_test_armed, sb_ltx_test_commits;
static void sb_ltx_phase(const char *phase) {
  const char *p = getenv("SB_LTX_TEST_STOP");
  if (sb_ltx_test_armed && p && strcmp(p, phase) == 0 &&
      sb_ltx_test_commits ==
          atoi(getenv("SB_LTX_TEST_COMMIT") ? getenv("SB_LTX_TEST_COMMIT") : "1"))
    raise(SIGSTOP);
}
#else
static void sb_ltx_phase(const char *phase) { (void)phase; }
#endif

typedef struct {
  FILE *out, *index;
  uint64_t hash, n, index_n;
  uint32_t page_size;
} sb_ltx_writer;
static int sb_ltx_write(sb_ltx_writer *w, const void *buf, size_t n, int hash) {
  if (fwrite(buf, 1, n, w->out) != n)
    return -1;
  if (hash)
    w->hash = sb_ltx_crc(w->hash, buf, n);
  w->n += n;
  return 0;
}
static int sb_ltx_varint(FILE *f, uint64_t v, uint64_t *n) {
  do {
    unsigned char b = (unsigned char)(v & 127);
    v >>= 7;
    if (v)
      b |= 128;
    if (fwrite(&b, 1, 1, f) != 1)
      return -1;
    (*n)++;
  } while (v);
  return 0;
}
static int sb_ltx_begin(sb_ltx_writer *w, const char *path, sb_ltx_state *s, uint32_t commit,
                        int snapshot, uint64_t wal_size) {
  memset(w, 0, sizeof(*w));
  w->hash = UINT64_MAX;
  w->page_size = s->page_size;
  // Global temporary directories are outside a sandboxed worker's writable tree.
  // After unlink, close (including process death) reclaims the scratch file.
  char index_path[SB_LTX_PATH];
  if (snprintf(index_path, sizeof(index_path), "%s/index-XXXXXX", s->root) >= sizeof(index_path))
    return -1;
  int index = mkstemp(index_path);
  if (index < 0)
    return -1;
  sb_ltx_phase("index-created");
  if (unlink(index_path)) {
    close(index);
    return -1;
  }
  w->index = fdopen(index, "w+b");
  if (!w->index) {
    close(index);
    return -1;
  }
  w->out = fopen(path, "wbx");
  if (!w->out)
    return -1;
  unsigned char h[100] = {0};
  memcpy(h, "LTX1", 4);
  sb_ltx_put32(h + 8, s->page_size);
  sb_ltx_put32(h + 12, commit);
  sb_ltx_put64(h + 16, snapshot ? 1 : s->txid + 1);
  sb_ltx_put64(h + 24, snapshot ? 1 : s->txid + 1);
  sb_ltx_put64(h + 32, (uint64_t)time(0) * 1000);
  sb_ltx_put64(h + 40, snapshot ? 0 : s->checksum);
  if (!snapshot) {
    sb_ltx_put64(h + 48, s->offset ? s->offset : 32);
    sb_ltx_put64(h + 56, wal_size);
    sb_ltx_put32(h + 64, s->salt1);
    sb_ltx_put32(h + 68, s->salt2);
  }
  return sb_ltx_write(w, h, sizeof(h), 1);
}
// Literal-only LZ4 blocks: bounded, interoperable, no compression library.
// Compression can be added after crash qualification without changing the format.
static int sb_ltx_page(sb_ltx_writer *w, uint32_t pgno, const unsigned char *page) {
  uint64_t offset = w->n;
  unsigned char hdr[10] = {0};
  sb_ltx_put32(hdr, pgno);
  hdr[5] = 1;
  uint32_t extra = (w->page_size - 15) / 255 + 1, size = 1 + extra + w->page_size;
  sb_ltx_put32(hdr + 6, size);
  if (sb_ltx_write(w, hdr, 10, 1))
    return -1;
  unsigned char literal = 0xf0;
  if (sb_ltx_write(w, &literal, 1, 0))
    return -1;
  uint32_t remaining = w->page_size - 15;
  while (remaining >= 255) {
    literal = 255;
    if (sb_ltx_write(w, &literal, 1, 0))
      return -1;
    remaining -= 255;
  }
  literal = (unsigned char)remaining;
  if (sb_ltx_write(w, &literal, 1, 0) || sb_ltx_write(w, page, w->page_size, 0))
    return -1;
  w->hash = sb_ltx_crc(w->hash, page, w->page_size);
  return sb_ltx_varint(w->index, pgno, &w->index_n) ||
                 sb_ltx_varint(w->index, offset, &w->index_n) ||
                 sb_ltx_varint(w->index, w->n - offset, &w->index_n)
             ? -1
             : 0;
}
static int sb_ltx_finish(sb_ltx_writer *w, uint64_t checksum) {
  unsigned char zero[6] = {0}, buf[65536];
  if (sb_ltx_write(w, zero, 6, 1) || fflush(w->index))
    return -1;
  rewind(w->index);
  size_t n;
  while ((n = fread(buf, 1, sizeof(buf), w->index)))
    if (sb_ltx_write(w, buf, n, 1))
      return -1;
  if (ferror(w->index) || sb_ltx_write(w, zero, 1, 1))
    return -1;
  sb_ltx_put64(buf, w->index_n + 1);
  if (sb_ltx_write(w, buf, 8, 1))
    return -1;
  sb_ltx_put64(buf, checksum);
  if (sb_ltx_write(w, buf, 8, 1))
    return -1;
  sb_ltx_put64(buf, SB_LTX_FLAG | ~w->hash);
  if (sb_ltx_write(w, buf, 8, 0))
    return -1;
  sb_ltx_phase("ltx-written");
  if (sb_ltx_flush(w->out))
    return -1;
  sb_ltx_phase("ltx-fsynced");
  return 0;
}
static void sb_ltx_writer_close(sb_ltx_writer *w) {
  if (w->out)
    fclose(w->out);
  if (w->index)
    fclose(w->index);
}
static int sb_ltx_names(sb_ltx_state *s, uint64_t txid, char *tmp, char *final, char *dir) {
  if (snprintf(dir, SB_LTX_PATH, "%s/%s", s->root, s->epoch) >= SB_LTX_PATH)
    return -1;
  if (snprintf(final, SB_LTX_PATH, "%s/%016llx-%016llx.ltx", dir, (unsigned long long)txid,
               (unsigned long long)txid) >= SB_LTX_PATH)
    return -1;
  return snprintf(tmp, SB_LTX_PATH, "%s.tmp", final) >= SB_LTX_PATH ? -1 : 0;
}
static int sb_ltx_publish(const char *tmp, const char *final, const char *dir) {
  // Never replace a finished file, including an orphan ahead of position.
  if (link(tmp, final))
    return -1; // Atomic no-replace publication on the same filesystem.
  if (unlink(tmp) || sb_ltx_sync_dir(dir))
    return -1;
  sb_ltx_phase("ltx-published");
  return 0;
}
static int sb_ltx_position(sb_ltx_state *s) {
  char path[SB_LTX_PATH], tmp[SB_LTX_PATH], body[512];
  if (snprintf(path, sizeof(path), "%s/position", s->root) >= sizeof(path) ||
      snprintf(tmp, sizeof(tmp), "%s/position.tmp", s->root) >= sizeof(tmp))
    return -1;
  int n = snprintf(body, sizeof(body), "LTXPOS2\n%s\n%c %llu %u %u %llu %016llx %u %u %u %u\n",
                   s->epoch, s->checkpointed ? 'C' : 'W', (unsigned long long)s->txid, s->salt1,
                   s->salt2, (unsigned long long)s->offset, (unsigned long long)s->checksum,
                   s->wal_c1, s->wal_c2, s->page_size, s->commit);
  if (n < 0 || n >= (int)sizeof(body))
    return -1;
  FILE *f = fopen(tmp, "wb");
  if (!f)
    return -1;
  int rc = fwrite(body, 1, n, f) != (size_t)n ||
           fprintf(f, "%016llx\n", (unsigned long long)~sb_ltx_crc(UINT64_MAX, body, n)) < 0 ||
           sb_ltx_flush(f);
  if (fclose(f))
    rc = -1;
  if (rc)
    return -1;
  sb_ltx_phase(s->checkpointed ? "checkpoint-record-fsynced" : "position-fsynced");
  if (rename(tmp, path) || sb_ltx_sync_dir(s->root))
    return -1;
  sb_ltx_phase(s->checkpointed ? "checkpoint-record-published" : "position-published");
  return 0;
}
static int sb_ltx_checkpoint(sb_ltx_state *s, int persist) {
  int a, b;
  sb_ltx_phase("before-checkpoint");
  int rc = sqlite3_wal_checkpoint_v2(s->db, "main", 3, &a, &b);
  if (!rc) {
    s->offset = 0;
    s->salt1 = s->salt2 = s->wal_c1 = s->wal_c2 = 0;
  }
  sb_ltx_phase("after-checkpoint");
  // The WAL record remains authoritative until checkpoint has completed. A
  // crash before this second atomic record write retains conservative recovery.
  if (!rc && persist && !s->checkpointed) {
    s->checkpointed = 1;
    rc = sb_ltx_position(s);
  }
  return rc;
}
static int sb_ltx_snapshot(sb_ltx_state *s) {
  if (sb_ltx_checkpoint(s, 0))
    return -1;
  // EXCLUSIVE SQLite locking mode excludes other connections. BEGIN pins the
  // checkpointed live pages while they are read; no VACUUM or page rewriting.
  if (sqlite3_exec(s->db, "BEGIN", 0, 0, 0))
    return -1;
  int fd = s->read_fd;
  unsigned char head[100];
  struct stat st;
  int rc = -1;
  if (fd < 0 || fstat(fd, &st) || sb_ltx_read(fd, head, 100, 0) ||
      memcmp(head, "SQLite format 3", 15))
    goto done;
  s->page_size = ((uint32_t)head[16] << 8) | head[17];
  if (s->page_size == 1)
    s->page_size = 65536;
  if (s->page_size < 512 || s->page_size > 65536 || (s->page_size & (s->page_size - 1)) ||
      st.st_size % s->page_size)
    goto done;
  s->commit = (uint32_t)(st.st_size / s->page_size);
  s->txid = 1;
  s->checksum = SB_LTX_FLAG;
  char dir[SB_LTX_PATH], tmp[SB_LTX_PATH], final[SB_LTX_PATH];
  if (snprintf(dir, sizeof(dir), "%s/epoch-XXXXXX", s->root) >= sizeof(dir) || !mkdtemp(dir))
    goto done;
  snprintf(s->epoch, sizeof(s->epoch), "%s", strrchr(dir, '/') + 1);
  if (sb_ltx_sync_dir(s->root) || sb_ltx_names(s, 1, tmp, final, dir))
    goto done;
  unsigned char *page = malloc(s->page_size);
  if (!page)
    goto done;
  sb_ltx_writer w;
  rc = sb_ltx_begin(&w, tmp, s, s->commit, 1, 0);
  for (uint32_t p = 1; !rc && p <= s->commit; p++) {
    if (p == (0x40000000u / s->page_size) + 1)
      continue;
    if (sb_ltx_read(fd, page, s->page_size, (uint64_t)(p - 1) * s->page_size) ||
        sb_ltx_page(&w, p, page)) {
      rc = -1;
      break;
    }
    s->checksum = SB_LTX_FLAG | (s->checksum ^ sb_ltx_page_crc(p, page, s->page_size));
  }
  free(page);
  if (!rc)
    rc = sb_ltx_finish(&w, s->checksum);
  sb_ltx_writer_close(&w);
  if (!rc)
    rc = sb_ltx_publish(tmp, final, dir);
  if (!rc) {
    s->checkpointed = 1;
    rc = sb_ltx_position(s);
  }
done:
  if (sqlite3_exec(s->db, "COMMIT", 0, 0, 0))
    rc = -1;
  return rc;
}

typedef struct {
  uint32_t pgno, frame;
} sb_ltx_frame;
static int sb_ltx_frame_cmp(const void *a, const void *b) {
  const sb_ltx_frame *x = a, *y = b;
  return x->pgno < y->pgno     ? -1
         : x->pgno > y->pgno   ? 1
         : x->frame < y->frame ? -1
                               : x->frame > y->frame;
}
static void sb_ltx_wal_checksum(const unsigned char *p, size_t n, int big, uint32_t *a,
                                uint32_t *b) {
  for (size_t i = 0; i < n; i += 8) {
    uint32_t x, y;
    if (big) {
      x = sb_ltx_be32(p + i);
      y = sb_ltx_be32(p + i + 4);
    } else {
      x = (uint32_t)p[i] | (uint32_t)p[i + 1] << 8 | (uint32_t)p[i + 2] << 16 |
          (uint32_t)p[i + 3] << 24;
      y = (uint32_t)p[i + 4] | (uint32_t)p[i + 5] << 8 | (uint32_t)p[i + 6] << 16 |
          (uint32_t)p[i + 7] << 24;
    }
    *a += x + *b;
    *b += y + *a;
  }
}
static int sb_ltx_capture(sb_ltx_state *s, uint32_t frames) {
  char path[SB_LTX_PATH];
  if (snprintf(path, sizeof(path), "%s-wal", s->path) >= sizeof(path))
    return -1;
  int wal = open(path, O_RDONLY), db = s->read_fd;
  unsigned char head[32], fh[24];
  unsigned char *page = 0;
  sb_ltx_frame *map = 0;
  int rc = -1;
  if (wal < 0 || db < 0 || sb_ltx_read(wal, head, 32, 0))
    goto done;
  uint32_t magic = sb_ltx_be32(head), ps = sb_ltx_be32(head + 8), salt1 = sb_ltx_be32(head + 16),
           salt2 = sb_ltx_be32(head + 20), a = 0, b = 0;
  if ((magic != 0x377f0682 && magic != 0x377f0683) || sb_ltx_be32(head + 4) != 3007000 ||
      ps != s->page_size || !frames || 32 + (uint64_t)frames * (ps + 24) > sb_ltx_max_bytes)
    goto done;
  sb_ltx_wal_checksum(head, 24, magic & 1, &a, &b);
  if (a != sb_ltx_be32(head + 24) || b != sb_ltx_be32(head + 28))
    goto done;
  uint32_t prior = s->offset ? (uint32_t)((s->offset - 32) / (ps + 24)) : 0;
  if (s->offset && (s->salt1 != salt1 || s->salt2 != salt2 || prior > frames))
    goto done;
  page = malloc(ps);
  map = malloc((size_t)frames * sizeof(*map));
  if (!page || !map)
    goto done;
  uint32_t commit = 0;
  for (uint32_t f = 1; f <= frames; f++) {
    uint64_t off = 32 + (uint64_t)(f - 1) * (ps + 24);
    if (sb_ltx_read(wal, fh, 24, off) || sb_ltx_read(wal, page, ps, off + 24) ||
        sb_ltx_be32(fh + 8) != salt1 || sb_ltx_be32(fh + 12) != salt2 || !sb_ltx_be32(fh))
      goto done;
    sb_ltx_wal_checksum(fh, 8, magic & 1, &a, &b);
    sb_ltx_wal_checksum(page, ps, magic & 1, &a, &b);
    if (a != sb_ltx_be32(fh + 16) || b != sb_ltx_be32(fh + 20))
      goto done;
    if (f == prior && (a != s->wal_c1 || b != s->wal_c2))
      goto done;
    map[f - 1] = (sb_ltx_frame){sb_ltx_be32(fh), f};
    commit = sb_ltx_be32(fh + 4);
  }
  if (!commit)
    goto done;
  if (frames == prior) {
    rc = 0;
    goto done;
  }
  qsort(map, frames, sizeof(*map), sb_ltx_frame_cmp);
  uint64_t checksum = s->checksum;
  unsigned char *old = malloc(ps);
  if (!old)
    goto done;
  // Remove truncated old pages, reading the last captured WAL version if present.
  for (uint32_t p = commit + 1; p && p <= s->commit; p++) {
    if (p == (0x40000000u / ps) + 1)
      continue;
    uint32_t prev = 0;
    for (uint32_t i = 0; i < frames; i++)
      if (map[i].pgno == p && map[i].frame <= prior)
        prev = map[i].frame;
    if (sb_ltx_read(prev ? wal : db, old, ps,
                    prev ? 32 + (uint64_t)(prev - 1) * (ps + 24) + 24 : (uint64_t)(p - 1) * ps)) {
      free(old);
      goto done;
    }
    checksum = SB_LTX_FLAG | (checksum ^ sb_ltx_page_crc(p, old, ps));
  }
  char tmp[SB_LTX_PATH], final[SB_LTX_PATH], dir[SB_LTX_PATH];
  if (sb_ltx_names(s, s->txid + 1, tmp, final, dir)) {
    free(old);
    goto done;
  }
  s->salt1 = salt1;
  s->salt2 = salt2;
  sb_ltx_writer w;
  rc = sb_ltx_begin(&w, tmp, s, commit, 0, (uint64_t)(frames - prior) * (ps + 24));
  for (uint32_t i = 0; !rc && i < frames;) {
    uint32_t p = map[i].pgno, latest = 0, prev = 0;
    do {
      if (map[i].frame <= prior)
        prev = map[i].frame;
      else
        latest = map[i].frame;
      i++;
    } while (i < frames && map[i].pgno == p);
    if (!latest || p > commit || p == (0x40000000u / ps) + 1)
      continue;
    if (p <= s->commit) {
      if (sb_ltx_read(prev ? wal : db, old, ps,
                      prev ? 32 + (uint64_t)(prev - 1) * (ps + 24) + 24 : (uint64_t)(p - 1) * ps)) {
        rc = -1;
        break;
      }
      checksum = SB_LTX_FLAG | (checksum ^ sb_ltx_page_crc(p, old, ps));
    }
    if (sb_ltx_read(wal, page, ps, 32 + (uint64_t)(latest - 1) * (ps + 24) + 24) ||
        sb_ltx_page(&w, p, page)) {
      rc = -1;
      break;
    }
    checksum = SB_LTX_FLAG | (checksum ^ sb_ltx_page_crc(p, page, ps));
  }
  free(old);
  if (!rc)
    rc = sb_ltx_finish(&w, checksum);
  sb_ltx_writer_close(&w);
  if (!rc)
    rc = sb_ltx_publish(tmp, final, dir);
  if (!rc) {
    s->checkpointed = 0;
    s->txid++;
    s->commit = commit;
    s->offset = 32 + (uint64_t)frames * (ps + 24);
    s->checksum = checksum;
    s->wal_c1 = a;
    s->wal_c2 = b;
    rc = sb_ltx_position(s);
  }
done:
  if (wal >= 0)
    close(wal);
  free(page);
  free(map);
  return rc;
}
static int sb_ltx_hook(void *ctx, sqlite3 *db, const char *name, int frames) {
  (void)db;
  sb_ltx_state *s = ctx;
#ifdef SB_LTX_TESTING
  sb_ltx_test_commits++;
#endif
  sb_ltx_phase("wal-committed");
  if (s->failed || strcmp(name, "main") || sb_ltx_capture(s, (uint32_t)frames)) {
    s->failed = 1;
    fprintf(stderr, "LTX capture failed for %s, restart required\n", s->path);
    return 10;
  }
  // Checkpoint after the statement resets, so a subsequent transaction cannot
  // reset the WAL salts before the in-memory cursor has been cleared.
  return 0;
}
static int sb_ltx_authorize(void *ctx, int action, const char *a, const char *b, const char *c,
                            const char *d) {
  (void)ctx;
  (void)b;
  (void)c;
  (void)d;
  if (action == 24 || action == 25)
    return 1; // ATTACH / DETACH would escape capture.
  if (action == 19 && a &&
      (!strcasecmp(a, "wal_checkpoint") || !strcasecmp(a, "wal_autocheckpoint") ||
       !strcasecmp(a, "journal_mode") || !strcasecmp(a, "locking_mode") ||
       !strcasecmp(a, "synchronous") || !strcasecmp(a, "page_size") || !strcasecmp(a, "mmap_size")))
    return 1;
  return 0;
}
static int sb_ltx_after(int idx) {
  sb_ltx_state *s = &sb_ltx_states[idx];
  if (!s->db)
    return 0;
  if (s->failed)
    return -1;
  // SQLITE_BUSY can occur with an explicit transaction holding a read lock.
  // Keep the validated WAL and position; the VFS still imposes the hard ceiling.
  int rc = sb_ltx_checkpoint(s, 1);
  if (rc && rc != 5 && rc != 6) {
    s->failed = 1;
    return -1;
  }
  return 0;
}
// Verify our literal-block file before trusting a position. Reads stay bounded
// even for a large base; CRC covers the logical uncompressed LTX contents.
static int sb_ltx_verify_last(sb_ltx_state *s) {
  char tmp[SB_LTX_PATH], final[SB_LTX_PATH], dir[SB_LTX_PATH];
  if (sb_ltx_names(s, s->txid, tmp, final, dir))
    return 0;
  int fd = open(final, O_RDONLY);
  struct stat st;
  unsigned char h[100], fh[10], tail[24];
  unsigned char *page = malloc(65536);
  int valid = 0;
  if (fd < 0 || !page || fstat(fd, &st) || st.st_size < 131 || sb_ltx_read(fd, h, 100, 0) ||
      sb_ltx_read(fd, tail, 24, (uint64_t)st.st_size - 24))
    goto done;
  uint64_t min = 0, max = 0, post = 0, file_crc = 0, index_size = 0;
  for (int i = 0; i < 8; i++) {
    min = (min << 8) | h[16 + i];
    max = (max << 8) | h[24 + i];
    post = (post << 8) | tail[8 + i];
    file_crc = (file_crc << 8) | tail[16 + i];
    index_size = (index_size << 8) | tail[i];
  }
  if (memcmp(h, "LTX1", 4) || sb_ltx_be32(h + 4) || sb_ltx_be32(h + 8) != s->page_size ||
      sb_ltx_be32(h + 12) != s->commit || min != s->txid || max != s->txid || post != s->checksum)
    goto done;
  uint64_t offset = 100, hash = sb_ltx_crc(UINT64_MAX, h, 100);
  uint32_t prev = 0;
  for (;;) {
    if (sb_ltx_read(fd, fh, 6, offset))
      goto done;
    hash = sb_ltx_crc(hash, fh, 6);
    offset += 6;
    uint32_t pgno = sb_ltx_be32(fh);
    if (!pgno) {
      if (fh[4] || fh[5])
        goto done;
      break;
    }
    if (pgno <= prev || pgno > s->commit || fh[4] || fh[5] != 1)
      goto done;
    prev = pgno;
    if (sb_ltx_read(fd, fh, 4, offset))
      goto done;
    hash = sb_ltx_crc(hash, fh, 4);
    offset += 4;
    uint32_t size = sb_ltx_be32(fh), literal = 15;
    uint64_t end = offset + size;
    unsigned char c;
    if (size > s->page_size + s->page_size / 255 + 16 || sb_ltx_read(fd, &c, 1, offset++) ||
        c != 0xf0)
      goto done;
    do {
      if (sb_ltx_read(fd, &c, 1, offset++))
        goto done;
      literal += c;
      if (literal > s->page_size)
        goto done;
    } while (c == 255);
    if (literal != s->page_size || offset + s->page_size != end ||
        sb_ltx_read(fd, page, s->page_size, offset))
      goto done;
    hash = sb_ltx_crc(hash, page, s->page_size);
    offset = end;
  }
  if (index_size > (uint64_t)st.st_size || offset + index_size + 24 != (uint64_t)st.st_size)
    goto done;
  // Index bytes, its size field and post-apply checksum are all hashed.
  while (offset < (uint64_t)st.st_size - 8) {
    size_t n = (uint64_t)st.st_size - 8 - offset;
    if (n > 65536)
      n = 65536;
    if (sb_ltx_read(fd, page, n, offset))
      goto done;
    hash = sb_ltx_crc(hash, page, n);
    offset += n;
  }
  valid = (SB_LTX_FLAG | ~hash) == file_crc;
done:
  if (fd >= 0)
    close(fd);
  free(page);
  return valid;
}
static int sb_ltx_load_position(sb_ltx_state *s) {
  char path[SB_LTX_PATH], text[768];
  if (snprintf(path, sizeof(path), "%s/position", s->root) >= sizeof(path))
    return 0;
  FILE *f = fopen(path, "rb");
  if (!f)
    return 0;
  size_t n = fread(text, 1, sizeof(text) - 1, f);
  int bad = ferror(f) || !feof(f);
  fclose(f);
  if (bad)
    return 0;
  text[n] = 0;
  sb_ltx_state candidate = *s;
  unsigned long long txid, offset, checksum, digest;
  char mode;
  int used = 0, tail = 0;
  if (sscanf(text, "LTXPOS2\n%63s\n%c %llu %u %u %llu %16llx %u %u %u %u\n%n", candidate.epoch,
             &mode, &txid, &candidate.salt1, &candidate.salt2, &offset, &checksum,
             &candidate.wal_c1, &candidate.wal_c2, &candidate.page_size, &candidate.commit,
             &used) != 11)
    return 0;
  if (!used || sscanf(text + used, "%16llx\n%n", &digest, &tail) != 1 ||
      (size_t)(used + tail) != n || digest != ~sb_ltx_crc(UINT64_MAX, text, (size_t)used))
    return 0;
  if (strncmp(candidate.epoch, "epoch-", 6) || strlen(candidate.epoch) != 12 ||
      strspn(candidate.epoch, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-") !=
          12 ||
      !txid || txid == UINT64_MAX || !(checksum & SB_LTX_FLAG) || !candidate.commit)
    return 0;
  uint32_t ps = candidate.page_size;
  if (ps < 512 || ps > 65536 || (ps & (ps - 1)))
    return 0;
  if (mode == 'C') {
    if (offset || candidate.salt1 || candidate.salt2 || candidate.wal_c1 || candidate.wal_c2)
      return 0;
  } else if (mode != 'W' || offset < 32 || offset > sb_ltx_max_bytes || (offset - 32) % (ps + 24))
    return 0;
  candidate.checkpointed = mode == 'C';
  candidate.txid = txid;
  candidate.offset = offset;
  candidate.checksum = checksum;
  if (!sb_ltx_verify_last(&candidate))
    return 0;
  // A published orphan ahead of the record is never overwritten. A new base
  // captures the recovered source and preserves the old generation for restore.
  char tmp[SB_LTX_PATH], final[SB_LTX_PATH], dir[SB_LTX_PATH];
  if (sb_ltx_names(&candidate, txid + 1, tmp, final, dir) || access(final, F_OK) == 0)
    return 0;
  *s = candidate;
  return 1;
}
// A clean marker means the checkpointed file is the entire captured state.
// Verify its full page checksum before trusting an absent/empty WAL. Opening no
// additional database fd preserves SQLite's process-level POSIX locks.
static int sb_ltx_verify_database(sb_ltx_state *s) {
  struct stat st;
  if (fstat(s->read_fd, &st) || (uint64_t)st.st_size != (uint64_t)s->commit * s->page_size)
    return 0;
  unsigned char *page = malloc(s->page_size);
  if (!page)
    return 0;
  uint64_t checksum = SB_LTX_FLAG;
  int valid = 1;
  for (uint32_t p = 1; p <= s->commit; p++) {
    if (p == (0x40000000u / s->page_size) + 1)
      continue;
    if (sb_ltx_read(s->read_fd, page, s->page_size, (uint64_t)(p - 1) * s->page_size)) {
      valid = 0;
      break;
    }
    checksum = SB_LTX_FLAG | (checksum ^ sb_ltx_page_crc(p, page, s->page_size));
  }
  free(page);
  return valid && checksum == s->checksum;
}
static int sb_ltx_resume(sb_ltx_state *s) {
  if (!sb_ltx_load_position(s))
    return 0;
  char path[SB_LTX_PATH];
  if (snprintf(path, sizeof(path), "%s-wal", s->path) >= sizeof(path))
    return 0;
  if (s->checkpointed) {
    struct stat wal;
    if (stat(path, &wal) == 0) {
      if (wal.st_size != 0)
        return 0;
    } else if (errno != ENOENT)
      return 0;
    return sb_ltx_verify_database(s);
  }
  int fd = open(path, O_RDONLY);
  unsigned char h[32], fh[24];
  unsigned char *page = malloc(s->page_size);
  struct stat st;
  int valid = 0;
  uint32_t last = 0;
  if (fd < 0 || !page || fstat(fd, &st) || st.st_size < (off_t)s->offset ||
      st.st_size > (off_t)sb_ltx_max_bytes || sb_ltx_read(fd, h, 32, 0))
    goto done;
  uint32_t magic = sb_ltx_be32(h), a = 0, b = 0;
  if ((magic != 0x377f0682 && magic != 0x377f0683) || sb_ltx_be32(h + 4) != 3007000 ||
      sb_ltx_be32(h + 8) != s->page_size || sb_ltx_be32(h + 16) != s->salt1 ||
      sb_ltx_be32(h + 20) != s->salt2)
    goto done;
  sb_ltx_wal_checksum(h, 24, magic & 1, &a, &b);
  if (a != sb_ltx_be32(h + 24) || b != sb_ltx_be32(h + 28))
    goto done;
  uint32_t prior = (uint32_t)((s->offset - 32) / (s->page_size + 24));
  uint32_t count = (uint32_t)(((uint64_t)st.st_size - 32) / (s->page_size + 24));
  for (uint32_t i = 1; i <= count; i++) {
    uint64_t off = 32 + (uint64_t)(i - 1) * (s->page_size + 24);
    if (sb_ltx_read(fd, fh, 24, off) || sb_ltx_read(fd, page, s->page_size, off + 24) ||
        !sb_ltx_be32(fh) || sb_ltx_be32(fh + 8) != s->salt1 || sb_ltx_be32(fh + 12) != s->salt2)
      break;
    sb_ltx_wal_checksum(fh, 8, magic & 1, &a, &b);
    sb_ltx_wal_checksum(page, s->page_size, magic & 1, &a, &b);
    if (a != sb_ltx_be32(fh + 16) || b != sb_ltx_be32(fh + 20))
      break;
    if (sb_ltx_be32(fh + 4))
      last = i;
    if (i == prior)
      valid = a == s->wal_c1 && b == s->wal_c2 && sb_ltx_be32(fh + 4) == s->commit;
  }
done:
  if (fd >= 0)
    close(fd);
  free(page);
  if (!valid || last < (s->offset - 32) / (s->page_size + 24))
    return 0;
  if (last > (s->offset - 32) / (s->page_size + 24)) {
    char tmp[SB_LTX_PATH], final[SB_LTX_PATH], dir[SB_LTX_PATH];
    if (sb_ltx_names(s, s->txid + 1, tmp, final, dir))
      return -1;
    if (unlink(tmp) && errno != ENOENT)
      return -1;
    if (sb_ltx_capture(s, last))
      return -1;
  }
  if (sb_ltx_checkpoint(s, 1))
    return -1;
  return 1;
}

// The capture lock is already held. Remove only reserved, regular scratch files;
// do not open them (a hard link could share the database's POSIX-locked inode).
static int sb_ltx_sweep_indexes(const char *root) {
  DIR *dir = opendir(root);
  if (!dir)
    return -1;
  int rc = 0;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(dir);
    if (!entry) {
      if (errno)
        rc = -1;
      break;
    }
    const char *name = entry->d_name;
    if (strlen(name) != 12 || strncmp(name, "index-", 6) ||
        strspn(name + 6, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") != 6)
      continue;
    struct stat st;
    if (fstatat(dirfd(dir), name, &st, AT_SYMLINK_NOFOLLOW)) {
      if (errno == ENOENT)
        continue;
      rc = -1;
      break;
    }
    if (S_ISREG(st.st_mode) && unlinkat(dirfd(dir), name, 0) && errno != ENOENT) {
      rc = -1;
      break;
    }
  }
  if (closedir(dir))
    rc = -1;
  return rc;
}
static int sb_ltx_start(int idx, sqlite3 *db, const char *path, int lock) {
  sb_ltx_state *s = &sb_ltx_states[idx];
  memset(s, 0, sizeof(*s));
  s->db = db;
  s->lock = lock;
  s->read_fd = -1;
  if (snprintf(s->path, sizeof(s->path), "%s", path) >= sizeof(s->path) ||
      snprintf(s->root, sizeof(s->root), "%s.ltx", path) >= sizeof(s->root))
    return -1;
  if (mkdir(s->root, 0700) && errno != EEXIST)
    return -1;
  if (sb_ltx_sweep_indexes(s->root))
    return -1;
  char parent[SB_LTX_PATH];
  snprintf(parent, sizeof(parent), "%s", path);
  char *slash = strrchr(parent, '/');
  if (slash) {
    *slash = 0;
    if (sb_ltx_sync_dir(*parent ? parent : "/"))
      return -1;
  } else if (sb_ltx_sync_dir("."))
    return -1;
  if (sqlite3_exec(db,
                   "PRAGMA wal_autocheckpoint=0; PRAGMA synchronous=FULL; PRAGMA "
                   "locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;",
                   0, 0, 0))
    return -1;
  sqlite3_stmt *mode = 0;
  if (sqlite3_prepare_v2(db, "PRAGMA journal_mode", -1, &mode, 0) || !mode)
    return -1;
  int is_wal =
      sqlite3_step(mode) == 100 && !strcmp((const char *)sqlite3_column_text(mode, 0), "wal");
  sqlite3_finalize(mode);
  if (!is_wal)
    return -1;
  struct stat st;
  if (stat(path, &st))
    return -1;
  if (st.st_size == 0 && sqlite3_exec(db, "PRAGMA user_version=0;", 0, 0, 0))
    return -1;
  // POSIX fcntl locks belong to the process, not its descriptors. Closing any
  // raw fd for this inode would silently release SQLite's locks. Keep this fd
  // for the database handle's entire lifetime, including failed captures.
  s->read_fd = open(path, O_RDONLY);
  if (s->read_fd < 0)
    return -1;
  int resumed = sb_ltx_resume(s);
  if (resumed < 0 || (resumed == 0 && sb_ltx_snapshot(s)))
    return -1;
  sqlite3_wal_hook(db, sb_ltx_hook, s);
  sqlite3_set_authorizer(db, sb_ltx_authorize, s);
  return 0;
}
static int sb_ltx_opted(const char *path) {
  const char *v = getenv("SB_LTX_ENABLE"), *name = getenv("SB_LTX_DATABASE");
  if (!sb_ltx_compat || !v || strcmp(v, "1"))
    return 0;
  if (!name || !*name ||
      strspn(name, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") !=
          strlen(name))
    return -1;
  char suffix[300];
  if (snprintf(suffix, sizeof(suffix), "/d1/%s.sqlite", name) >= sizeof(suffix))
    return -1;
  size_t n = strlen(path), k = strlen(suffix);
  return n >= k && strcmp(path + n - k, suffix) == 0;
}
// END LTX NATIVE

// One handle per path, opened once and kept for the process lifetime — the same
// lifetime the broker gives a Database. Returns an index, or -1.
// Create every parent directory of path, like mkdir -p. A standalone binary
// has no launcher to prepare its data directory, and sqlite3_open creates files
// but never the directories above them.
static void sb_mkdirs(const char* path) {
  char tmp[1024];
  size_t n = strlen(path);
  if (n == 0 || n >= sizeof(tmp)) return;
  memcpy(tmp, path, n + 1);
  for (char* p = tmp + 1; *p; p++) {
    if (*p != '/') continue;
    *p = 0;
    mkdir(tmp, 0700);
    *p = '/';
  }
}

// Durable Objects SQL (storage.sql): one database per object, under "/do-sql/". At most
// SB_DO_SQL_OPEN of them stay open; the one used longest ago is closed for the next.
#define SB_DO_SQL_OPEN 8
static unsigned long sb_db_used[SB_MAX_DB];
static unsigned long sb_db_tick = 0;
static int sb_is_do_sql(const char* path) { return strstr(path, "/do-sql/") != 0; }
static void sb_db_evict(int idx);

// SQLite allocates 20 pages in one block for every page cache it creates, and a statement that
// builds a temporary table (INSERT ... RETURNING, a sort) creates one: an 88 KiB mmap and munmap
// per such statement. A page count of 0 turns the bulk allocation off; the cache then takes
// its pages one at a time, as it always does past the first 20. Must run before SQLite starts.
extern int sqlite3_config(int, ...);
static int sb_sqlite_booted = 0;
static void sb_sqlite_boot(void) {
  if (sb_sqlite_booted) return;
  sb_sqlite_booted = 1;
  sqlite3_config(7 /* SQLITE_CONFIG_PAGECACHE */, (void*)0, 0, 0);
}
static int sb_db_for(const char* path) {
  for (int i = 0; i < sb_db_count; i++) {
    if (sb_dbs[i] && strcmp(sb_db_names[i], path) == 0) {
      sb_db_used[i] = ++sb_db_tick;
      return sb_ltx_states[i].failed ? -1 : i;
    }
  }
  sb_sqlite_boot();
  const int do_sql = sb_is_do_sql(path);
  // A name that would not fit could never be found again.
  if (do_sql && strlen(path) >= sizeof(sb_db_names[0])) return -1;
  int replicated = do_sql ? 0 : sb_ltx_opted(path), lock = -1;
  if (replicated < 0 || (replicated && strlen(path) >= sizeof(sb_db_names[0]))) return -1;
  // A Durable Object SQL database reuses the slot of the one used longest ago once
  // SB_DO_SQL_OPEN are open; any other database takes one when every slot is in use.
  int slot = sb_db_count, lru = -1, open_do_sql = 0;
  for (int i = 0; i < sb_db_count; i++) {
    if (!sb_dbs[i] || !sb_is_do_sql(sb_db_names[i])) continue;
    open_do_sql++;
    if (lru < 0 || sb_db_used[i] < sb_db_used[lru]) lru = i;
  }
  if (lru >= 0 && !replicated && ((do_sql && open_do_sql >= SB_DO_SQL_OPEN) || sb_db_count >= SB_MAX_DB)) {
    sb_db_evict(lru);
    slot = lru;
  }
  if (slot >= SB_MAX_DB) return -1;
  sqlite3* db = 0;
  sb_mkdirs(path);
  if (replicated) {
    char lockpath[SB_LTX_PATH];
    if (snprintf(lockpath, sizeof(lockpath), "%s.ltx.lock", path) >= sizeof(lockpath) || sb_ltx_register()) return -1;
    lock = open(lockpath, O_RDWR | O_CREAT, 0600);
    if (lock < 0 || flock(lock, LOCK_EX | LOCK_NB)) { if (lock >= 0) close(lock); return -1; }
  }
  int open_rc = replicated ? sqlite3_open_v2(path, &db, 6, "sb-ltx-bounded") : sqlite3_open(path, &db);
  if (open_rc != 0) { if (db) sqlite3_close(db); if (lock >= 0) close(lock); return -1; }
  // No mmap_size on purpose: mapping the database makes every page a read
  // touches count toward RSS, and measured on Linux that cost more than the
  // copy it saves once the file holds a few large objects. The page cache is
  // capped instead, and journal_size_limit stops the WAL staying huge after one
  // big write.
  // busy_timeout: within one binary every binding op is serial, so there is no
  // self-contention. It matters when the same data dir is served by several
  // copies of the binary behind SO_REUSEPORT (#154 scaling recipe): WAL takes
  // concurrent readers plus one writer across processes, and this makes a
  // writer wait for the lock instead of failing SQLITE_BUSY.
  // SB_SQLITE_EXCLUSIVE=1 holds the database's lock for the life of the process: no fcntl lock
  // and unlock around each transaction, and the WAL index lives in heap memory instead of a shared
  // -shm file. Set before journal_mode, because the heap index is only chosen when WAL starts in
  // exclusive mode. No other process can open the database while the binary runs, which also rules
  // out the several-copies-behind-SO_REUSEPORT recipe above. Off unless set (see below), and never for a
  // database under LTX replication: capture reads the WAL through its shared index, and in
  // exclusive mode (no -shm file) every capture failed (native-d1's LTX database).
  // The transport itself only reads the variable, so a host that embeds it (sproutd, the broker) stays
  // in shared mode unless it is set. A standalone binary sets it to 1 at startup (patch.ts, the shim's
  // constructor) unless the operator has set it, so SB_SQLITE_EXCLUSIVE=0 opts a standalone binary out.
  // SB_SQLITE_CACHE_MB sizes each database's page cache in MiB (default 2, about -2000 KiB).
  {
    const char* excl = getenv("SB_SQLITE_EXCLUSIVE");
    if (excl && excl[0] == '1' && !excl[1] && !replicated) sqlite3_exec(db, "PRAGMA locking_mode=EXCLUSIVE", 0, 0, 0);
    char cache[64];
    const char* mb = getenv("SB_SQLITE_CACHE_MB");
    long mib = mb && *mb ? strtol(mb, 0, 10) : 0;
    if (mib >= 1 && mib <= 4096) snprintf(cache, sizeof(cache), "PRAGMA cache_size=-%ld", mib * 1024);
    else snprintf(cache, sizeof(cache), "PRAGMA cache_size=-2000");
    sqlite3_exec(db, cache, 0, 0, 0);
  }
  sqlite3_exec(db,
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;"
    "PRAGMA journal_size_limit=16777216;",
    0, 0, 0);
  // Durable Object SQLite enforces foreign keys, as in workerd.
  if (do_sql) sqlite3_exec(db, "PRAGMA foreign_keys=ON", 0, 0, 0);
  sb_db_used[slot] = ++sb_db_tick;
  sb_dbs[slot] = db;
  snprintf(sb_db_names[slot], 256, "%s", path);
  if (replicated && sb_ltx_start(slot, db, path, lock)) {
    sb_ltx_states[slot].failed = 1;
    fprintf(stderr, "LTX initialization failed for %s\n", path);
    sqlite3_close(db);
    if (sb_ltx_states[slot].read_fd >= 0) close(sb_ltx_states[slot].read_fd);
    sb_ltx_states[slot].read_fd = -1;
    sb_dbs[slot] = 0;
    if (slot == sb_db_count) sb_db_count++;
    close(lock); return -1;
  }
  if (slot == sb_db_count) sb_db_count++;
  return slot;
}

// #155 — a prepared-statement cache per database. Every binding op (KV, D1, DO
// storage, queue, AE) funnels through sb_sql_run, which used to prepare and
// finalize on every call — measured at ~0.6 ms/op, that compile step was most
// of an op's cost. Keyed by exact SQL text; reset and re-bound on reuse.
//
// ponytail: FIFO eviction over 32 slots, linear scan, no lock (the runtime
// serves one turn at a time). Move to LRU + a hash if a real app keeps >32 hot
// statements per db, or if execution ever overlaps. Entries are never finalized
// on shutdown — sb_db_for never closes a handle, the process owns it for life.
#define SB_STMT_CACHE 32
typedef struct { char* sql; sqlite3_stmt* st; } sb_cached_stmt;
static sb_cached_stmt sb_stmt_cache[SB_MAX_DB][SB_STMT_CACHE];
static int sb_stmt_fifo[SB_MAX_DB];

static sqlite3_stmt* sb_stmt_get(int idx, sqlite3* db, const char* sql) {
  sb_cached_stmt* slots = sb_stmt_cache[idx];
  for (int i = 0; i < SB_STMT_CACHE; i++) {
    if (slots[i].sql && strcmp(slots[i].sql, sql) == 0) {
      sqlite3_reset(slots[i].st);
      sqlite3_clear_bindings(slots[i].st);
      return slots[i].st;
    }
  }
  sqlite3_stmt* st = 0;
  if (sqlite3_prepare_v2(db, sql, -1, &st, 0) != 0 || !st) return 0;
  int slot = sb_stmt_fifo[idx];
  sb_stmt_fifo[idx] = (slot + 1) % SB_STMT_CACHE;
  if (slots[slot].st) sqlite3_finalize(slots[slot].st);
  free(slots[slot].sql);
  size_t n = strlen(sql);
  slots[slot].sql = (char*)malloc(n + 1);
  if (slots[slot].sql) memcpy(slots[slot].sql, sql, n + 1);
  slots[slot].st = st;
  return st;
}

// Close a Durable Object SQL database to reuse its slot: its cached statements first.
static unsigned char sb_quota_frozen[SB_MAX_DB];
static void sb_db_evict(int idx) {
  for (int i = 0; i < SB_STMT_CACHE; i++) {
    if (sb_stmt_cache[idx][i].st) sqlite3_finalize(sb_stmt_cache[idx][i].st);
    free(sb_stmt_cache[idx][i].sql);
    sb_stmt_cache[idx][i].st = 0;
    sb_stmt_cache[idx][i].sql = 0;
  }
  sb_stmt_fifo[idx] = 0;
  sqlite3_close(sb_dbs[idx]);
  sb_dbs[idx] = 0;
  sb_db_names[idx][0] = 0;
  sb_quota_frozen[idx] = 0;
}

// --- a growable output buffer, for building the reply JSON ------------------
typedef struct { char* p; size_t len; size_t cap; } sb_buf;
static void sb_buf_need(sb_buf* b, size_t extra) {
  if (b->len + extra + 1 <= b->cap) return;
  size_t cap = b->cap ? b->cap * 2 : 1024;
  while (cap < b->len + extra + 1) cap *= 2;
  b->p = (char*)realloc(b->p, cap);
  b->cap = cap;
}
static void sb_put(sb_buf* b, const char* s, size_t n) {
  sb_buf_need(b, n);
  memcpy(b->p + b->len, s, n);
  b->len += n;
  b->p[b->len] = 0;
}
static void sb_puts(sb_buf* b, const char* s) { sb_put(b, s, strlen(s)); }
static void sb_putjson(sb_buf* b, const char* s, size_t n) {
  sb_put(b, "\"", 1);
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    if (c == '"' || c == '\\') { char e[2] = { '\\', (char)c }; sb_put(b, e, 2); }
    else if (c == '\n') sb_put(b, "\\n", 2);
    else if (c == '\r') sb_put(b, "\\r", 2);
    else if (c == '\t') sb_put(b, "\\t", 2);
    else if (c < 0x20) { char e[8]; int k = snprintf(e, 8, "\\u%04x", c); sb_put(b, e, (size_t)k); }
    else sb_put(b, (const char*)&c, 1);
  }
  sb_put(b, "\"", 1);
}
// baronunread/sproutboat#189 -- sb_putjson for bytes that are UTF-8 text
// (SQLite TEXT, its error messages). The reply reaches JS as a bytestring, one
// char per byte, so a raw multi-byte sequence came back as Latin-1 mojibake
// ("café" as "cafÃ©"). Escaping every code point >= 0x80 as \uXXXX keeps the
// reply pure ASCII and lets JSON.parse rebuild the real string. A byte that
// doesn't start a valid sequence passes through as \u00XX, the same rule as
// the prelude's __sbFromUtf8. Raw byte producers (the HTTP client's body,
// BLOB columns) keep sb_putjson.
// The UTF-16 units sb_putjson_text would write as u-escapes, for a TEXT cell handed over as
// a JS string: same validity rules (an invalid lead byte is its own unit, an overlong form, a
// surrogate or a value above U+10FFFF is not decoded). OUT has room for n units. *wide is set
// when a unit is above 0xff.
static size_t sb_text_units(const unsigned char* s, size_t n, uint16_t* out, int* wide) {
  size_t k = 0;
  *wide = 0;
  for (size_t i = 0; i < n; i++) {
    unsigned char c = s[i];
    if (c < 0x80) { out[k++] = c; continue; }
    unsigned int cp = 0, min = 0;
    size_t len = 0;
    if ((c & 0xe0) == 0xc0) { cp = c & 0x1f; len = 2; min = 0x80; }
    else if ((c & 0xf0) == 0xe0) { cp = c & 0x0f; len = 3; min = 0x800; }
    else if ((c & 0xf8) == 0xf0) { cp = c & 0x07; len = 4; min = 0x10000; }
    int ok = len > 0 && i + len <= n;
    for (size_t j = 1; ok && j < len; j++) {
      unsigned char cc = s[i + j];
      if ((cc & 0xc0) != 0x80) ok = 0;
      else cp = (cp << 6) | (cc & 0x3f);
    }
    if (ok && (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))) ok = 0;
    if (!ok) { out[k++] = c; if (c > 0xff) *wide = 1; continue; }
    if (cp >= 0x10000) {
      cp -= 0x10000;
      out[k++] = (uint16_t)(0xd800 + (cp >> 10));
      out[k++] = (uint16_t)(0xdc00 + (cp & 0x3ff));
      *wide = 1;
    } else {
      out[k++] = (uint16_t)cp;
      if (cp > 0xff) *wide = 1;
    }
    i += len - 1;
  }
  return k;
}

static void sb_putjson_text(sb_buf* b, const char* s, size_t n) {
  sb_put(b, "\"", 1);
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    if (c < 0x80) {
      if (c == '"' || c == '\\') { char e[2] = { '\\', (char)c }; sb_put(b, e, 2); }
      else if (c == '\n') sb_put(b, "\\n", 2);
      else if (c == '\r') sb_put(b, "\\r", 2);
      else if (c == '\t') sb_put(b, "\\t", 2);
      else if (c < 0x20) { char e[8]; int k = snprintf(e, 8, "\\u%04x", c); sb_put(b, e, (size_t)k); }
      else sb_put(b, (const char*)&c, 1);
      continue;
    }
    unsigned int cp = 0, min = 0;
    size_t len = 0;
    if ((c & 0xe0) == 0xc0) { cp = c & 0x1f; len = 2; min = 0x80; }
    else if ((c & 0xf0) == 0xe0) { cp = c & 0x0f; len = 3; min = 0x800; }
    else if ((c & 0xf8) == 0xf0) { cp = c & 0x07; len = 4; min = 0x10000; }
    int ok = len > 0 && i + len <= n;
    for (size_t k = 1; ok && k < len; k++) {
      unsigned char cc = (unsigned char)s[i + k];
      if ((cc & 0xc0) != 0x80) ok = 0;
      else cp = (cp << 6) | (cc & 0x3f);
    }
    if (ok && (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))) ok = 0;
    char e[16];
    int k;
    if (!ok) { k = snprintf(e, sizeof(e), "\\u%04x", c); sb_put(b, e, (size_t)k); continue; }
    if (cp >= 0x10000) {
      cp -= 0x10000;
      k = snprintf(e, sizeof(e), "\\u%04x\\u%04x", 0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      k = snprintf(e, sizeof(e), "\\u%04x", cp);
    }
    sb_put(b, e, (size_t)k);
    i += len - 1;
  }
  sb_put(b, "\"", 1);
}

// --- the narrow JSON reader: a flat array of null | number | string ----------
// Only ever fed __sbSql's own params, which JS builds; anything unexpected
// binds as NULL rather than guessing.
static const char* sb_skip_ws(const char* p) { while (*p == ' ' || *p == '\n' || *p == '\t' || *p == '\r') p++; return p; }

static int sb_hex_nibble(char c) { return c >= 'a' ? c - 'a' + 10 : c >= 'A' ? c - 'A' + 10 : c - '0'; }
// Past one JSON object (strings and nesting respected), or to the end of the text.
static const char* sb_json_skip_object(const char* p) {
  int depth = 0, quoted = 0;
  for (; *p; p++) {
    if (quoted) { if (*p == '\\' && p[1]) p++; else if (*p == '"') quoted = 0; continue; }
    if (*p == '"') quoted = 1;
    else if (*p == '{' || *p == '[') depth++;
    else if ((*p == '}' || *p == ']') && --depth == 0) return p + 1;
  }
  return p;
}

static int sb_bind_params(sqlite3_stmt* st, const char* json) {
  const char* p = sb_skip_ws(json);
  if (*p != '[') return 0;
  p++;
  int index = 1;
  while (1) {
    p = sb_skip_ws(p);
    if (*p == ']' || *p == 0) break;
    if (*p == ',') { p++; continue; }
    if (*p == 'n') { sqlite3_bind_null(st, index++); p += 4; continue; }
    if (*p == '"') {
      p++;
      char* out = (char*)malloc(strlen(p) + 1);
      size_t n = 0;
      while (*p && *p != '"') {
        if (*p == '\\' && p[1]) {
          p++;
          char c = *p++;
          if (c == 'n') out[n++] = '\n';
          else if (c == 't') out[n++] = '\t';
          else if (c == 'r') out[n++] = '\r';
          // \b and \f are the two escapes JSON.stringify emits that are easy to
          // forget. Without them the fallthrough below writes the letter, so a
          // stored byte 0x08 came back as 'b' and 0x0c as 'f' — the only two
          // values in 0..255 that R2 could not round-trip.
          else if (c == 'b') out[n++] = 8;
          else if (c == 'f') out[n++] = 12;
          else if (c == 'u') {
            unsigned int cp = 0;
            for (int k = 0; k < 4 && *p; k++) {
              char h = *p++;
              cp = cp * 16 + (unsigned int)(h >= 'a' ? h - 'a' + 10 : (h >= 'A' ? h - 'A' + 10 : h - '0'));
            }
            // Encode as UTF-8; surrogate halves are passed through as-is.
            if (cp < 0x80) out[n++] = (char)cp;
            else if (cp < 0x800) { out[n++] = (char)(0xC0 | (cp >> 6)); out[n++] = (char)(0x80 | (cp & 0x3F)); }
            else { out[n++] = (char)(0xE0 | (cp >> 12)); out[n++] = (char)(0x80 | ((cp >> 6) & 0x3F)); out[n++] = (char)(0x80 | (cp & 0x3F)); }
          } else out[n++] = c;
        } else out[n++] = *p++;
      }
      if (*p == '"') p++;
      sqlite3_bind_text(st, index++, out, (int)n, SB_SQLITE_TRANSIENT);
      free(out);
      continue;
    }
    // {"$blob":"HEX"}: the bytes of a D1 bind (an ArrayBuffer or a typed array), bound
    // as a BLOB. Any other object binds NULL. Before this an object stopped the parse,
    // so a Uint8Array and every parameter after it were silently stored as NULL.
    if (*p == '{') {
      const char* end = sb_json_skip_object(p);
      const char* hex = strstr(p, "\"$blob\":\"");
      if (hex && hex < end) {
        hex += 9;
        size_t n = 0;
        while (hex + 2 * n < end && hex[2 * n] != '"' && hex[2 * n + 1] != '"') n++;
        unsigned char* bytes = (unsigned char*)malloc(n ? n : 1);
        for (size_t i = 0; i < n; i++)
          bytes[i] = (unsigned char)(sb_hex_nibble(hex[2 * i]) << 4 | sb_hex_nibble(hex[2 * i + 1]));
        sqlite3_bind_blob(st, index++, bytes, (int)n, SB_SQLITE_TRANSIENT);
        free(bytes);
      } else sqlite3_bind_null(st, index++);
      p = end;
      continue;
    }
    // number (or true/false, bound as 1/0)
    if (*p == 't') { sqlite3_bind_double(st, index++, 1); p += 4; continue; }
    if (*p == 'f') { sqlite3_bind_double(st, index++, 0); p += 5; continue; }
    {
      char* endp = 0;
      double v = strtod(p, &endp);
      if (endp == p) break; // not something we understand; stop rather than spin
      sqlite3_bind_double(st, index++, v);
      p = endp;
    }
  }
  return index - 1; // how many were bound
}

// --- R2 bodies, without the JSON detour or the SQLite detour ----------------
// An object's bytes never enter a JSON frame (they arrive as their own string
// parameter) and never enter SQLite either (baronunread/sproutboat#56): they
// go straight to their own file under "<data-dir>/r2-blobs/", named by a hash
// of bucket+key so unicode keys and directory traversal are both non-issues.
// Doubling every object through SQLite's own page cache on top of the buffer
// it already arrived in was the real cost behind #56's "large uploads make
// memory skyrocket" complaint, not just the JSON-escaping #63 already fixed.

static void sb_hex32(const unsigned char* in, char* out) {
  static const char* d = "0123456789abcdef";
  for (int i = 0; i < 32; i++) { out[i * 2] = d[in[i] >> 4]; out[i * 2 + 1] = d[in[i] & 15]; }
  out[64] = 0;
}

// sha256 of the body, matching what the broker records as the etag.
static void sb_sha256_hex(const char* data, size_t len, char* out65) {
  br_sha256_context ctx;
  br_sha256_init(&ctx);
  br_sha256_update(&ctx, data, len);
  unsigned char digest[32];
  br_sha256_out(&ctx, digest);
  sb_hex32(digest, out65);
}

static void sb_iso_now(char* out, size_t cap) {
  time_t now = time(0);
  struct tm g;
  gmtime_r(&now, &g);
  strftime(out, cap, "%Y-%m-%dT%H:%M:%S.000Z", &g);
}

// "<dir-of-store_path>/r2-blobs/<sha256(bucket 0x1e key)>.blob" — deterministic,
// so no extra column is needed to find an object's file back.
static void sb_r2_blob_path(char* out, size_t cap, const char* store_path, const char* bucket, const char* key,
                            const char* generation) {
  const char* slash = strrchr(store_path, '/');
  int dirlen = slash ? (int)(slash - store_path) : 0;
  br_sha256_context ctx;
  br_sha256_init(&ctx);
  br_sha256_update(&ctx, bucket, strlen(bucket));
  br_sha256_update(&ctx, "\x1e", 1); // separator: a bucket/key split never collides across it
  br_sha256_update(&ctx, key, strlen(key));
  if (generation && *generation) {
    br_sha256_update(&ctx, "\x1e", 1);
    br_sha256_update(&ctx, generation, strlen(generation));
  }
  unsigned char digest[32];
  br_sha256_out(&ctx, digest);
  char hex[65];
  sb_hex32(digest, hex);
  snprintf(out, cap, "%.*s/r2-blobs/%s.blob", dirlen, store_path, hex);
}

static void sb_r2_part_path(char* out, size_t cap, const char* store_path, const char* bucket, const char* key,
                            const char* upload_id, int part_number) {
  const char* slash = strrchr(store_path, '/');
  int dirlen = slash ? (int)(slash - store_path) : 0;
  br_sha256_context ctx;
  br_sha256_init(&ctx);
  br_sha256_update(&ctx, bucket, strlen(bucket));
  br_sha256_update(&ctx, "\x1e", 1);
  br_sha256_update(&ctx, key, strlen(key));
  br_sha256_update(&ctx, "\x1e", 1);
  br_sha256_update(&ctx, upload_id, strlen(upload_id));
  br_sha256_update(&ctx, "\x1e", 1);
  char number[16];
  int number_len = snprintf(number, sizeof(number), "%d", part_number);
  br_sha256_update(&ctx, number, (size_t)number_len);
  unsigned char digest[32];
  br_sha256_out(&ctx, digest);
  char hex[65];
  sb_hex32(digest, hex);
  snprintf(out, cap, "%.*s/r2-parts/%s.part", dirlen, store_path, hex);
}

static char* sb_r2_part_put_c(const char* path, const char* bucket, const char* key, const char* upload_id,
                              int part_number, const char* body, size_t bodylen) {
  sb_buf out = { 0, 0, 0 };
  char partpath[1024];
  sb_r2_part_path(partpath, sizeof(partpath), path, bucket, key, upload_id, part_number);
  sb_mkdirs(partpath);
  char temporary[1100];
  snprintf(temporary, sizeof(temporary), "%s.tmp", partpath);
  FILE* f = fopen(temporary, "wb");
  if (!f) { sb_puts(&out, "{\"ok\":false,\"error\":\"cannot write multipart part\"}"); return out.p; }
  size_t written = bodylen ? fwrite(body, 1, bodylen, f) : 0;
  int close_rc = fclose(f);
  if (written != bodylen || close_rc != 0 || rename(temporary, partpath) != 0) {
    unlink(temporary);
    sb_puts(&out, "{\"ok\":false,\"error\":\"multipart part write failed\"}");
    return out.p;
  }
  char etag[65];
  sb_sha256_hex(body, bodylen, etag);
  char result[160];
  int n = snprintf(result, sizeof(result), "{\"ok\":true,\"etag\":\"%s\",\"size\":%zu}", etag, bodylen);
  sb_put(&out, result, (size_t)n);
  return out.p;
}

static char* sb_r2_multipart_complete_c(const char* path, const char* bucket, const char* key, const char* upload_id) {
  sb_buf out = { 0, 0, 0 };
  int idx = sb_db_for(path);
  if (idx < 0) { sb_puts(&out, "{\"ok\":false,\"error\":\"cannot open database\"}"); return out.p; }

  char blobpath[1024];
  sb_r2_blob_path(blobpath, sizeof(blobpath), path, bucket, key, "");
  sb_mkdirs(blobpath);
  char temporary[1100];
  snprintf(temporary, sizeof(temporary), "%s.%s.tmp", blobpath, upload_id);
  FILE* destination = fopen(temporary, "wb");
  if (!destination) { sb_puts(&out, "{\"ok\":false,\"error\":\"cannot write object\"}"); return out.p; }

  sqlite3_stmt* st = 0;
  const char* sql =
    "SELECT part_number, size FROM r2_part WHERE bucket = ?1 AND key = ?2 AND upload_id = ?3 ORDER BY part_number";
  if (sqlite3_prepare_v2(sb_dbs[idx], sql, -1, &st, 0) != 0 || !st) {
    fclose(destination); unlink(temporary);
    sb_puts(&out, "{\"ok\":false,\"error\":\"cannot read multipart parts\"}");
    return out.p;
  }
  sqlite3_bind_text(st, 1, bucket, -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 2, key, -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 3, upload_id, -1, SB_SQLITE_TRANSIENT);

  br_sha256_context hash;
  br_sha256_init(&hash);
  size_t total = 0;
  int failed = 0;
  unsigned char chunk[65536];
  while (!failed && sqlite3_step(st) == SB_SQLITE_ROW) {
    int part_number = sqlite3_column_int(st, 0);
    size_t expected = (size_t)sqlite3_column_int64(st, 1);
    char partpath[1024];
    sb_r2_part_path(partpath, sizeof(partpath), path, bucket, key, upload_id, part_number);
    FILE* part = fopen(partpath, "rb");
    if (!part) { failed = 1; break; }
    size_t part_size = 0;
    for (;;) {
      size_t read_count = fread(chunk, 1, sizeof(chunk), part);
      if (read_count) {
        if (fwrite(chunk, 1, read_count, destination) != read_count) { failed = 1; break; }
        br_sha256_update(&hash, chunk, read_count);
        part_size += read_count;
        total += read_count;
      }
      if (read_count < sizeof(chunk)) {
        if (ferror(part)) failed = 1;
        break;
      }
    }
    fclose(part);
    if (part_size != expected) failed = 1;
  }
  sqlite3_finalize(st);
  if (fclose(destination) != 0) failed = 1;
  if (failed) {
    unlink(temporary);
    sb_puts(&out, "{\"ok\":false,\"error\":\"multipart completion failed\"}");
    return out.p;
  }

  unsigned char digest[32];
  br_sha256_out(&hash, digest);
  char etag[65];
  sb_hex32(digest, etag);
  char generation_path[1024];
  sb_r2_blob_path(generation_path, sizeof(generation_path), path, bucket, key, etag);
  if (rename(temporary, generation_path) != 0) {
    unlink(temporary);
    sb_puts(&out, "{\"ok\":false,\"error\":\"multipart completion failed\"}");
    return out.p;
  }
  char result[160];
  int n = snprintf(result, sizeof(result), "{\"ok\":true,\"etag\":\"%s\",\"size\":%zu}", etag, total);
  sb_put(&out, result, (size_t)n);
  return out.p;
}

static void sb_r2_multipart_delete_parts_c(const char* path, const char* bucket, const char* key, const char* upload_id) {
  int idx = sb_db_for(path);
  if (idx < 0) return;
  sqlite3_stmt* st = 0;
  const char* sql = "SELECT part_number FROM r2_part WHERE bucket = ?1 AND key = ?2 AND upload_id = ?3";
  if (sqlite3_prepare_v2(sb_dbs[idx], sql, -1, &st, 0) != 0 || !st) return;
  sqlite3_bind_text(st, 1, bucket, -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 2, key, -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 3, upload_id, -1, SB_SQLITE_TRANSIENT);
  while (sqlite3_step(st) == SB_SQLITE_ROW) {
    char partpath[1024];
    sb_r2_part_path(partpath, sizeof(partpath), path, bucket, key, upload_id, sqlite3_column_int(st, 0));
    unlink(partpath);
  }
  sqlite3_finalize(st);
}

// Returns malloc'd JSON metadata; the body itself is never serialised into it.
static char* sb_r2_put_c(const char* path, const char* bucket, const char* key, const char* body, size_t bodylen,
                         const char* http_json, const char* custom_json) {
  sb_buf out = { 0, 0, 0 };
  int idx = sb_db_for(path);
  if (idx < 0) { sb_puts(&out, "{\"ok\":false,\"error\":\"cannot open database\"}"); return out.p; }
  sqlite3* db = sb_dbs[idx];

  char etag[65];
  sb_sha256_hex(body, bodylen, etag);
  char uploaded[40];
  sb_iso_now(uploaded, sizeof(uploaded));

  char previous[65];
  previous[0] = 0;
  sqlite3_stmt* old = 0;
  if (sqlite3_prepare_v2(db, "SELECT blob_id FROM r2 WHERE bucket = ?1 AND key = ?2", -1, &old, 0) == 0 && old) {
    sqlite3_bind_text(old, 1, bucket, -1, SB_SQLITE_TRANSIENT);
    sqlite3_bind_text(old, 2, key, -1, SB_SQLITE_TRANSIENT);
    if (sqlite3_step(old) == SB_SQLITE_ROW) {
      const unsigned char* value = sqlite3_column_text(old, 0);
      if (value) snprintf(previous, sizeof(previous), "%s", (const char*)value);
    }
    sqlite3_finalize(old);
  }

  char blobpath[1024];
  sb_r2_blob_path(blobpath, sizeof(blobpath), path, bucket, key, etag);
  sb_mkdirs(blobpath);
  char temporary[1100];
  snprintf(temporary, sizeof(temporary), "%s.tmp", blobpath);
  FILE* f = fopen(temporary, "wb");
  if (!f) { sb_puts(&out, "{\"ok\":false,\"error\":\"cannot write object\"}"); return out.p; }
  size_t written = bodylen ? fwrite(body, 1, bodylen, f) : 0;
  int close_rc = fclose(f);
  if (written != bodylen || close_rc != 0 || rename(temporary, blobpath) != 0) {
    unlink(temporary);
    sb_puts(&out, "{\"ok\":false,\"error\":\"object write failed\"}");
    return out.p;
  }

  sqlite3_stmt* st = 0;
  const char* sql =
    "INSERT INTO r2 (bucket, key, size, etag, uploaded, http_json, custom_json, blob_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) "
    "ON CONFLICT (bucket, key) DO UPDATE SET size=?3, etag=?4, uploaded=?5, http_json=?6, custom_json=?7, blob_id=?8";
  if (sqlite3_prepare_v2(db, sql, -1, &st, 0) != 0 || !st) {
    if (strcmp(previous, etag) != 0) unlink(blobpath);
    sb_puts(&out, "{\"ok\":false,\"error\":");
    const char* m = sqlite3_errmsg(db);
    sb_putjson_text(&out, m, strlen(m));
    sb_puts(&out, "}");
    return out.p;
  }
  sqlite3_bind_text(st, 1, bucket, -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 2, key, -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_int64(st, 3, (int64_t)bodylen);
  sqlite3_bind_text(st, 4, etag, -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 5, uploaded, -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 6, http_json && *http_json ? http_json : "{}", -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 7, custom_json && *custom_json ? custom_json : "{}", -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 8, etag, -1, SB_SQLITE_TRANSIENT);
  int rc = sqlite3_step(st);
  sqlite3_finalize(st);
  if (rc != SB_SQLITE_DONE) {
    if (strcmp(previous, etag) != 0) unlink(blobpath);
    sb_puts(&out, "{\"ok\":false,\"error\":\"r2 put failed\"}");
    return out.p;
  }
  if (previous[0] && strcmp(previous, etag) != 0) {
    char oldpath[1024];
    sb_r2_blob_path(oldpath, sizeof(oldpath), path, bucket, key, previous);
    unlink(oldpath);
  } else if (!previous[0]) {
    char legacy[1024];
    sb_r2_blob_path(legacy, sizeof(legacy), path, bucket, key, "");
    if (strcmp(legacy, blobpath) != 0) unlink(legacy);
  }

  char head[256];
  int k = snprintf(head, sizeof(head), "{\"ok\":true,\"etag\":\"%s\",\"size\":%zu,\"uploaded\":\"%s\"}", etag, bodylen, uploaded);
  sb_put(&out, head, (size_t)k);
  return out.p;
}

// Reads the object's file into a Porffor bytestring. One malloc (the file
// read) plus the bytestring's own allocation — no SQLite page-cache copy on
// top, and no growing single database file holding every object ever put.
// Returns the bytestring pointer, or 0.
static u32 sb_r2_get_c(const char* path, const char* bucket, const char* key, const char* generation, int* found) {
  *found = 0;
  int idx = sb_db_for(path);
  if (idx < 0) return 0;
  sqlite3_stmt* st = 0;
  if (sqlite3_prepare_v2(sb_dbs[idx], "SELECT 1 FROM r2 WHERE bucket = ? AND key = ?", -1, &st, 0) != 0 || !st) return 0;
  sqlite3_bind_text(st, 1, bucket, -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 2, key, -1, SB_SQLITE_TRANSIENT);
  int has_row = sqlite3_step(st) == SB_SQLITE_ROW;
  sqlite3_finalize(st);
  if (!has_row) return 0;

  char blobpath[1024];
  sb_r2_blob_path(blobpath, sizeof(blobpath), path, bucket, key, generation);
  FILE* f = fopen(blobpath, "rb");
  // A metadata row with no blob file (deleted out from under it, disk issue)
  // reads as not-found rather than crashing.
  if (!f) return 0;
  fseek(f, 0, SEEK_END);
  long size = ftell(f);
  rewind(f);
  if (size < 0) { fclose(f); return 0; }
  char* buf = (char*)malloc((size_t)size > 0 ? (size_t)size : 1);
  size_t rd = size > 0 ? fread(buf, 1, (size_t)size, f) : 0;
  fclose(f);
  if (!buf || rd != (size_t)size) { free(buf); return 0; }
  u32 out = porf_native_fetch_alloc_bytestring(buf, (size_t)size);
  free(buf);
  *found = 1;
  return out;
}

// Best-effort: a metadata row deleted with no blob file (or vice versa) is
// still a correct end state, so a missing file here is not an error.
static void sb_r2_delete_blob(const char* path, const char* bucket, const char* key, const char* generation) {
  char blobpath[1024];
  sb_r2_blob_path(blobpath, sizeof(blobpath), path, bucket, key, generation);
  unlink(blobpath);
}

// The native-fetch C++ shim calls this narrow ABI for a reserved R2 transfer
// path before it allocates a PendingRequest body. The context owns only a file
// descriptor and small metadata buffers; object bytes stay in the kernel page
// cache until the final fixed-size digest pass.
typedef struct sb_r2_transfer_ctx {
  FILE* file;
  sqlite3* db;
  char store[1024], bucket[256], key[512], token[32], expected[65], etag[65], http[1024], custom[1024], temporary[1200];
  size_t size, max_bytes;
} sb_r2_transfer_ctx;

extern const char* sb_standalone_app_name(void);

static void sb_r2_transfer_store_path(char* out, size_t cap) {
  const char* dir = getenv("SB_DATA_DIR");
  if (!dir || !*dir) dir = getenv("SPROUTBOAT_DATA");
  if (!dir || !*dir) {
    const char* app = sb_standalone_app_name();
    snprintf(out, cap, "%s.data/store.sqlite", app && *app ? app : "app");
    return;
  }
  snprintf(out, cap, "%s/store.sqlite", dir);
}

// Return HTTP status, or 0 when a one-use upload ticket was claimed.
int sb_r2_transfer_open(const char* bucket, const char* token, size_t declared, sb_r2_transfer_ctx** out) {
  *out = 0;
  if (!bucket || !token || strlen(bucket) >= 256 || strlen(token) != 24) return 404;
  sb_r2_transfer_ctx* ctx = (sb_r2_transfer_ctx*)calloc(1, sizeof(*ctx));
  if (!ctx) return 503;
  sb_r2_transfer_store_path(ctx->store, sizeof(ctx->store));
  int index = sb_db_for(ctx->store);
  if (index < 0) { free(ctx); return 503; }
  ctx->db = sb_dbs[index];
  sqlite3_stmt* st = 0;
  const char* sql = "SELECT key, max_bytes, expected_sha256, http_json, custom_json FROM r2_transfer "
                    "WHERE token=?1 AND bucket=?2 AND method='upload' AND used=0 AND expires>=?3";
  if (sqlite3_prepare_v2(ctx->db, sql, -1, &st, 0) != 0 || !st) { free(ctx); return 503; }
  sqlite3_bind_text(st, 1, token, -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 2, bucket, -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_int64(st, 3, (int64_t)time(0) * 1000);
  if (sqlite3_step(st) != SB_SQLITE_ROW) { sqlite3_finalize(st); free(ctx); return 410; }
  const char* key = (const char*)sqlite3_column_text(st, 0);
  ctx->max_bytes = (size_t)sqlite3_column_int64(st, 1);
  const char* expected = (const char*)sqlite3_column_text(st, 2);
  const char* http = (const char*)sqlite3_column_text(st, 3);
  const char* custom = (const char*)sqlite3_column_text(st, 4);
  if ((key && strlen(key) >= sizeof(ctx->key)) ||
      (expected && strlen(expected) >= sizeof(ctx->expected)) ||
      (http && strlen(http) >= sizeof(ctx->http)) ||
      (custom && strlen(custom) >= sizeof(ctx->custom))) {
    sqlite3_finalize(st); free(ctx); return 413;
  }
  snprintf(ctx->bucket, sizeof(ctx->bucket), "%s", bucket);
  snprintf(ctx->key, sizeof(ctx->key), "%s", key ? key : "");
  snprintf(ctx->token, sizeof(ctx->token), "%s", token);
  snprintf(ctx->expected, sizeof(ctx->expected), "%s", expected ? expected : "");
  snprintf(ctx->http, sizeof(ctx->http), "%s", http ? http : "{}");
  snprintf(ctx->custom, sizeof(ctx->custom), "%s", custom ? custom : "{}");
  sqlite3_finalize(st);
  if (declared > ctx->max_bytes) { free(ctx); return 413; }
  st = 0;
  if (sqlite3_prepare_v2(ctx->db, "UPDATE r2_transfer SET used=1 WHERE token=?1 AND used=0", -1, &st, 0) != 0 || !st) { free(ctx); return 503; }
  sqlite3_bind_text(st, 1, token, -1, SB_SQLITE_TRANSIENT);
  int claimed = sqlite3_step(st) == SB_SQLITE_DONE && sqlite3_changes(ctx->db) == 1;
  sqlite3_finalize(st);
  if (!claimed) { free(ctx); return 410; }
  const char* slash = strrchr(ctx->store, '/');
  if (!slash) { free(ctx); return 500; }
  char blobdir[1024];
  sb_r2_blob_path(blobdir, sizeof(blobdir), ctx->store, ctx->bucket, ctx->key, "");
  sb_mkdirs(blobdir);
  if (snprintf(ctx->temporary, sizeof(ctx->temporary), "%.*s/r2-blobs/%s.upload.tmp", (int)(slash - ctx->store), ctx->store, token) >= (int)sizeof(ctx->temporary)) { free(ctx); return 507; }
  ctx->file = fopen(ctx->temporary, "wb");
  if (!ctx->file) { free(ctx); return 507; }
  *out = ctx;
  return 0;
}

int sb_r2_transfer_write(sb_r2_transfer_ctx* ctx, const char* bytes, size_t length) {
  if (!ctx || !ctx->file || length > ctx->max_bytes - ctx->size) return 413;
  if (length && fwrite(bytes, 1, length, ctx->file) != length) return 507;
  ctx->size += length;
  return 0;
}

// Finish the native direct-upload path. The digest is deliberately computed
// from the temporary file in fixed-size chunks so neither validation nor the
// immutable-generation commit ever materialises the object in process memory.
int sb_r2_transfer_finish(sb_r2_transfer_ctx* ctx) {
  if (!ctx || !ctx->file) return 500;
  if (fclose(ctx->file) != 0) { ctx->file = 0; unlink(ctx->temporary); free(ctx); return 507; }
  ctx->file = 0;

  FILE* source = fopen(ctx->temporary, "rb");
  if (!source) { unlink(ctx->temporary); free(ctx); return 500; }
  br_sha256_context hash;
  br_sha256_init(&hash);
  unsigned char chunk[65536];
  for (;;) {
    size_t count = fread(chunk, 1, sizeof(chunk), source);
    if (count) br_sha256_update(&hash, chunk, count);
    if (count < sizeof(chunk)) {
      if (ferror(source)) { fclose(source); unlink(ctx->temporary); free(ctx); return 500; }
      break;
    }
  }
  fclose(source);
  unsigned char digest[32];
  char etag[65];
  br_sha256_out(&hash, digest);
  sb_hex32(digest, etag);
  if (ctx->expected[0] && strcmp(ctx->expected, etag) != 0) {
    unlink(ctx->temporary); free(ctx); return 422;
  }

  char previous[65] = { 0 };
  sqlite3_stmt* old = 0;
  if (sqlite3_prepare_v2(ctx->db, "SELECT blob_id FROM r2 WHERE bucket=?1 AND key=?2", -1, &old, 0) == 0 && old) {
    sqlite3_bind_text(old, 1, ctx->bucket, -1, SB_SQLITE_TRANSIENT);
    sqlite3_bind_text(old, 2, ctx->key, -1, SB_SQLITE_TRANSIENT);
    if (sqlite3_step(old) == SB_SQLITE_ROW) {
      const unsigned char* value = sqlite3_column_text(old, 0);
      if (value) snprintf(previous, sizeof(previous), "%s", (const char*)value);
    }
    sqlite3_finalize(old);
  }
  char blobpath[1024];
  sb_r2_blob_path(blobpath, sizeof(blobpath), ctx->store, ctx->bucket, ctx->key, etag);
  sb_mkdirs(blobpath);
  if (rename(ctx->temporary, blobpath) != 0) { unlink(ctx->temporary); free(ctx); return 507; }

  char uploaded[40];
  sb_iso_now(uploaded, sizeof(uploaded));
  sqlite3_stmt* st = 0;
  const char* sql =
    "INSERT INTO r2 (bucket,key,size,etag,uploaded,http_json,custom_json,blob_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) "
    "ON CONFLICT(bucket,key) DO UPDATE SET size=?3,etag=?4,uploaded=?5,http_json=?6,custom_json=?7,blob_id=?8";
  if (sqlite3_prepare_v2(ctx->db, sql, -1, &st, 0) != 0 || !st) {
    if (strcmp(previous, etag) != 0) unlink(blobpath);
    free(ctx); return 500;
  }
  sqlite3_bind_text(st, 1, ctx->bucket, -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 2, ctx->key, -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_int64(st, 3, (int64_t)ctx->size);
  sqlite3_bind_text(st, 4, etag, -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 5, uploaded, -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 6, ctx->http[0] ? ctx->http : "{}", -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 7, ctx->custom[0] ? ctx->custom : "{}", -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 8, etag, -1, SB_SQLITE_TRANSIENT);
  int rc = sqlite3_step(st);
  sqlite3_finalize(st);
  if (rc != SB_SQLITE_DONE) {
    if (strcmp(previous, etag) != 0) unlink(blobpath);
    free(ctx); return 500;
  }
  if (previous[0] && strcmp(previous, etag) != 0) {
    char oldpath[1024];
    sb_r2_blob_path(oldpath, sizeof(oldpath), ctx->store, ctx->bucket, ctx->key, previous);
    unlink(oldpath);
  }
  free(ctx);
  return 201;
}

void sb_r2_transfer_abort(sb_r2_transfer_ctx* ctx) {
  if (!ctx) return;
  if (ctx->file) fclose(ctx->file);
  if (ctx->temporary[0]) unlink(ctx->temporary);
  free(ctx);
}

// Claims a download ticket and opens its immutable blob generation. The C++
// socket shim reads this handle at its current write offset, so no object-sized
// buffer is ever allocated in either the JS or C++ heap.
int sb_r2_transfer_download_open(const char* bucket, const char* token, sb_r2_transfer_ctx** out) {
  *out = 0;
  if (!bucket || !token || strlen(bucket) >= 256 || strlen(token) != 24) return 404;
  sb_r2_transfer_ctx* ctx = (sb_r2_transfer_ctx*)calloc(1, sizeof(*ctx));
  if (!ctx) return 503;
  sb_r2_transfer_store_path(ctx->store, sizeof(ctx->store));
  int index = sb_db_for(ctx->store);
  if (index < 0) { free(ctx); return 503; }
  ctx->db = sb_dbs[index];
  sqlite3_stmt* st = 0;
  const char* ticket_sql = "SELECT key FROM r2_transfer WHERE token=?1 AND bucket=?2 AND method='download' AND used=0 AND expires>=?3";
  if (sqlite3_prepare_v2(ctx->db, ticket_sql, -1, &st, 0) != 0 || !st) { free(ctx); return 503; }
  sqlite3_bind_text(st, 1, token, -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 2, bucket, -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_int64(st, 3, (int64_t)time(0) * 1000);
  if (sqlite3_step(st) != SB_SQLITE_ROW) { sqlite3_finalize(st); free(ctx); return 410; }
  const char* key = (const char*)sqlite3_column_text(st, 0);
  if (!key || strlen(key) >= sizeof(ctx->key)) { sqlite3_finalize(st); free(ctx); return 404; }
  snprintf(ctx->bucket, sizeof(ctx->bucket), "%s", bucket);
  snprintf(ctx->key, sizeof(ctx->key), "%s", key);
  sqlite3_finalize(st);
  st = 0;
  if (sqlite3_prepare_v2(ctx->db, "SELECT blob_id, etag FROM r2 WHERE bucket=?1 AND key=?2", -1, &st, 0) != 0 || !st) { free(ctx); return 503; }
  sqlite3_bind_text(st, 1, bucket, -1, SB_SQLITE_TRANSIENT);
  sqlite3_bind_text(st, 2, ctx->key, -1, SB_SQLITE_TRANSIENT);
  if (sqlite3_step(st) != SB_SQLITE_ROW) { sqlite3_finalize(st); free(ctx); return 404; }
  const char* generation = (const char*)sqlite3_column_text(st, 0);
  const char* etag = (const char*)sqlite3_column_text(st, 1);
  if (!etag || strlen(etag) >= sizeof(ctx->etag)) { sqlite3_finalize(st); free(ctx); return 404; }
  snprintf(ctx->etag, sizeof(ctx->etag), "%s", etag);
  char blobpath[1024];
  sb_r2_blob_path(blobpath, sizeof(blobpath), ctx->store, bucket, ctx->key, generation ? generation : "");
  sqlite3_finalize(st);
  ctx->file = fopen(blobpath, "rb");
  if (!ctx->file) { free(ctx); return 404; }
  fseek(ctx->file, 0, SEEK_END); long length = ftell(ctx->file); rewind(ctx->file);
  if (length < 0) { fclose(ctx->file); free(ctx); return 500; }
  ctx->size = (size_t)length;
  st = 0;
  if (sqlite3_prepare_v2(ctx->db, "UPDATE r2_transfer SET used=1 WHERE token=?1 AND used=0", -1, &st, 0) != 0 || !st) { fclose(ctx->file); free(ctx); return 503; }
  sqlite3_bind_text(st, 1, token, -1, SB_SQLITE_TRANSIENT);
  int claimed = sqlite3_step(st) == SB_SQLITE_DONE && sqlite3_changes(ctx->db) == 1;
  sqlite3_finalize(st);
  if (!claimed) { fclose(ctx->file); free(ctx); return 410; }
  *out = ctx;
  return 0;
}

size_t sb_r2_transfer_download_size(sb_r2_transfer_ctx* ctx) { return ctx ? ctx->size : 0; }
const char* sb_r2_transfer_download_etag(sb_r2_transfer_ctx* ctx) { return ctx ? ctx->etag : ""; }
size_t sb_r2_transfer_download_read(sb_r2_transfer_ctx* ctx, size_t offset, char* out, size_t cap) {
  if (!ctx || !ctx->file || offset >= ctx->size || fseek(ctx->file, (long)offset, SEEK_SET) != 0) return 0;
  size_t wanted = ctx->size - offset < cap ? ctx->size - offset : cap;
  return fread(out, 1, wanted, ctx->file);
}
void sb_r2_transfer_download_close(sb_r2_transfer_ctx* ctx) { if (ctx) { if (ctx->file) fclose(ctx->file); free(ctx); } }

// LTX capture (#141) failed after SQLite committed: the write is in the database but not in
// the replication log, and the database refuses writes until the process restarts. Said as
// such (SQLITE_IOERR), never as SQLite's own message, which still reads "not an error".
#define SB_LTX_FAILED "LTX capture failed: the transaction may be committed locally but is not durable in the replication log; writes are refused until restart"
// The storage quota, for a database under LTX capture: while the app is over its quota,
// every write is refused (a same-size UPDATE or a DELETE still adds an LTX file to the
// spool, which counts toward the quota). Reads and transaction control still run.
#define SB_QUOTA_FULL "storage quota exceeded: writes are refused while this app's data, including its replication log, is over its quota"
// sb_quota_frozen (per database slot) is declared with sb_db_evict, which clears it.
static int sb_db_capture_failed(const char* path) {
  for (int i = 0; i < sb_db_count; i++) if (strcmp(sb_db_names[i], path) == 0) return sb_ltx_states[i].failed;
  return 0;
}
// Run a script: one or more statements separated by semicolons. sqlite3_exec
// handles the whole string, which prepare/step does not — it compiles the first
// statement and silently ignores the rest, so a schema built from one exec call
// would come out with only its first table.
static char* sb_sql_script(const char* path, const char* sql) {
  sb_buf b = { 0, 0, 0 };
  int idx = sb_db_for(path);
  if (idx < 0 && sb_db_capture_failed(path)) { sb_puts(&b, "{\"ok\":false,\"error\":\"" SB_LTX_FAILED "\",\"code\":10}"); return b.p; }
  if (idx < 0) { sb_puts(&b, "{\"ok\":false,\"error\":\"cannot open database\"}"); return b.p; }
  char* err = 0;
  int script_rc = 0, capture_failed = 0, quota_full = 0, failure_code = 0, failure_offset = -1;
  char failure[512] = { 0 };
  if (sb_ltx_states[idx].db) {
    const char *next = sql;
    while (*next && !script_rc) {
      sqlite3_stmt *st = 0; const char *tail = 0;
      script_rc = sqlite3_prepare_v2(sb_dbs[idx], next, -1, &st, &tail);
      if (!script_rc && st && sb_quota_frozen[idx] && !sqlite3_stmt_readonly(st)) { sqlite3_finalize(st); quota_full = 1; script_rc = 13; break; }
      if (!script_rc && st) { do { script_rc = sqlite3_step(st); } while (script_rc == SB_SQLITE_ROW); if (script_rc == SB_SQLITE_DONE) script_rc = 0; }
      // Keep the statement's error before capture runs statements of its own (it would
      // read "not an error" after them).
      if (script_rc && !failure[0]) { snprintf(failure, sizeof(failure), "%s", sqlite3_errmsg(sb_dbs[idx])); failure_code = sqlite3_extended_errcode(sb_dbs[idx]); failure_offset = sqlite3_error_offset(sb_dbs[idx]); }
      if (st) sqlite3_finalize(st);
      if (sb_ltx_after(idx)) { script_rc = 10; capture_failed = 1; }
      if (!tail || tail <= next) break;
      next = tail;
      // as sqlite3_exec does: the next statement starts at its first non-space character, so an
      // error offset counts from there
      while (*next == ' ' || *next == '\t' || *next == '\n' || *next == '\r' || *next == '\f') next++;
    }
  } else {
    script_rc = sqlite3_exec(sb_dbs[idx], sql, 0, 0, &err);
    if (script_rc) { failure_code = sqlite3_extended_errcode(sb_dbs[idx]); failure_offset = sqlite3_error_offset(sb_dbs[idx]); }
  }
  if (script_rc != 0) {
    const char* m = quota_full ? SB_QUOTA_FULL : capture_failed ? SB_LTX_FAILED : failure[0] ? failure : err ? err : sqlite3_errmsg(sb_dbs[idx]);
    sb_puts(&b, "{\"ok\":false,\"error\":");
    sb_putjson_text(&b, m, strlen(m));
    char code[32];
    snprintf(code, sizeof(code), ",\"code\":%d,\"offset\":%d}", quota_full ? 13 : capture_failed ? 10 : failure_code, quota_full || capture_failed ? -1 : failure_offset);
    sb_puts(&b, code);
    return b.p;
  }
  sb_puts(&b, "{\"ok\":true}");
  return b.p;
}

// An error reply with SQLite's extended result code and, when SQLite knows it, the byte
// offset of the error in the SQL (D1 reports both). A message of our own comes with its
// own code (code < 0: take SQLite's).
static char* sb_sql_error(sqlite3* db, const char* message, int code, int skip) {
  sb_buf e = { 0, 0, 0 };
  const char* m = message ? message : sqlite3_errmsg(db);
  sb_puts(&e, "{\"ok\":false,\"error\":");
  sb_putjson_text(&e, m, strlen(m));
  char tail[64];
  int offset = message ? -1 : sqlite3_error_offset(db);
  int k = snprintf(tail, sizeof(tail), ",\"code\":%d,\"offset\":%d}", code >= 0 ? code : sqlite3_extended_errcode(db), offset >= skip ? offset - skip : -1);
  sb_put(&e, tail, (size_t)k);
  return e.p;
}

// D1 calls from compatibility date 2026-10-24 put this comment first: the statement must
// get exactly as many parameters as it has, like D1.
#define SB_D1_STRICT "/*sb-d1-strict*/"
// 2026-11-03: a statement with more behind it runs all of them, as workerd does (the marker follows
// SB_D1_STRICT). A query without a tail never looks past its first statement.
#define SB_D1_MULTI "/*sb-d1-multi*/"
#define SB_MULTI_PARAMS "When executing multiple SQL statements in a single call, only the last statement can have parameters."
#define SB_NO_STATEMENT "SQL code did not contain a statement."
// Runs st (the first statement, cached) and every statement after it but the last, inside one
// savepoint: they all take effect or none does. Returns the last statement, prepared here (the
// caller finalizes it and ends the savepoint), or NULL with *error set (savepoint rolled back).
static sqlite3_stmt* sb_multi_open(int idx, sqlite3* db, sqlite3_stmt* st, const char* rest, char** error) {
  sqlite3_stmt* cur = st;
  int cached = 1;
  *error = 0;
  sqlite3_exec(db, "SAVEPOINT sb_d1_multi", 0, 0, 0);
  for (;;) {
    rest = sb_skip_ws(rest);
    if (!*rest) return cur;
    if (sqlite3_bind_parameter_count(cur) > 0) { *error = sb_sql_error(db, SB_MULTI_PARAMS, 0, 0); break; }
    if (sb_quota_frozen[idx] && !sqlite3_stmt_readonly(cur)) { *error = sb_sql_error(db, SB_QUOTA_FULL, 13, 0); break; }
    int rc;
    while ((rc = sqlite3_step(cur)) == SB_SQLITE_ROW) {}
    if (rc != SB_SQLITE_DONE) { *error = sb_sql_error(db, 0, -1, 0); break; }
    if (cached) sqlite3_reset(cur); else sqlite3_finalize(cur);
    cur = 0;
    sqlite3_stmt* next = 0; const char* tail = 0;
    if (sqlite3_prepare_v2(db, rest, -1, &next, &tail)) { *error = sb_sql_error(db, 0, -1, 0); break; }
    if (!next) { *error = sb_sql_error(db, SB_NO_STATEMENT, 0, 0); break; }
    cur = next; cached = 0; rest = tail ? tail : "";
  }
  if (cur) { if (cached) sqlite3_reset(cur); else sqlite3_finalize(cur); }
  sqlite3_exec(db, "ROLLBACK TO sb_d1_multi", 0, 0, 0);
  sqlite3_exec(db, "RELEASE sb_d1_multi", 0, 0, 0);
  return 0;
}

// Run one statement. Returns malloc'd JSON:
//   {"ok":true,"cols":[...],"rows":[[...]],"changes":n,"rowid":n}
// or {"ok":false,"error":"...","code":n,"offset":n}. In a D1 database (a path under
// /d1/) a BLOB comes back as {"$blob":"HEX"}; elsewhere as one char per byte.
// A strict D1 query can hand its rows back as cells instead of JSON text: the caller turns
// them into JS arrays, with no JSON written here and none parsed there. t is 0 NULL,
// 1 number, 2 TEXT (UTF-8 in p), 3 BLOB (bytes in p).
// The text and blob bytes of every cell share one arena (a cell holds an offset into it), and a
// TEXT cell says whether it is all ASCII: that one becomes a JS string with a single copy.
typedef struct { unsigned char t; unsigned char ascii; double d; size_t off; int n; } sb_cell;
// hdr: how many of the first cells are the column names, not row data; changes and rowid are the
// statement's counts, so a native reply needs no JSON header at all.
typedef struct { sb_cell* c; size_t n; size_t cap; int ncol; int used; char* a; size_t alen; size_t acap; int hdr; long long changes; long long rowid; } sb_cells;
static void sb_cells_free(sb_cells* cs) {
  if (!cs) return;
  free(cs->c);
  free(cs->a);
  cs->c = 0; cs->a = 0; cs->n = cs->cap = cs->alen = cs->acap = 0;
}
// Copies n bytes into the arena and returns their offset, or (size_t)-1 when out of memory.
static size_t sb_cells_bytes(sb_cells* cs, const unsigned char* src, size_t n, unsigned char* ascii) {
  if (cs->alen + n + 1 > cs->acap) {
    size_t cap = cs->acap ? cs->acap * 2 : 1024;
    while (cap < cs->alen + n + 1) cap *= 2;
    char* grown = (char*)realloc(cs->a, cap);
    if (!grown) return (size_t)-1;
    cs->a = grown; cs->acap = cap;
  }
  const size_t off = cs->alen;
  unsigned char high = 0;
  for (size_t i = 0; i < n; i++) high |= src[i];
  if (n) memcpy(cs->a + off, src, n);
  cs->a[off + n] = 0;
  cs->alen = off + n + 1;
  *ascii = high < 0x80;
  return off;
}
static sb_cell* sb_cells_add(sb_cells* cs) {
  if (cs->n == cs->cap) {
    size_t cap = cs->cap ? cs->cap * 2 : 64;
    sb_cell* grown = (sb_cell*)realloc(cs->c, cap * sizeof(sb_cell));
    if (!grown) return 0;
    cs->c = grown; cs->cap = cap;
  }
  sb_cell* cell = &cs->c[cs->n++];
  cell->t = 0; cell->ascii = 0; cell->d = 0; cell->off = 0; cell->n = 0;
  return cell;
}
static char* sb_sql_run_x(const char* path, const char* sql, const char* params, sb_cells* cells) {
  sb_buf b = { 0, 0, 0 };
  int idx = sb_db_for(path);
  if (idx < 0 && sb_db_capture_failed(path)) return sb_sql_error(0, SB_LTX_FAILED, 10, 0);
  if (idx < 0) { sb_puts(&b, "{\"ok\":false,\"error\":\"cannot open database\"}"); return b.p; }
  sqlite3* db = sb_dbs[idx];
  const int strict = strncmp(sql, SB_D1_STRICT, sizeof(SB_D1_STRICT) - 1) == 0;
  const int multi = strict && strncmp(sql + sizeof(SB_D1_STRICT) - 1, SB_D1_MULTI, sizeof(SB_D1_MULTI) - 1) == 0;
  const int skip = strict ? (int)sizeof(SB_D1_STRICT) - 1 + (multi ? (int)sizeof(SB_D1_MULTI) - 1 : 0) : 0;
  // Durable Object SQL databases return BLOBs as D1 does.
  const int d1 = strstr(path, "/d1/") != 0 || sb_is_do_sql(path);
  sqlite3_stmt* st = sb_stmt_get(idx, db, sql);
  if (!st) return sb_sql_error(db, 0, -1, skip);
  // More than one statement: workerd runs them all and answers with the last one's rows; only the last
  // can take parameters. (sqlite3_sql is the first statement's text, a prefix of sql.)
  sqlite3_stmt* owned = 0;
  long long multi_before = 0;
  int in_multi = 0;
  if (multi) {
    const char* own = sqlite3_sql(st);
    size_t olen = own ? strlen(own) : 0;
    if (own && strncmp(sql, own, olen) == 0 && *sb_skip_ws(sql + olen)) {
      char* merr = 0;
      multi_before = sqlite3_total_changes(db);
      owned = sb_multi_open(idx, db, st, sql + olen, &merr);
      if (!owned) return merr;
      st = owned; in_multi = 1;
    }
  }
  int bound = params && *params ? sb_bind_params(st, params) : 0;
  if (sb_quota_frozen[idx] && !sqlite3_stmt_readonly(st)) {
    char* e = sb_sql_error(db, SB_QUOTA_FULL, 13, 0);
    if (owned) { sqlite3_finalize(owned); sqlite3_exec(db, "ROLLBACK TO sb_d1_multi", 0, 0, 0); sqlite3_exec(db, "RELEASE sb_d1_multi", 0, 0, 0); } else sqlite3_reset(st);
    return e;
  }
  if (strict && bound != sqlite3_bind_parameter_count(st)) {
    char* e = sb_sql_error(db, "Wrong number of parameter bindings for SQL query.", 0, 0);
    if (owned) { sqlite3_finalize(owned); sqlite3_exec(db, "ROLLBACK TO sb_d1_multi", 0, 0, 0); sqlite3_exec(db, "RELEASE sb_d1_multi", 0, 0, 0); } else sqlite3_reset(st);
    return e;
  }

  int ncol = sqlite3_column_count(st);
  // Cells only for a strict D1 statement: its BLOBs are byte arrays either way. The column names
  // are its first cells and the reply is no JSON text: success returns NULL, with the counts in cells.
  const int native = cells && strict && d1;
  if (native) {
    cells->ncol = ncol; cells->used = 1; cells->hdr = ncol;
    for (int i = 0; i < ncol && cells->used > 0; i++) {
      sb_cell* cell = sb_cells_add(cells);
      if (!cell) { cells->used = -1; break; }
      const char* name = sqlite3_column_name(st, i);
      cell->t = 2;
      cell->n = name ? (int)strlen(name) : 0;
      cell->off = sb_cells_bytes(cells, (const unsigned char*)(name ? name : ""), (size_t)cell->n, &cell->ascii);
      if (cell->off == (size_t)-1) { cells->used = -1; break; }
    }
  } else {
    sb_puts(&b, "{\"ok\":true,\"cols\":[");
    for (int i = 0; i < ncol; i++) {
      if (i) sb_puts(&b, ",");
      const char* name = sqlite3_column_name(st, i);
      sb_putjson_text(&b, name ? name : "", name ? strlen(name) : 0);
    }
    sb_puts(&b, "],\"rows\":[");
  }
  int rc, first = 1;
  while ((rc = sqlite3_step(st)) == SB_SQLITE_ROW) {
    if (native) {
      for (int i = 0; i < ncol; i++) {
        sb_cell* cell = sb_cells_add(cells);
        if (!cell) { cells->used = -1; break; }
        int t = sqlite3_column_type(st, i);
        if (t == 5) continue;
        if (t == 1 || t == 2) { cell->t = 1; cell->d = sqlite3_column_double(st, i); continue; }
        const unsigned char* txt = t == 4 ? (const unsigned char*)sqlite3_column_blob(st, i) : sqlite3_column_text(st, i);
        int n = sqlite3_column_bytes(st, i);
        cell->t = t == 4 ? 3 : 2;
        cell->n = txt ? n : 0;
        cell->off = sb_cells_bytes(cells, txt, (size_t)cell->n, &cell->ascii);
        if (cell->off == (size_t)-1) { cells->used = -1; break; }
      }
      if (cells->used < 0) break;
      continue;
    }
    if (!first) sb_puts(&b, ",");
    first = 0;
    sb_puts(&b, "[");
    for (int i = 0; i < ncol; i++) {
      if (i) sb_puts(&b, ",");
      int t = sqlite3_column_type(st, i);
      if (t == 5) { sb_puts(&b, "null"); continue; }             // SQLITE_NULL
      if (t == 1 || t == 2) {                                     // INTEGER / FLOAT
        char num[40];
        int k = snprintf(num, 40, "%.17g", sqlite3_column_double(st, i));
        sb_put(&b, num, (size_t)k);
        continue;
      }
      const unsigned char* txt = sqlite3_column_text(st, i);
      int n = sqlite3_column_bytes(st, i);
      // TEXT is UTF-8 and decodes (#189); a BLOB stays one char per byte, or is hex in D1.
      if (t == 4 && d1) {
        static const char* digits = "0123456789abcdef";
        const unsigned char* bytes = (const unsigned char*)sqlite3_column_blob(st, i);
        sb_puts(&b, "{\"$blob\":\"");
        for (int j = 0; j < n; j++) { char pair[2] = { digits[bytes[j] >> 4], digits[bytes[j] & 15] }; sb_put(&b, pair, 2); }
        sb_puts(&b, "\"}");
      }
      else if (t == 4) sb_putjson(&b, txt ? (const char*)txt : "", txt ? (size_t)n : 0);
      else sb_putjson_text(&b, txt ? (const char*)txt : "", txt ? (size_t)n : 0);
    }
    sb_puts(&b, "]");
  }
  // A read-only statement changed nothing: sqlite3_changes still holds the last write's count.
  if (native) {
    cells->changes = in_multi ? (int)(sqlite3_total_changes(db) - multi_before) : sqlite3_stmt_readonly(st) ? 0 : sqlite3_changes(db);
    cells->rowid = (long long)sqlite3_last_insert_rowid(db);
  } else {
    char tail[96];
    int k = snprintf(tail, 96, "],\"changes\":%d,\"rowid\":%lld}", in_multi ? (int)(sqlite3_total_changes(db) - multi_before) : sqlite3_stmt_readonly(st) ? 0 : sqlite3_changes(db), (long long)sqlite3_last_insert_rowid(db));
    sb_put(&b, tail, (size_t)k);
  }
  // Reset, don't finalize: the statement stays compiled in sb_stmt_cache. Reset
  // now (not just on next reuse) so a SELECT stops holding its read transaction.
  // The statement's own error, kept before anything runs another statement (a rollback, LTX capture):
  // after those SQLite reports "not an error".
  char failure[512] = { 0 };
  int failure_code = 0;
  if (rc != SB_SQLITE_DONE && rc != SB_SQLITE_ROW) {
    snprintf(failure, sizeof(failure), "%s", sqlite3_errmsg(db));
    failure_code = sqlite3_extended_errcode(db);
  }
  sqlite3_reset(st);
  if (owned) {
    sqlite3_finalize(owned);
    if (rc == SB_SQLITE_DONE || rc == SB_SQLITE_ROW) {
      // a deferred constraint can fail here, as it does at COMMIT
      if (sqlite3_exec(db, "RELEASE sb_d1_multi", 0, 0, 0)) {
        snprintf(failure, sizeof(failure), "%s", sqlite3_errmsg(db));
        failure_code = sqlite3_extended_errcode(db);
        rc = 1;
        sqlite3_exec(db, "ROLLBACK TO sb_d1_multi", 0, 0, 0);
        sqlite3_exec(db, "RELEASE sb_d1_multi", 0, 0, 0);
      }
    } else {
      sqlite3_exec(db, "ROLLBACK TO sb_d1_multi", 0, 0, 0);
      sqlite3_exec(db, "RELEASE sb_d1_multi", 0, 0, 0);
    }
  }
  if (cells && cells->used < 0) { free(b.p); sb_cells_free(cells); return sb_sql_error(db, "out of memory", 7, 0); }
  const int capture_failed = sb_ltx_after(idx) != 0;
  if (capture_failed) rc = 10;
  if (rc != SB_SQLITE_DONE && rc != SB_SQLITE_ROW) {
    free(b.p);
    if (cells) sb_cells_free(cells);
    if (capture_failed) return sb_sql_error(db, SB_LTX_FAILED, 10, 0);
    return sb_sql_error(db, failure, failure_code, 0);
  }
  return b.p;
}
static char* sb_sql_run(const char* path, const char* sql, const char* params) {
  return sb_sql_run_x(path, sql, params, 0);
}

// The storage quota (docs: an app's data directory is capped): bytes in regular files under
// dir, symlinks not followed. Bounded by depth; an unreadable entry counts as 0.
static long long sb_dir_bytes(const char* dir, int depth) {
  DIR* d = opendir(dir);
  if (!d || depth > 16) { if (d) closedir(d); return 0; }
  long long total = 0;
  struct dirent* e;
  char path[4096];
  while ((e = readdir(d))) {
    if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
    if (snprintf(path, sizeof(path), "%s/%s", dir, e->d_name) >= (int)sizeof(path)) continue;
    struct stat st;
    if (lstat(path, &st)) continue;
    if (S_ISREG(st.st_mode)) total += (long long)st.st_size;
    else if (S_ISDIR(st.st_mode)) total += sb_dir_bytes(path, depth + 1);
  }
  closedir(d);
  return total;
}

// A database's page size without SQL: under LTX capture the authorizer refuses every
// page_size pragma (the getter too), and capture records the size itself.
static int sb_db_page_size(const char* path) {
  int idx = sb_db_for(path);
  if (idx < 0) return 0;
  if (sb_ltx_states[idx].db) return (int)sb_ltx_states[idx].page_size;
  sqlite3_stmt* st = 0;
  int size = 0;
  if (sqlite3_prepare_v2(sb_dbs[idx], "PRAGMA page_size", -1, &st, 0) == 0 && st && sqlite3_step(st) == SB_SQLITE_ROW) size = sqlite3_column_int(st, 0);
  if (st) sqlite3_finalize(st);
  return size;
}
// Freeze (refuse writes to) or thaw a database for the quota; on < 0 only asks. Returns 1
// when the database is under LTX capture, 0 when not, -1 when it cannot be opened.
static int sb_db_quota_freeze(const char* path, int on) {
  int idx = sb_db_for(path);
  if (idx < 0) return -1;
  if (on >= 0) sb_quota_frozen[idx] = on && sb_ltx_states[idx].db ? 1 : 0;
  return sb_ltx_states[idx].db ? 1 : 0;
}

// #164 — an online, consistent single-file snapshot of a database, via
// VACUUM INTO. Runs against the live db with no downtime (SQLite holds a read
// transaction for the copy) and writes a fresh, defragmented file with no WAL
// sidecars — exactly what you copy off the box. The copy is then reopened and
// PRAGMA integrity_check'd, so a bad backup fails here, not on restore.
// Returns {"ok":true,"bytes":n} or {"ok":false,"error":"..."}.
static char* sb_sql_backup(const char* src_path, const char* dest_path) {
  sb_buf b = { 0, 0, 0 };
  int idx = sb_db_for(src_path);
  if (idx < 0) { sb_puts(&b, "{\"ok\":false,\"error\":\"cannot open database\"}"); return b.p; }
  sqlite3* db = sb_dbs[idx];

  sb_mkdirs(dest_path);
  unlink(dest_path); // VACUUM INTO refuses to overwrite an existing file

  sqlite3_stmt* st = 0;
  if (sqlite3_prepare_v2(db, "VACUUM INTO ?1", -1, &st, 0) != 0 || !st) {
    sb_puts(&b, "{\"ok\":false,\"error\":");
    const char* m = sqlite3_errmsg(db);
    sb_putjson_text(&b, m, strlen(m));
    sb_puts(&b, "}");
    return b.p;
  }
  sqlite3_bind_text(st, 1, dest_path, -1, SB_SQLITE_TRANSIENT);
  int rc = sqlite3_step(st);
  sqlite3_finalize(st);
  if (rc != SB_SQLITE_DONE) {
    sb_puts(&b, "{\"ok\":false,\"error\":");
    const char* m = sqlite3_errmsg(db);
    sb_putjson_text(&b, m, strlen(m));
    sb_puts(&b, "}");
    return b.p;
  }

  sqlite3* chk = 0;
  int ok = 0;
  if (sqlite3_open(dest_path, &chk) == 0 && chk) {
    sqlite3_stmt* cs = 0;
    if (sqlite3_prepare_v2(chk, "PRAGMA integrity_check", -1, &cs, 0) == 0 && cs) {
      if (sqlite3_step(cs) == SB_SQLITE_ROW) {
        const unsigned char* r = sqlite3_column_text(cs, 0);
        ok = r && strcmp((const char*)r, "ok") == 0;
      }
      sqlite3_finalize(cs);
    }
  }
  if (chk) sqlite3_close(chk);
  if (!ok) {
    unlink(dest_path);
    sb_puts(&b, "{\"ok\":false,\"error\":\"integrity check failed on the backup\"}");
    return b.p;
  }

  struct stat sbuf;
  long long bytes = stat(dest_path, &sbuf) == 0 ? (long long)sbuf.st_size : -1;
  char head[64];
  int k = snprintf(head, sizeof(head), "{\"ok\":true,\"bytes\":%lld}", bytes);
  sb_put(&b, head, (size_t)k);
  return b.p;
}

// --- outbound HTTP + HTTPS ---------------------------------------------------
// Plain sockets for http, BearSSL for https, with the Mozilla root set compiled
// in (see src/bearssl.ts). Both directions share the request builder and the
// response parser: the only thing that differs is how bytes move.

// #56 — an outbound response is held whole in memory, and its size is chosen by
// the remote host, not by us. Without a cap one upstream can drive a
// sprout out of memory: a 100 MB body measured at 321 MB resident. 32 MiB by
// default, raisable for a deployment that knowingly fetches something bigger.
static size_t sb_fetch_max(void) {
  static size_t cached = 0;
  if (cached == 0) {
    const char* raw = getenv("SB_FETCH_MAX_BYTES");
    long parsed = raw && *raw ? atol(raw) : 0;
    cached = parsed > 0 ? (size_t)parsed : 32u * 1024u * 1024u;
  }
  return cached;
}

// EGRESS:BEGIN
// baronunread/sproutboat#174: fetch() never connects to a private or reserved
// address. The resolved address is checked, never the hostname, so DNS
// rebinding has nothing to race. Same table, algorithm and message as
// @sproutboat/runtime's src/egress.ts; egress.test.ts compiles this block and
// holds the two to the same answers.

typedef struct { int len; int bits; unsigned char addr[16]; const char* cidr; } sb_egress_range;
static const char* sb_egress_blocked(const unsigned char* a, int len) {
  // EGRESS-TABLE:BEGIN generated by "bun run gen:egress" from src/egress.ts, do not edit
  static const sb_egress_range sb_egress_ranges[] = {
    { 4, 8, { 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, "0.0.0.0/8" },
    { 4, 8, { 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, "10.0.0.0/8" },
    { 4, 10, { 100, 64, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, "100.64.0.0/10" },
    { 4, 8, { 127, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, "127.0.0.0/8" },
    { 4, 16, { 169, 254, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, "169.254.0.0/16" },
    { 4, 12, { 172, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, "172.16.0.0/12" },
    { 4, 24, { 192, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, "192.0.0.0/24" },
    { 4, 24, { 192, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, "192.0.2.0/24" },
    { 4, 16, { 192, 168, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, "192.168.0.0/16" },
    { 4, 15, { 198, 18, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, "198.18.0.0/15" },
    { 4, 24, { 198, 51, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, "198.51.100.0/24" },
    { 4, 24, { 203, 0, 113, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, "203.0.113.0/24" },
    { 4, 4, { 224, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, "224.0.0.0/4" },
    { 4, 4, { 240, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, "240.0.0.0/4" },
    { 16, 96, { 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, "::/96" },
    { 16, 48, { 0, 100, 255, 155, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, "64:ff9b:1::/48" },
    { 16, 64, { 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, "100::/64" },
    { 16, 32, { 32, 1, 13, 184, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, "2001:db8::/32" },
    { 16, 7, { 252, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, "fc00::/7" },
    { 16, 10, { 254, 128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, "fe80::/10" },
    { 16, 10, { 254, 192, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, "fec0::/10" },
    { 16, 8, { 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, "ff00::/8" },
  };
  // EGRESS-TABLE:END
  static const unsigned char mapped[12] = { 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff };
  static const unsigned char nat64[12] = { 0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0 };
  if (len == 16 && (memcmp(a, mapped, 12) == 0 || memcmp(a, nat64, 12) == 0)) { a += 12; len = 4; }
  else if (len == 16 && a[0] == 0x20 && a[1] == 0x02) { a += 2; len = 4; }
  for (size_t i = 0; i < sizeof(sb_egress_ranges) / sizeof(sb_egress_ranges[0]); i++) {
    if (sb_egress_ranges[i].len != len) continue;
    int bits = sb_egress_ranges[i].bits, whole = bits >> 3, rem = bits & 7;
    if (memcmp(a, sb_egress_ranges[i].addr, (size_t)whole) != 0) continue;
    if (rem) {
      unsigned char m = (unsigned char)(0xff << (8 - rem));
      if ((a[whole] & m) != (sb_egress_ranges[i].addr[whole] & m)) continue;
    }
    return sb_egress_ranges[i].cidr;
  }
  return 0;
}

// SB_EGRESS_ALLOW: "*" or a comma-separated list of exact addresses.
static int sb_egress_allowed(const char* ip) {
  const char* p = getenv("SB_EGRESS_ALLOW");
  if (!p) return 0;
  size_t n = strlen(ip);
  while (*p) {
    while (*p == ' ' || *p == ',') p++;
    const char* start = p;
    while (*p && *p != ',') p++;
    const char* end = p;
    while (end > start && end[-1] == ' ') end--;
    size_t len = (size_t)(end - start);
    if ((len == 1 && *start == '*') || (len == n && len > 0 && memcmp(start, ip, n) == 0)) return 1;
  }
  return 0;
}

// 1 and the refusal in msg when fetch() may not connect to sa.
static int sb_egress_refused(const char* host, const struct sockaddr* sa, char* msg, size_t msglen) {
  const unsigned char* bytes;
  int len;
  if (sa->sa_family == AF_INET) { bytes = (const unsigned char*)&((const struct sockaddr_in*)sa)->sin_addr; len = 4; }
  else if (sa->sa_family == AF_INET6) { bytes = ((const struct sockaddr_in6*)sa)->sin6_addr.s6_addr; len = 16; }
  else { snprintf(msg, msglen, "fetch() refused: %s resolves to a non-IP address", host); return 1; }
  char ip[INET6_ADDRSTRLEN];
  if (!inet_ntop(sa->sa_family, bytes, ip, sizeof(ip))) {
    snprintf(msg, msglen, "fetch() refused: %s resolves to an unprintable address", host);
    return 1;
  }
  if (sb_egress_allowed(ip)) return 0;
  const char* cidr = sb_egress_blocked(bytes, len);
  if (!cidr) return 0;
  snprintf(msg, msglen,
           "fetch() refused: %s resolves to %s, a private or reserved address (%s). An operator can allow it with SB_EGRESS_ALLOW=%s",
           host, ip, cidr, ip);
  return 1;
}
// EGRESS:END

// EGRESS-FD:BEGIN
// SB_EGRESS_FD=N: a sandboxed host (sproutd) opens outbound connections for the
// sprout, which may not open sockets itself. Ask on unix socket N with
// "HOST PORT\n"; the host resolves, applies its policy and answers "ok\n" with the
// connected socket attached (SCM_RIGHTS), or "no MESSAGE\n", which fetch() reports.
// One question at a time (a lock, for async requests on several threads); any
// broken exchange closes N for good, so a late answer can never be taken for the
// next one.
static int sb_egress_fd_ask(int via, const char* host, int port, char* refused, size_t refused_len);
static int sb_egress_fd_connect(int via, const char* host, int port, char* refused, size_t refused_len) {
  static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
  pthread_mutex_lock(&lock);
  int fd = sb_egress_fd_ask(via, host, port, refused, refused_len);
  pthread_mutex_unlock(&lock);
  return fd;
}
static int sb_egress_fd_ask(int via, const char* host, int port, char* refused, size_t refused_len) {
  static int broken = 0;
  if (broken) return -1;
  char line[512];
  int n = snprintf(line, sizeof(line), "%s %d\n", host, port);
  if (n <= 0 || (size_t)n >= sizeof(line)) return -1;
  struct timeval tv; tv.tv_sec = 60; tv.tv_usec = 0;
  setsockopt(via, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
  if (send(via, line, (size_t)n, 0) != n) { broken = 1; close(via); return -1; }
  char answer[512];
  union { struct cmsghdr align; char space[CMSG_SPACE(sizeof(int))]; } control;
  struct iovec io = { answer, sizeof(answer) - 1 };
  struct msghdr msg;
  memset(&msg, 0, sizeof(msg));
  msg.msg_iov = &io; msg.msg_iovlen = 1;
  msg.msg_control = control.space; msg.msg_controllen = sizeof(control.space);
  ssize_t got;
  do { got = recvmsg(via, &msg, 0); } while (got < 0 && errno == EINTR);
  int fd = -1;
  struct cmsghdr* c = got > 0 ? CMSG_FIRSTHDR(&msg) : 0;
  if (c && c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS && c->cmsg_len == CMSG_LEN(sizeof(int)))
    memcpy(&fd, CMSG_DATA(c), sizeof(fd));
  if (got <= 0 || answer[got - 1] != '\n' || (msg.msg_flags & (MSG_TRUNC | MSG_CTRUNC))) {
    if (fd >= 0) close(fd);
    broken = 1; close(via);
    return -1;
  }
  answer[got - 1] = 0;
  if (!strcmp(answer, "ok") && fd >= 0) {
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    return fd;
  }
  if (fd >= 0) close(fd);
  if (!strncmp(answer, "no ", 3) && !refused[0]) snprintf(refused, refused_len, "%s", answer + 3);
  return -1;
}
// EGRESS-FD:END

// refused gets the first refusal; a caller reports it when nothing connected.
static int sb_tcp_connect(const char* host, int port, char* refused, size_t refused_len) {
  const char* via = getenv("SB_EGRESS_FD");
  if (via && *via) return sb_egress_fd_connect(atoi(via), host, port, refused, refused_len);
  struct addrinfo hints, *res = 0, *it;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  char portstr[16];
  snprintf(portstr, sizeof(portstr), "%d", port);
  // URL.hostname keeps an IPv6 literal's brackets; getaddrinfo wants it bare.
  char bare[256];
  size_t hl = strlen(host);
  if (hl > 2 && hl < sizeof(bare) && host[0] == '[' && host[hl - 1] == ']') {
    memcpy(bare, host + 1, hl - 2);
    bare[hl - 2] = 0;
  } else {
    snprintf(bare, sizeof(bare), "%s", host);
  }
  if (getaddrinfo(bare, portstr, &hints, &res) != 0 || !res) return -1;
  int fd = -1;
  for (it = res; it; it = it->ai_next) {
    char why[512];
    if (sb_egress_refused(host, it->ai_addr, why, sizeof(why))) {
      if (!refused[0]) snprintf(refused, refused_len, "%s", why);
      continue;
    }
    fd = socket(it->ai_family, it->ai_socktype, it->ai_protocol);
    if (fd < 0) continue;
    struct timeval tv; tv.tv_sec = 30; tv.tv_usec = 0;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    if (connect(fd, it->ai_addr, it->ai_addrlen) == 0) break;
    close(fd);
    fd = -1;
  }
  freeaddrinfo(res);
  return fd;
}

// body_len, not strlen(body): a binary body can contain NUL bytes (#232).
// Host carries the port unless it is the scheme's default (RFC 9110 7.2).
static void sb_build_request(sb_buf* req, const char* host, int port, int default_port, const char* path, const char* method,
                             const char* headers, const char* body, size_t body_len) {
  sb_puts(req, method); sb_puts(req, " "); sb_puts(req, path); sb_puts(req, " HTTP/1.1\r\n");
  sb_puts(req, "Host: "); sb_puts(req, host);
  if (port != default_port) { char p[16]; snprintf(p, sizeof(p), ":%d", port); sb_puts(req, p); }
  sb_puts(req, "\r\n");
  sb_puts(req, "Connection: close\r\n");
  sb_puts(req, "Accept-Encoding: identity\r\n");
  if (headers && *headers) sb_puts(req, headers);
  size_t blen = body ? body_len : 0;
  if (blen) {
    char cl[64];
    int k = snprintf(cl, sizeof(cl), "Content-Length: %zu\r\n", blen);
    sb_put(req, cl, (size_t)k);
  }
  sb_puts(req, "\r\n");
  if (blen) sb_put(req, body, blen);
}

// Turn a whole raw response into the reply frame. Returns malloc'd JSON.
static char* sb_parse_response(sb_buf* raw) {
  sb_buf out = { 0, 0, 0 };
  const char* head_end = raw->p ? strstr(raw->p, "\r\n\r\n") : 0;
  if (!head_end) {
    sb_puts(&out, "{\"ok\":false,\"error\":\"malformed response\"}");
    return out.p;
  }
  int status = 0;
  {
    const char* sp = strchr(raw->p, ' ');
    if (sp) status = atoi(sp + 1);
  }

  int chunked = 0;
  long content_length = -1;
  sb_buf hdrs = { 0, 0, 0 };
  sb_puts(&hdrs, "[");
  {
    const char* line = strstr(raw->p, "\r\n");
    int first = 1;
    while (line && line + 2 < head_end) {
      line += 2;
      const char* eol = strstr(line, "\r\n");
      if (!eol || eol > head_end) break;
      const char* colon = memchr(line, ':', (size_t)(eol - line));
      if (colon) {
        const char* vs = colon + 1;
        while (vs < eol && (*vs == ' ' || *vs == 9)) vs++;
        size_t klen = (size_t)(colon - line);
        if (!first) sb_puts(&hdrs, ",");
        first = 0;
        sb_puts(&hdrs, "[");
        sb_putjson(&hdrs, line, klen);
        sb_puts(&hdrs, ",");
        sb_putjson(&hdrs, vs, (size_t)(eol - vs));
        sb_puts(&hdrs, "]");
        if (klen == 17 && strncasecmp(line, "transfer-encoding", 17) == 0 && strncasecmp(vs, "chunked", 7) == 0)
          chunked = 1;
        if (klen == 14 && strncasecmp(line, "content-length", 14) == 0) content_length = atol(vs);
      }
      line = eol;
    }
  }
  sb_puts(&hdrs, "]");

  const char* bodyp = head_end + 4;
  size_t bodylen = raw->len - (size_t)(bodyp - raw->p);

  sb_buf decoded = { 0, 0, 0 };
  if (chunked) {
    const char* p = bodyp;
    const char* end = bodyp + bodylen;
    while (p < end) {
      char* stop = 0;
      long size = strtol(p, &stop, 16);
      if (!stop || size <= 0) break;
      p = strstr(stop, "\r\n");
      if (!p) break;
      p += 2;
      if (p + size > end) break;
      sb_put(&decoded, p, (size_t)size);
      p += size + 2;
    }
    bodyp = decoded.p ? decoded.p : "";
    bodylen = decoded.len;
  }

  char head[96];
  int k = snprintf(head, sizeof(head), "{\"ok\":true,\"status\":%d,\"complete\":%d,\"headers\":",
                   status, (content_length < 0 || (long)bodylen >= content_length) ? 1 : 0);
  sb_put(&out, head, (size_t)k);
  sb_put(&out, hdrs.p, hdrs.len);
  sb_puts(&out, ",\"body\":");
  sb_putjson(&out, bodyp, bodylen);
  sb_puts(&out, "}");
  free(hdrs.p);
  free(decoded.p);
  return out.p;
}

static char* sb_error_json(const char* prefix, const char* detail) {
  sb_buf out = { 0, 0, 0 };
  sb_puts(&out, "{\"ok\":false,\"error\":");
  sb_buf msg = { 0, 0, 0 };
  sb_puts(&msg, prefix);
  if (detail) { sb_puts(&msg, detail); }
  sb_putjson_text(&out, msg.p ? msg.p : "", msg.len);
  sb_puts(&out, "}");
  free(msg.p);
  return out.p;
}

static char* sb_http_plain(const char* host, int port, const char* path, const char* method,
                           const char* headers, const char* body, size_t body_len) {
  char refused[512] = "";
  int fd = sb_tcp_connect(host, port, refused, sizeof(refused));
  if (fd < 0) return refused[0] ? sb_error_json(refused, 0) : sb_error_json("could not connect to ", host);

  sb_buf req = { 0, 0, 0 };
  sb_build_request(&req, host, port, 80, path, method, headers, body, body_len);
  size_t sent = 0;
  while (sent < req.len) {
    long n = write(fd, req.p + sent, req.len - sent);
    if (n <= 0) { if (n < 0 && errno == EINTR) continue; break; }
    sent += (size_t)n;
  }
  free(req.p);

  sb_buf raw = { 0, 0, 0 };
  char chunk[8192];
  int too_big = 0;
  while (1) {
    long n = read(fd, chunk, sizeof(chunk));
    if (n > 0) {
      if (raw.len + (size_t)n > sb_fetch_max()) { too_big = 1; break; }
      sb_put(&raw, chunk, (size_t)n);
      continue;
    }
    if (n < 0 && errno == EINTR) continue;
    break;
  }
  close(fd);
  if (too_big) { free(raw.p); return sb_error_json("response exceeds SB_FETCH_MAX_BYTES from ", host); }
  char* out = sb_parse_response(&raw);
  free(raw.p);
  return out;
}

// --- TLS ---------------------------------------------------------------------
// Trust anchors come from src/bearssl.ts: the Mozilla root set, compiled in.
extern const br_x509_trust_anchor sb_trust_anchors[];
extern const size_t sb_trust_anchor_count;

// SB_CA_BUNDLE: extra roots, read at run time.
//
// Adds trust, never removes it — the compiled-in Mozilla set stays in force, so
// pointing at a file with one corporate CA cannot silently stop public
// certificates from validating. Nothing here can disable verification.
//
// Adapted from BearSSL's own tools/certs.c (same MIT licence), which is the
// reference for turning a DER certificate into a trust anchor.
static br_x509_trust_anchor* sb_ca_extra = 0;
static size_t sb_ca_extra_count = 0;
static const br_x509_trust_anchor* sb_all_anchors = 0;
static size_t sb_all_anchor_count = 0;

static void sb_buf_append(void* ctx, const void* buf, size_t len) {
  sb_put((sb_buf*)ctx, (const char*)buf, len);
}

static unsigned char* sb_blobdup(const void* src, size_t len) {
  unsigned char* out = (unsigned char*)malloc(len ? len : 1);
  if (out && len) memcpy(out, src, len);
  return out;
}

// One DER certificate -> one appended trust anchor. Returns 0 on success.
static int sb_add_anchor(const unsigned char* der, size_t len) {
  br_x509_decoder_context dc;
  sb_buf dn = { 0, 0, 0 };
  br_x509_decoder_init(&dc, sb_buf_append, &dn);
  br_x509_decoder_push(&dc, der, len);
  br_x509_pkey* pk = br_x509_decoder_get_pkey(&dc);
  if (!pk) { free(dn.p); return -1; }

  br_x509_trust_anchor ta;
  memset(&ta, 0, sizeof(ta));
  ta.dn.data = (unsigned char*)dn.p;
  ta.dn.len = dn.len;
  ta.flags = br_x509_decoder_isCA(&dc) ? BR_X509_TA_CA : 0;
  if (pk->key_type == BR_KEYTYPE_RSA) {
    ta.pkey.key_type = BR_KEYTYPE_RSA;
    ta.pkey.key.rsa.n = sb_blobdup(pk->key.rsa.n, pk->key.rsa.nlen);
    ta.pkey.key.rsa.nlen = pk->key.rsa.nlen;
    ta.pkey.key.rsa.e = sb_blobdup(pk->key.rsa.e, pk->key.rsa.elen);
    ta.pkey.key.rsa.elen = pk->key.rsa.elen;
  } else if (pk->key_type == BR_KEYTYPE_EC) {
    ta.pkey.key_type = BR_KEYTYPE_EC;
    ta.pkey.key.ec.curve = pk->key.ec.curve;
    ta.pkey.key.ec.q = sb_blobdup(pk->key.ec.q, pk->key.ec.qlen);
    ta.pkey.key.ec.qlen = pk->key.ec.qlen;
  } else {
    free(dn.p);
    return -1; // a key type BearSSL cannot verify with
  }

  br_x509_trust_anchor* grown =
    (br_x509_trust_anchor*)realloc(sb_ca_extra, (sb_ca_extra_count + 1) * sizeof(br_x509_trust_anchor));
  if (!grown) { free(dn.p); return -1; }
  sb_ca_extra = grown;
  sb_ca_extra[sb_ca_extra_count++] = ta;
  return 0;
}

// Read every CERTIFICATE block out of a PEM file and add it.
static void sb_load_ca_bundle(const char* path) {
  FILE* f = fopen(path, "rb");
  if (!f) {
    fprintf(stderr, "sproutboat: SB_CA_BUNDLE %s could not be opened; using the built-in roots only\n", path);
    return;
  }
  sb_buf pem = { 0, 0, 0 };
  char chunk[8192];
  size_t n;
  while ((n = fread(chunk, 1, sizeof(chunk), f)) > 0) sb_put(&pem, chunk, n);
  fclose(f);

  br_pem_decoder_context pc;
  br_pem_decoder_init(&pc);
  sb_buf der = { 0, 0, 0 };
  int in_cert = 0, added = 0;
  size_t off = 0;
  while (off < pem.len) {
    size_t used = br_pem_decoder_push(&pc, pem.p + off, pem.len - off);
    off += used;
    switch (br_pem_decoder_event(&pc)) {
      case BR_PEM_BEGIN_OBJ: {
        const char* name = br_pem_decoder_name(&pc);
        in_cert = name && (strcmp(name, "CERTIFICATE") == 0 || strcmp(name, "X509 CERTIFICATE") == 0);
        der.len = 0;
        if (in_cert) br_pem_decoder_setdest(&pc, sb_buf_append, &der);
        else br_pem_decoder_setdest(&pc, 0, 0);
        break;
      }
      case BR_PEM_END_OBJ:
        if (in_cert && der.len && sb_add_anchor((const unsigned char*)der.p, der.len) == 0) added++;
        der.len = 0;
        in_cert = 0;
        break;
      case BR_PEM_ERROR:
        fprintf(stderr, "sproutboat: SB_CA_BUNDLE %s is not valid PEM\n", path);
        off = pem.len;
        break;
      default:
        break;
    }
    if (used == 0 && br_pem_decoder_event(&pc) == 0) break; // no progress, no event
  }
  free(pem.p);
  free(der.p);
  if (added == 0) fprintf(stderr, "sproutboat: SB_CA_BUNDLE %s held no usable certificates\n", path);
}

// The anchor set every handshake verifies against: built in, plus SB_CA_BUNDLE.
static void sb_init_anchors(void) {
  if (sb_all_anchors) return;
  const char* path = getenv("SB_CA_BUNDLE");
  if (path && *path) sb_load_ca_bundle(path);
  if (sb_ca_extra_count == 0) {
    sb_all_anchors = sb_trust_anchors;
    sb_all_anchor_count = sb_trust_anchor_count;
    return;
  }
  size_t total = sb_trust_anchor_count + sb_ca_extra_count;
  br_x509_trust_anchor* all = (br_x509_trust_anchor*)malloc(total * sizeof(br_x509_trust_anchor));
  if (!all) {
    sb_all_anchors = sb_trust_anchors;
    sb_all_anchor_count = sb_trust_anchor_count;
    return;
  }
  memcpy(all, sb_trust_anchors, sb_trust_anchor_count * sizeof(br_x509_trust_anchor));
  memcpy(all + sb_trust_anchor_count, sb_ca_extra, sb_ca_extra_count * sizeof(br_x509_trust_anchor));
  sb_all_anchors = all;
  sb_all_anchor_count = total;
}

static int sb_sock_read(void* ctx, unsigned char* buf, size_t len) {
  for (;;) {
    ssize_t n = read(*(int*)ctx, buf, len);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return -1;
    return (int)n;
  }
}
static int sb_sock_write(void* ctx, const unsigned char* buf, size_t len) {
  for (;;) {
    ssize_t n = write(*(int*)ctx, buf, len);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return -1;
    return (int)n;
  }
}

static char* sb_https(const char* host, int port, const char* path, const char* method,
                      const char* headers, const char* body, size_t body_len) {
  char refused[512] = "";
  int fd = sb_tcp_connect(host, port, refused, sizeof(refused));
  if (fd < 0) return refused[0] ? sb_error_json(refused, 0) : sb_error_json("could not connect to ", host);

  br_ssl_client_context* sc = (br_ssl_client_context*)malloc(sizeof(br_ssl_client_context));
  br_x509_minimal_context* xc = (br_x509_minimal_context*)malloc(sizeof(br_x509_minimal_context));
  unsigned char* iobuf = (unsigned char*)malloc(BR_SSL_BUFSIZE_BIDI);
  if (!sc || !xc || !iobuf) {
    free(sc); free(xc); free(iobuf); close(fd);
    return sb_error_json("out of memory setting up TLS for ", host);
  }
  br_sslio_context ioc;
  sb_init_anchors();
  br_ssl_client_init_full(sc, xc, sb_all_anchors, sb_all_anchor_count);
  br_ssl_engine_set_buffer(&sc->eng, iobuf, BR_SSL_BUFSIZE_BIDI, 1);
  br_ssl_client_reset(sc, host, 0);
  br_sslio_init(&ioc, &sc->eng, sb_sock_read, &fd, sb_sock_write, &fd);

  sb_buf req = { 0, 0, 0 };
  sb_build_request(&req, host, port, 443, path, method, headers, body, body_len);
  int wrote = br_sslio_write_all(&ioc, req.p, req.len);
  free(req.p);
  if (wrote != 0) {
    char detail[96];
    snprintf(detail, sizeof(detail), "%s (tls error %d)", host, br_ssl_engine_last_error(&sc->eng));
    free(sc); free(xc); free(iobuf); close(fd);
    return sb_error_json("TLS handshake failed for ", detail);
  }
  br_sslio_flush(&ioc);

  sb_buf raw = { 0, 0, 0 };
  char chunk[8192];
  int rc, too_big = 0;
  while ((rc = br_sslio_read(&ioc, chunk, sizeof(chunk))) > 0) {
    if (raw.len + (size_t)rc > sb_fetch_max()) { too_big = 1; break; }
    sb_put(&raw, chunk, (size_t)rc);
  }
  int err = br_ssl_engine_last_error(&sc->eng);
  free(sc); free(xc); free(iobuf);
  close(fd);
  if (too_big) { free(raw.p); return sb_error_json("response exceeds SB_FETCH_MAX_BYTES from ", host); }

  // BR_ERR_IO here means the peer closed without close_notify, which is what
  // most servers do on Connection: close. It is indistinguishable from a
  // truncation attack on its own, so the reply carries "complete" (whether the
  // body satisfied Content-Length) and the JS side decides.
  char* out = sb_parse_response(&raw);
  free(raw.p);
  if (err != 0 && err != BR_ERR_IO) {
    free(out);
    char detail[64];
    snprintf(detail, sizeof(detail), "tls error %d", err);
    return sb_error_json("", detail);
  }
  if (err == BR_ERR_IO) {
    // Mark it so JS can refuse a body that was cut short.
    char* marked = (char*)malloc(strlen(out) + 32);
    if (marked) {
      size_t n = strlen(out);
      memcpy(marked, out, n - 1);
      memcpy(marked + n - 1, ",\"unclean\":true}", 17);
      free(out);
      return marked;
    }
  }
  return out;
}

static char* sb_http_request(const char* host, int port, const char* path, const char* method,
                             const char* headers, const char* body, size_t body_len, int tls) {
  return tls ? sb_https(host, port, path, method, headers, body, body_len)
             : sb_http_plain(host, port, path, method, headers, body, body_len);
}

// ASYNC:BEGIN
// Async outbound HTTP for a host with an event loop (sproutd, B18). The host calls
// sb_async_enable() and watches the fd it returns. fetch() then queues each request
// for a small pool of threads that run the blocking client above, and returns at
// once. A finished request is queued and signalled on the fd; the host calls
// sb_async_drain(), which fires the JS callback registered under the request's
// timer id. Threads touch only their own malloc'd job, never the JS heap. Without
// sb_async_enable() (standalone sprouts) nothing here runs.
void porf_native_fetch_fire_timer(u32 id);
void porf_native_fetch_timer_clear(u32 id);
typedef struct sb_async_job {
  struct sb_async_job* next;
  u32 id;
  int port, tls;
  char *host, *path, *method, *headers, *body, *out;
  size_t body_len;
} sb_async_job;
#define SB_ASYNC_THREADS 8
static pthread_mutex_t sb_async_lock = PTHREAD_MUTEX_INITIALIZER;
static sb_async_job *sb_async_queue = 0, *sb_async_queue_tail = 0, *sb_async_done = 0, *sb_async_current = 0;
static int sb_async_pipe[2] = { -1, -1 };
static int sb_async_threads = 0;

int sb_async_enable(void) {
  if (sb_async_pipe[0] >= 0) return sb_async_pipe[0];
  if (pipe(sb_async_pipe) != 0) return -1;
  for (int i = 0; i < 2; i++) {
    fcntl(sb_async_pipe[i], F_SETFD, FD_CLOEXEC);
    fcntl(sb_async_pipe[i], F_SETFL, fcntl(sb_async_pipe[i], F_GETFL) | O_NONBLOCK);
  }
  return sb_async_pipe[0];
}
int sb_async_enabled(void) { return sb_async_pipe[0] >= 0; }
static void sb_async_free(sb_async_job* j) {
  free(j->host); free(j->path); free(j->method); free(j->headers); free(j->body); free(j->out); free(j);
}
// Called with sb_async_lock held.
static void sb_async_finish_locked(sb_async_job* j) {
  j->next = sb_async_done;
  sb_async_done = j;
  char one = 1;
  while (write(sb_async_pipe[1], &one, 1) < 0 && errno == EINTR) {}
}
static void* sb_async_thread(void* unused) {
  (void)unused;
  for (;;) {
    pthread_mutex_lock(&sb_async_lock);
    sb_async_job* j = sb_async_queue;
    if (!j) { sb_async_threads--; pthread_mutex_unlock(&sb_async_lock); return 0; }
    sb_async_queue = j->next;
    if (!sb_async_queue) sb_async_queue_tail = 0;
    pthread_mutex_unlock(&sb_async_lock);
    j->out = sb_http_request(j->host, j->port, j->path, j->method, j->headers, j->body, j->body_len, j->tls);
    pthread_mutex_lock(&sb_async_lock);
    sb_async_finish_locked(j);
    pthread_mutex_unlock(&sb_async_lock);
  }
}
static void sb_async_start(sb_async_job* j) {
  sb_init_anchors();  // built once, before any thread reads them
  pthread_mutex_lock(&sb_async_lock);
  j->next = 0;
  if (sb_async_queue_tail) sb_async_queue_tail->next = j; else sb_async_queue = j;
  sb_async_queue_tail = j;
  int spawn = sb_async_threads < SB_ASYNC_THREADS;
  if (spawn) sb_async_threads++;
  pthread_mutex_unlock(&sb_async_lock);
  if (!spawn) return;
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  pthread_attr_setstacksize(&attr, 256 * 1024);
  pthread_t thread;
  int failed = pthread_create(&thread, &attr, sb_async_thread, 0);
  pthread_attr_destroy(&attr);
  if (!failed) return;
  // No thread (a pids limit): a running thread takes the queue; with none, fail it.
  pthread_mutex_lock(&sb_async_lock);
  if (--sb_async_threads == 0) {
    while (sb_async_queue) {
      sb_async_job* q = sb_async_queue;
      sb_async_queue = q->next;
      q->out = sb_error_json("could not start a request: ", strerror(failed));
      sb_async_finish_locked(q);
    }
    sb_async_queue_tail = 0;
  }
  pthread_mutex_unlock(&sb_async_lock);
}
// The inline C of __sbHttpRaw and __sbHttpAsyncResult calls these by prototype: Porffor
// may emit a function's body before this block.
void sb_async_submit(u32 id, int port, int tls, char* host, char* path, char* method, char* headers,
                     char* body, size_t body_len) {
  sb_async_job* j = (sb_async_job*)calloc(1, sizeof(sb_async_job));
  if (!j) abort();
  j->id = id; j->port = port; j->tls = tls;
  j->host = host; j->path = path; j->method = method; j->headers = headers;
  j->body = body; j->body_len = body_len;
  sb_async_start(j);
}
const char* sb_async_reply(u32 id) {
  return sb_async_current && sb_async_current->id == id ? sb_async_current->out : 0;
}
// Set by the outbound WebSocket code below (a constructor there), which this block stands without.
static void (*sb_wsc_drain_hook)(void) = 0;
// Host: the fd became readable. Fires each finished request's callback.
void sb_async_drain(void) {
  char buf[64];
  while (read(sb_async_pipe[0], buf, sizeof(buf)) > 0) {}
  if (sb_wsc_drain_hook) sb_wsc_drain_hook();
  pthread_mutex_lock(&sb_async_lock);
  sb_async_job* done = sb_async_done;
  sb_async_done = 0;
  pthread_mutex_unlock(&sb_async_lock);
  while (done) {
    sb_async_job* j = done;
    done = j->next;
    porf_native_fetch_timer_clear(j->id);  // the host's placeholder timer
    sb_async_current = j;                  // read by __sbHttpAsyncResult in the callback
    porf_native_fetch_fire_timer(j->id);
    sb_async_current = 0;
    sb_async_free(j);
  }
}
// ASYNC:END

// WSC:BEGIN
// Outbound WebSockets (compatibility date 2026-11-01): new WebSocket(url) and fetch() with
// Upgrade: websocket. One I/O thread per socket connects (through sb_tcp_connect, so the
// egress policy and a sandboxed host's egress socket apply), does the TLS handshake for wss,
// sends the upgrade request, then multiplexes the socket with a wake pipe: frames the JS side
// queued (already masked) go out, frames that arrive are parsed into events. The JS side polls
// the events through the same ops as a host socket (sb_ws_hook; ids here have the top bit set):
// 'u' connect, 't' 'b' send, 'c' close, 'p' 'i' take an event, 'k' acknowledge bytes dispatched,
// 'w' park a timer for the next event, 'r' release. Threads touch only their own malloc'd
// state, never the JS heap; the loop is woken through the async pipe (sproutd) or the host's
// waker (the standalone server), then sb_async_drain() fires the parked timers.
// Event kinds: 0 text, 1 binary, 2 close (code, reason), 3 connection lost (no close frame, or
// it never opened: data holds the reason), 4 opened (data holds the chosen subprotocol), 5 the
// server answered the upgrade with another status (code; data holds its head and what followed).
#include <poll.h>
#include <fcntl.h>
#include <unistd.h>
#define SB_WSC_BIT 0x80000000u
#define SB_WSC_MAX 64
#define SB_WSC_MAXMSG (32u << 20)
#define SB_WSC_WINDOW (4u << 20)
typedef struct sb_wsc_ev { struct sb_wsc_ev* next; int kind; unsigned code; char* data; size_t len; } sb_wsc_ev;
typedef struct sb_wsc {
  struct sb_wsc* next;
  unsigned id;
  pthread_mutex_t lock;
  int wake[2];
  sb_wsc_ev *evh, *evt;
  unsigned waiter;
  int wake_pending;
  size_t unacked;
  unsigned char* outq; size_t outq_len, outq_cap;
  int released, finished, close_queued;
  uint64_t rng;
  char *host, *path, *headers, *protocols;
  int port, tls;
} sb_wsc;
static pthread_mutex_t sb_wsc_lock = PTHREAD_MUTEX_INITIALIZER;
static sb_wsc* sb_wscs = 0;
static unsigned sb_wsc_next = 0;
static void (*sb_wsc_waker)(void) = 0;
void sb_async_set_waker(void (*wake)(void)) { sb_wsc_waker = wake; }
static int sb_wsc_pipe_enabled(void) { return sb_async_pipe[0] >= 0; }
static void sb_async_poke(void) {
  char one = 1;
  while (write(sb_async_pipe[1], &one, 1) < 0 && errno == EINTR) {}
}

static uint64_t sb_wsc_rand(uint64_t* s) {
  uint64_t x = *s;
  x ^= x << 13; x ^= x >> 7; x ^= x << 17;
  *s = x;
  return x * 0x2545F4914F6CDD1DULL;
}
static void sb_wsc_seed(sb_wsc* c) {
  uint64_t seed = 0;
  int fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
  if (fd >= 0) { if (read(fd, &seed, sizeof(seed)) != (ssize_t)sizeof(seed)) seed = 0; close(fd); }
  if (!seed) { struct timeval tv; gettimeofday(&tv, 0); seed = (uint64_t)tv.tv_usec * 1000003ULL ^ (uint64_t)tv.tv_sec ^ (uint64_t)(uintptr_t)c; }
  c->rng = seed ? seed : 88172645463325252ULL;
}

// Wakes the loop: the async pipe where the host watches it, and the host's waker.
static void sb_wsc_signal(void) {
  if (sb_wsc_pipe_enabled()) sb_async_poke();
  if (sb_wsc_waker) sb_wsc_waker();
}
static void sb_wsc_push(sb_wsc* c, int kind, unsigned code, const char* data, size_t len) {
  sb_wsc_ev* e = (sb_wsc_ev*)calloc(1, sizeof(sb_wsc_ev));
  if (!e) return;
  e->kind = kind; e->code = code; e->len = len;
  if (len) {
    e->data = (char*)malloc(len);
    if (!e->data) { free(e); return; }
    memcpy(e->data, data, len);
  }
  pthread_mutex_lock(&c->lock);
  if (c->evt) c->evt->next = e; else c->evh = e;
  c->evt = e;
  if (kind <= 1) c->unacked += len;
  if (c->waiter) c->wake_pending = 1;
  pthread_mutex_unlock(&c->lock);
  sb_wsc_signal();
}
static void sb_wsc_wake_thread(sb_wsc* c) {
  char one = 1;
  while (write(c->wake[1], &one, 1) < 0 && errno == EINTR) {}
}

// One masked client frame, appended to the socket's queue for the I/O thread.
static int sb_wsc_frame(sb_wsc* c, int opcode, const char* data, size_t len, unsigned code, int with_code) {
  size_t payload = len + (with_code ? 2 : 0);
  unsigned char head[14];
  size_t h = 0;
  head[h++] = (unsigned char)(0x80 | opcode);
  if (payload < 126) head[h++] = (unsigned char)(0x80 | payload);
  else if (payload < 65536) { head[h++] = 0x80 | 126; head[h++] = (unsigned char)(payload >> 8); head[h++] = (unsigned char)payload; }
  else { head[h++] = 0x80 | 127; for (int i = 7; i >= 0; i--) head[h++] = (unsigned char)((uint64_t)payload >> (8 * i)); }
  pthread_mutex_lock(&c->lock);
  uint32_t m = (uint32_t)sb_wsc_rand(&c->rng);
  unsigned char mask[4] = { (unsigned char)m, (unsigned char)(m >> 8), (unsigned char)(m >> 16), (unsigned char)(m >> 24) };
  memcpy(head + h, mask, 4); h += 4;
  size_t need = c->outq_len + h + payload;
  if (need > c->outq_cap) {
    size_t cap = c->outq_cap ? c->outq_cap : 4096;
    while (cap < need) cap *= 2;
    unsigned char* grown = (unsigned char*)realloc(c->outq, cap);
    if (!grown) { pthread_mutex_unlock(&c->lock); return -1; }
    c->outq = grown; c->outq_cap = cap;
  }
  memcpy(c->outq + c->outq_len, head, h);
  unsigned char* at = c->outq + c->outq_len + h;
  size_t i = 0;
  if (with_code) { at[0] = (unsigned char)(code >> 8) ^ mask[0]; at[1] = (unsigned char)code ^ mask[1]; i = 2; }
  for (size_t k = 0; k < len; k++, i++) at[i] = (unsigned char)data[k] ^ mask[i & 3];
  c->outq_len += h + payload;
  pthread_mutex_unlock(&c->lock);
  sb_wsc_wake_thread(c);
  return 0;
}

// --- the socket the I/O thread owns: plain, or TLS through BearSSL's engine ---
typedef struct {
  int fd, tls;
  br_ssl_client_context* sc;
  br_x509_minimal_context* xc;
  unsigned char* iobuf;
} sb_wsio;

static int sb_wsio_wait(int fd, int wakefd, short events, int ms) {
  struct pollfd p[2];
  p[0].fd = fd; p[0].events = fd >= 0 ? events : 0; p[0].revents = 0;
  p[1].fd = wakefd; p[1].events = POLLIN; p[1].revents = 0;
  int rc;
  do { rc = poll(p, 2, ms); } while (rc < 0 && errno == EINTR);
  if (rc < 0) return -1;
  int out = 0;
  if (p[0].revents & (events | POLLERR | POLLHUP)) out |= 1;
  if (p[1].revents & POLLIN) out |= 2;
  return out;
}
static void sb_wsc_drain_wake(sb_wsc* c) {
  char buf[64];
  while (read(c->wake[0], buf, sizeof(buf)) > 0) {}
}
// Writes everything in buf (the socket is non-blocking), waiting for it to drain.
static int sb_wsio_raw_write(sb_wsio* io, const unsigned char* buf, size_t len) {
  size_t at = 0;
  while (at < len) {
    ssize_t n = write(io->fd, buf + at, len - at);
    if (n > 0) { at += (size_t)n; continue; }
    if (n < 0 && errno == EINTR) continue;
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      struct pollfd p; p.fd = io->fd; p.events = POLLOUT; p.revents = 0;
      int rc = poll(&p, 1, 30000);
      if (rc <= 0) return -1;
      continue;
    }
    return -1;
  }
  return 0;
}

// Moves bytes both ways until there is application data to hand over (returned in buf, up to
// cap), the wake pipe fires or the timeout passes (0, or -2 for the timeout when ms >= 0), or the
// connection ends (-1). out/outlen is application data to send first. With may_read false (the
// reader is far behind) it only sends, and waits for the wake pipe.
static long sb_wsio_pump(sb_wsc* c, sb_wsio* io, unsigned char* buf, size_t cap, unsigned char* out, size_t* outlen, int may_read, int ms) {
  if (!io->tls) {
    if (*outlen) {
      if (sb_wsio_raw_write(io, out, *outlen) != 0) return -1;
      *outlen = 0;
    }
    for (;;) {
      if (may_read) {
        ssize_t n = read(io->fd, buf, cap);
        if (n > 0) return (long)n;
        if (n == 0) return -1;
        if (errno == EINTR) continue;
        if (errno != EAGAIN && errno != EWOULDBLOCK) return -1;
      }
      int w = may_read ? sb_wsio_wait(io->fd, c->wake[0], POLLIN, ms) : sb_wsio_wait(-1, c->wake[0], POLLIN, ms);
      if (w < 0) return -1;
      if (w & 2) return 0;
      if (w == 0 && ms >= 0) return -2;
    }
  }
  br_ssl_engine_context* eng = &io->sc->eng;
  for (;;) {
    unsigned st = br_ssl_engine_current_state(eng);
    if (st & BR_SSL_CLOSED) return -1;
    if (st & BR_SSL_SENDREC) {
      size_t n; unsigned char* b = br_ssl_engine_sendrec_buf(eng, &n);
      if (sb_wsio_raw_write(io, b, n) != 0) return -1;
      br_ssl_engine_sendrec_ack(eng, n);
      continue;
    }
    if ((st & BR_SSL_RECVAPP) && may_read) {
      size_t n; unsigned char* b = br_ssl_engine_recvapp_buf(eng, &n);
      if (n > cap) n = cap;
      memcpy(buf, b, n);
      br_ssl_engine_recvapp_ack(eng, n);
      return (long)n;
    }
    if ((st & BR_SSL_SENDAPP) && *outlen) {
      size_t n; unsigned char* b = br_ssl_engine_sendapp_buf(eng, &n);
      if (n > *outlen) n = *outlen;
      memcpy(b, out, n);
      br_ssl_engine_sendapp_ack(eng, n);
      memmove(out, out + n, *outlen - n);
      *outlen -= n;
      if (*outlen == 0) br_ssl_engine_flush(eng, 0);
      continue;
    }
    // Handshaking, or waiting for the peer: read records while the reader may; else only wake.
    int reading = (st & BR_SSL_RECVREC) && (may_read || !(st & BR_SSL_SENDAPP));
    if (reading) {
      size_t n; unsigned char* b = br_ssl_engine_recvrec_buf(eng, &n);
      ssize_t got = read(io->fd, b, n);
      if (got > 0) { br_ssl_engine_recvrec_ack(eng, (size_t)got); continue; }
      if (got == 0) return -1;
      if (errno == EINTR) continue;
      if (errno != EAGAIN && errno != EWOULDBLOCK) return -1;
    }
    int w = sb_wsio_wait(reading ? io->fd : -1, c->wake[0], POLLIN, ms);
    if (w < 0) return -1;
    if (w & 2) return 0;
    if (w == 0 && ms >= 0) return -2;
  }
}

static int sb_wsio_open(sb_wsio* io, const char* host, int port, int tls, char* why, size_t whylen) {
  memset(io, 0, sizeof(*io));
  io->fd = sb_tcp_connect(host, port, why, whylen);
  if (io->fd < 0) { if (!why[0]) snprintf(why, whylen, "could not connect to %s", host); return -1; }
  struct timeval none; none.tv_sec = 0; none.tv_usec = 0;
  setsockopt(io->fd, SOL_SOCKET, SO_RCVTIMEO, &none, sizeof(none));
  setsockopt(io->fd, SOL_SOCKET, SO_SNDTIMEO, &none, sizeof(none));
  fcntl(io->fd, F_SETFL, fcntl(io->fd, F_GETFL) | O_NONBLOCK);
  io->tls = tls;
  if (!tls) return 0;
  io->sc = (br_ssl_client_context*)malloc(sizeof(br_ssl_client_context));
  io->xc = (br_x509_minimal_context*)malloc(sizeof(br_x509_minimal_context));
  io->iobuf = (unsigned char*)malloc(BR_SSL_BUFSIZE_BIDI);
  if (!io->sc || !io->xc || !io->iobuf) { snprintf(why, whylen, "out of memory setting up TLS for %s", host); return -1; }
  sb_init_anchors();
  br_ssl_client_init_full(io->sc, io->xc, sb_all_anchors, sb_all_anchor_count);
  br_ssl_engine_set_buffer(&io->sc->eng, io->iobuf, BR_SSL_BUFSIZE_BIDI, 1);
  char bare[256];
  size_t hl = strlen(host);
  if (hl > 2 && hl < sizeof(bare) && host[0] == '[' && host[hl - 1] == ']') { memcpy(bare, host + 1, hl - 2); bare[hl - 2] = 0; }
  else snprintf(bare, sizeof(bare), "%s", host);
  br_ssl_client_reset(io->sc, bare, 0);
  return 0;
}
static void sb_wsio_close(sb_wsio* io) {
  if (io->fd >= 0) close(io->fd);
  free(io->sc); free(io->xc); free(io->iobuf);
  memset(io, 0, sizeof(*io));
  io->fd = -1;
}

static const char sb_wsc_b64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static void sb_wsc_base64(const unsigned char* in, size_t n, char* out) {
  size_t o = 0;
  for (size_t i = 0; i < n; i += 3) {
    unsigned v = (unsigned)in[i] << 16 | (i + 1 < n ? (unsigned)in[i + 1] << 8 : 0) | (i + 2 < n ? in[i + 2] : 0);
    out[o++] = sb_wsc_b64[(v >> 18) & 63];
    out[o++] = sb_wsc_b64[(v >> 12) & 63];
    out[o++] = i + 1 < n ? sb_wsc_b64[(v >> 6) & 63] : '=';
    out[o++] = i + 2 < n ? sb_wsc_b64[v & 63] : '=';
  }
  out[o] = 0;
}

// Messages being assembled and the parser's place in a frame.
typedef struct {
  unsigned char* msg; size_t msg_len, msg_cap; int msg_kind, in_msg;
  unsigned char head[14]; size_t head_got; int in_payload;
  int opcode, fin, masked; uint64_t need, got; unsigned char mask[4];
  unsigned char ctl[125]; size_t ctl_len;
} sb_wsc_parser;

// The connection ends with a close frame of ours and the reason for the app.
static int sb_wsc_fail(sb_wsc* c, unsigned code) {
  sb_wsc_frame(c, 8, 0, 0, code, 1);
  sb_wsc_push(c, 2, code, "", 0);
  return 1;
}

// A control frame is complete. Returns 1 when the connection is over.
static int sb_wsc_control(sb_wsc* c, sb_wsc_parser* p) {
  if (p->opcode == 8) {
    unsigned code = p->ctl_len >= 2 ? ((unsigned)p->ctl[0] << 8 | p->ctl[1]) : 1005;
    pthread_mutex_lock(&c->lock);
    int ours = c->close_queued;
    c->close_queued = 1;
    pthread_mutex_unlock(&c->lock);
    // Echo the close (unless ours went first), then report it.
    if (!ours) sb_wsc_frame(c, 8, (const char*)p->ctl, p->ctl_len >= 2 ? 2 : 0, 0, 0);
    sb_wsc_push(c, 2, code, p->ctl_len > 2 ? (const char*)p->ctl + 2 : "", p->ctl_len > 2 ? p->ctl_len - 2 : 0);
    return 1;
  }
  if (p->opcode == 9) sb_wsc_frame(c, 10, (const char*)p->ctl, p->ctl_len, 0, 0);
  return 0;
}

// Feeds received bytes to the parser. Returns 1 when the socket is over (a close frame, or a
// protocol error already reported), else 0.
static int sb_wsc_feed(sb_wsc* c, sb_wsc_parser* p, const unsigned char* in, size_t n) {
  size_t at = 0;
  for (;;) {
    if (!p->in_payload) {
      if (at >= n) break;
      p->head[p->head_got++] = in[at++];
      if (p->head_got < 2) continue;
      size_t len7 = p->head[1] & 0x7f;
      size_t hdr = 2 + (len7 == 126 ? 2 : len7 == 127 ? 8 : 0) + ((p->head[1] & 0x80) ? 4 : 0);
      if (p->head_got < hdr) continue;
      p->fin = p->head[0] >> 7; p->opcode = p->head[0] & 0xf; p->masked = (p->head[1] & 0x80) != 0;
      uint64_t l = len7;
      if (len7 == 126) l = (uint64_t)p->head[2] << 8 | p->head[3];
      else if (len7 == 127) { l = 0; for (int i = 0; i < 8; i++) l = l << 8 | p->head[2 + i]; }
      if (p->masked) memcpy(p->mask, p->head + hdr - 4, 4);
      p->need = l; p->got = 0; p->ctl_len = 0; p->in_payload = 1;
      if ((p->head[0] & 0x70) || (p->opcode > 2 && p->opcode < 8) || p->opcode > 10) return sb_wsc_fail(c, 1002);
      if (p->opcode >= 8) { if (l > 125 || !p->fin) return sb_wsc_fail(c, 1002); }
      else {
        if (p->opcode == 0 ? !p->in_msg : p->in_msg) return sb_wsc_fail(c, 1002);
        if (p->msg_len + l > SB_WSC_MAXMSG) return sb_wsc_fail(c, 1009);
        if (p->opcode != 0) { p->msg_kind = p->opcode == 1 ? 0 : 1; p->in_msg = 1; }
      }
    }
    size_t take = n - at;
    if ((uint64_t)take > p->need - p->got) take = (size_t)(p->need - p->got);
    if (take) {
      const unsigned char* src = in + at;
      if (p->opcode >= 8) {
        memcpy(p->ctl + p->ctl_len, src, take);
        if (p->masked) for (size_t i = 0; i < take; i++) p->ctl[p->ctl_len + i] ^= p->mask[(p->got + i) & 3];
        p->ctl_len += take;
      } else {
        if (p->msg_len + take > p->msg_cap) {
          size_t cap = p->msg_cap ? p->msg_cap : 4096;
          while (cap < p->msg_len + take) cap *= 2;
          unsigned char* grown = (unsigned char*)realloc(p->msg, cap);
          if (!grown) return sb_wsc_fail(c, 1011);
          p->msg = grown; p->msg_cap = cap;
        }
        memcpy(p->msg + p->msg_len, src, take);
        if (p->masked) for (size_t i = 0; i < take; i++) p->msg[p->msg_len + i] ^= p->mask[(p->got + i) & 3];
        p->msg_len += take;
      }
      p->got += take; at += take;
    }
    if (p->got < p->need) break;
    if (p->opcode >= 8) { if (sb_wsc_control(c, p)) return 1; }
    else if (p->fin) { sb_wsc_push(c, p->msg_kind, 0, (const char*)p->msg, p->msg_len); p->msg_len = 0; p->in_msg = 0; }
    p->in_payload = 0; p->head_got = 0;
  }
  return 0;
}

static void sb_wsc_free(sb_wsc* c) {
  while (c->evh) { sb_wsc_ev* e = c->evh; c->evh = e->next; free(e->data); free(e); }
  close(c->wake[0]); close(c->wake[1]);
  free(c->outq); free(c->host); free(c->path); free(c->headers); free(c->protocols);
  pthread_mutex_destroy(&c->lock);
  free(c);
}

static void* sb_wsc_thread(void* arg) {
  sb_wsc* c = (sb_wsc*)arg;
  sb_wsio io;
  memset(&io, 0, sizeof(io));
  io.fd = -1;
  sb_wsc_parser* p = (sb_wsc_parser*)calloc(1, sizeof(sb_wsc_parser));
  char why[512] = "";
  unsigned char buf[16384];
  unsigned char* wq = 0; size_t wq_len = 0, wq_cap = 0;
  int opened = 0;
  if (!p) goto finish;
  if (sb_wsio_open(&io, c->host, c->port, c->tls, why, sizeof(why)) != 0) goto failed;
  {
    // The upgrade request.
    unsigned char keybytes[16];
    for (int i = 0; i < 16; i += 4) { uint32_t r = (uint32_t)sb_wsc_rand(&c->rng); memcpy(keybytes + i, &r, 4); }
    char key[32];
    sb_wsc_base64(keybytes, 16, key);
    sb_buf req = { 0, 0, 0 };
    sb_puts(&req, "GET "); sb_puts(&req, c->path); sb_puts(&req, " HTTP/1.1\r\nHost: "); sb_puts(&req, c->host);
    if (c->port != (c->tls ? 443 : 80)) { char pt[16]; snprintf(pt, sizeof(pt), ":%d", c->port); sb_puts(&req, pt); }
    sb_puts(&req, "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ");
    sb_puts(&req, key);
    sb_puts(&req, "\r\n");
    if (c->protocols && *c->protocols) { sb_puts(&req, "Sec-WebSocket-Protocol: "); sb_puts(&req, c->protocols); sb_puts(&req, "\r\n"); }
    if (c->headers && *c->headers) sb_puts(&req, c->headers);
    sb_puts(&req, "\r\n");
    size_t reqlen = req.len;
    if (reqlen > wq_cap) { wq = (unsigned char*)malloc(reqlen); wq_cap = reqlen; }
    if (!wq) { free(req.p); snprintf(why, sizeof(why), "out of memory"); goto failed; }
    memcpy(wq, req.p, reqlen); wq_len = reqlen; free(req.p);
    // The answer's head: up to the blank line; what follows it is already frame data.
    char head[8192]; size_t head_len = 0; size_t body_at = 0; int have_head = 0;
    unsigned char acceptwant[32];
    {
      br_sha1_context sh; br_sha1_init(&sh);
      br_sha1_update(&sh, key, strlen(key));
      br_sha1_update(&sh, "258EAFA5-E914-47DA-95CA-C5AB0DC85B11", 36);
      unsigned char dig[20]; br_sha1_out(&sh, dig);
      sb_wsc_base64(dig, 20, (char*)acceptwant);
    }
    while (!have_head) {
      long n = sb_wsio_pump(c, &io, buf, sizeof(buf), wq, &wq_len, 1, 30000);
      if (n == -2) { snprintf(why, sizeof(why), "timed out in the WebSocket handshake with %s", c->host); goto failed; }
      if (n < 0) { snprintf(why, sizeof(why), "connection closed during the WebSocket handshake with %s", c->host); goto failed; }
      if (n == 0) { pthread_mutex_lock(&c->lock); int rel = c->released; pthread_mutex_unlock(&c->lock); sb_wsc_drain_wake(c); if (rel) goto finish; continue; }
      if (head_len + (size_t)n > sizeof(head) - 1) { snprintf(why, sizeof(why), "WebSocket handshake response too large"); goto failed; }
      memcpy(head + head_len, buf, (size_t)n); head_len += (size_t)n;
      for (size_t i = 3; i < head_len; i++) if (head[i - 3] == '\r' && head[i - 2] == '\n' && head[i - 1] == '\r' && head[i] == '\n') { have_head = 1; body_at = i + 1; break; }
    }
    head[head_len] = 0;
    int status = 0;
    if (sscanf(head, "HTTP/1.%*d %d", &status) != 1) {
      snprintf(why, sizeof(why), "WebSocket handshake with %s failed: not an HTTP response", c->host);
      goto failed;
    }
    // Another answer (a 401, a redirect, a 404): the app gets it as the response.
    if (status != 101) { sb_wsc_push(c, 5, (unsigned)status, head, head_len); goto finish; }
    head[body_at - 1] = 0;
    char accept_got[64] = ""; char proto[256] = ""; int upgrade_ok = 0;
    for (char* line = strstr(head, "\r\n"); line; line = strstr(line + 2, "\r\n")) {
      char* l = line + 2;
      if (!strncasecmp(l, "sec-websocket-accept:", 21)) { char* v = l + 21; while (*v == ' ') v++; size_t k = strcspn(v, "\r\n"); if (k < sizeof(accept_got)) { memcpy(accept_got, v, k); accept_got[k] = 0; } }
      else if (!strncasecmp(l, "sec-websocket-protocol:", 23)) { char* v = l + 23; while (*v == ' ') v++; size_t k = strcspn(v, "\r\n"); if (k < sizeof(proto)) { memcpy(proto, v, k); proto[k] = 0; } }
      else if (!strncasecmp(l, "upgrade:", 8)) { char* v = l + 8; while (*v == ' ') v++; if (!strncasecmp(v, "websocket", 9)) upgrade_ok = 1; }
    }
    if (!upgrade_ok || strcmp(accept_got, (const char*)acceptwant)) { snprintf(why, sizeof(why), "WebSocket handshake with %s failed: bad Sec-WebSocket-Accept", c->host); goto failed; }
    opened = 1;
    sb_wsc_push(c, 4, 0, proto, strlen(proto));
    if (head_len > body_at && sb_wsc_feed(c, p, (const unsigned char*)head + body_at, head_len - body_at)) goto closing;
  }
  for (;;) {
    pthread_mutex_lock(&c->lock);
    int rel = c->released;
    size_t window = c->unacked;
    if (c->outq_len) {
      if (wq_len + c->outq_len > wq_cap) {
        size_t cap = wq_cap ? wq_cap : 4096;
        while (cap < wq_len + c->outq_len) cap *= 2;
        unsigned char* grown = (unsigned char*)realloc(wq, cap);
        if (grown) { wq = grown; wq_cap = cap; }
      }
      if (wq_len + c->outq_len <= wq_cap) { memcpy(wq + wq_len, c->outq, c->outq_len); wq_len += c->outq_len; c->outq_len = 0; }
    }
    pthread_mutex_unlock(&c->lock);
    if (rel) goto finish;
    long n = sb_wsio_pump(c, &io, buf, sizeof(buf), wq, &wq_len, window < SB_WSC_WINDOW, -1);
    if (n < 0) break;
    if (n == 0) { sb_wsc_drain_wake(c); continue; }
    if (sb_wsc_feed(c, p, buf, (size_t)n)) goto closing;
  }
  // The peer went without a close frame.
  sb_wsc_push(c, 3, 1006, "", 0);
  goto finish;
closing:
  // Our echo of the close frame is queued: let it go out, then end.
  {
    pthread_mutex_lock(&c->lock);
    if (c->outq_len && wq_len + c->outq_len <= wq_cap) { memcpy(wq + wq_len, c->outq, c->outq_len); wq_len += c->outq_len; c->outq_len = 0; }
    pthread_mutex_unlock(&c->lock);
    if (wq_len) sb_wsio_pump(c, &io, buf, sizeof(buf), wq, &wq_len, 0, 0);
  }
  goto finish;
failed:
  if (!opened) sb_wsc_push(c, 3, 1006, why, strlen(why));
  else sb_wsc_push(c, 3, 1006, "", 0);
finish:
  sb_wsio_close(&io);
  if (p) { free(p->msg); free(p); }
  free(wq);
  pthread_mutex_lock(&c->lock);
  c->finished = 1;
  int rel = c->released;
  pthread_mutex_unlock(&c->lock);
  if (rel) {
    pthread_mutex_lock(&sb_wsc_lock);
    for (sb_wsc** at = &sb_wscs; *at; at = &(*at)->next) if (*at == c) { *at = c->next; break; }
    pthread_mutex_unlock(&sb_wsc_lock);
    sb_wsc_free(c);
  }
  return 0;
}

static sb_wsc* sb_wsc_find(unsigned id) {
  pthread_mutex_lock(&sb_wsc_lock);
  sb_wsc* c = sb_wscs;
  while (c && c->id != id) c = c->next;
  pthread_mutex_unlock(&sb_wsc_lock);
  return c;
}

// Host: fires the timers parked for sockets that have events.
static void sb_wsc_drain(void) {
  for (;;) {
    unsigned timer = 0;
    pthread_mutex_lock(&sb_wsc_lock);
    for (sb_wsc* c = sb_wscs; c; c = c->next) {
      pthread_mutex_lock(&c->lock);
      if (c->waiter && (c->wake_pending || c->evh)) { timer = c->waiter; c->waiter = 0; c->wake_pending = 0; }
      pthread_mutex_unlock(&c->lock);
      if (timer) break;
    }
    pthread_mutex_unlock(&sb_wsc_lock);
    if (!timer) return;
    porf_native_fetch_timer_clear(timer);
    porf_native_fetch_fire_timer(timer);
  }
}

// The JS side's ops. data is borrowed for the call.
static long long sb_wsc_op(int op, unsigned id, const char* data, size_t len, size_t n, char* out, size_t cap) {
  if (op == 'u') {
    // data: host \n port \n tls(0|1) \n path \n protocols \n header lines (to the end)
    sb_wsc* c = (sb_wsc*)calloc(1, sizeof(sb_wsc));
    if (!c) return 0;
    char* copy = (char*)malloc(len + 1);
    if (!copy) { free(c); return 0; }
    memcpy(copy, data, len); copy[len] = 0;
    char* parts[5]; char* cur = copy; int i;
    for (i = 0; i < 5; i++) {
      parts[i] = cur;
      char* nl = strchr(cur, '\n');
      if (!nl) { if (i < 4) { free(copy); free(c); return 0; } cur = cur + strlen(cur); break; }
      *nl = 0; cur = nl + 1;
    }
    c->host = strdup(parts[0]); c->port = atoi(parts[1]); c->tls = atoi(parts[2]);
    c->path = strdup(parts[3]); c->protocols = strdup(parts[4]); c->headers = strdup(cur);
    free(copy);
    if (!c->host || !c->path || !c->protocols || !c->headers || pipe(c->wake) != 0) { free(c->host); free(c->path); free(c->protocols); free(c->headers); free(c); return 0; }
    for (int k = 0; k < 2; k++) { fcntl(c->wake[k], F_SETFD, FD_CLOEXEC); fcntl(c->wake[k], F_SETFL, fcntl(c->wake[k], F_GETFL) | O_NONBLOCK); }
    pthread_mutex_init(&c->lock, 0);
    sb_wsc_seed(c);
    pthread_mutex_lock(&sb_wsc_lock);
    int live = 0;
    for (sb_wsc* k = sb_wscs; k; k = k->next) live++;
    if (live >= SB_WSC_MAX) { pthread_mutex_unlock(&sb_wsc_lock); sb_wsc_free(c); return 0; }
    sb_wsc_next = (sb_wsc_next + 1) & 0x7fffffffu;
    if (!sb_wsc_next) sb_wsc_next = 1;
    c->id = sb_wsc_next | SB_WSC_BIT;
    c->next = sb_wscs; sb_wscs = c;
    pthread_mutex_unlock(&sb_wsc_lock);
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    pthread_attr_setstacksize(&attr, 512 * 1024);
    pthread_t thread;
    int failed = pthread_create(&thread, &attr, sb_wsc_thread, c);
    pthread_attr_destroy(&attr);
    if (failed) {
      pthread_mutex_lock(&sb_wsc_lock);
      for (sb_wsc** at = &sb_wscs; *at; at = &(*at)->next) if (*at == c) { *at = c->next; break; }
      pthread_mutex_unlock(&sb_wsc_lock);
      sb_wsc_free(c);
      return 0;
    }
    return (long long)c->id;
  }
  sb_wsc* c = sb_wsc_find(id);
  if (!c) return op == 'p' || op == 'k' || op == 'w' || op == 'r' ? 0 : -1;
  switch (op) {
    case 't': case 'b': return sb_wsc_frame(c, op == 't' ? 1 : 2, data, len, 0, 0);
    case 'c': {
      pthread_mutex_lock(&c->lock);
      int already = c->close_queued;
      c->close_queued = 1;
      pthread_mutex_unlock(&c->lock);
      if (already) return 0;
      return sb_wsc_frame(c, 8, data, len, (unsigned)n, 1);
    }
    case 'p': {
      if (!out || !cap) return -1;
      out[0] = 0;
      pthread_mutex_lock(&c->lock);
      if (c->evh) snprintf(out, cap, "%d %zu %u", c->evh->kind, c->evh->len, c->evh->code);
      pthread_mutex_unlock(&c->lock);
      return 0;
    }
    case 'i': {
      pthread_mutex_lock(&c->lock);
      sb_wsc_ev* e = c->evh;
      if (!e) { pthread_mutex_unlock(&c->lock); return -1; }
      c->evh = e->next; if (!c->evh) c->evt = 0;
      pthread_mutex_unlock(&c->lock);
      size_t got = e->len < cap ? e->len : cap;
      if (got) memcpy(out, e->data, got);
      free(e->data); free(e);
      return (long long)got;
    }
    case 'k':
      pthread_mutex_lock(&c->lock);
      c->unacked -= n < c->unacked ? n : c->unacked;
      pthread_mutex_unlock(&c->lock);
      sb_wsc_wake_thread(c);
      return 0;
    case 'w':
      pthread_mutex_lock(&c->lock);
      c->waiter = (unsigned)n;
      if (c->evh) c->wake_pending = 1;
      pthread_mutex_unlock(&c->lock);
      if (c->evh) sb_wsc_signal();
      return 0;
    case 'r': {
      pthread_mutex_lock(&c->lock);
      c->released = 1;
      int done = c->finished;
      pthread_mutex_unlock(&c->lock);
      if (done) {
        pthread_mutex_lock(&sb_wsc_lock);
        for (sb_wsc** at = &sb_wscs; *at; at = &(*at)->next) if (*at == c) { *at = c->next; break; }
        pthread_mutex_unlock(&sb_wsc_lock);
        sb_wsc_free(c);
      } else sb_wsc_wake_thread(c);
      return 0;
    }
  }
  return -1;
}
// 1 when something will run the loop when an event arrives (the async pipe or a waker).
static int sb_wsc_wakeable(void) { return sb_wsc_pipe_enabled() || sb_wsc_waker != 0; }
extern long long (*sb_wsc_hook)(int op, unsigned int id, const char* data, size_t length, size_t n, char* out, size_t cap);
extern int (*sb_wsc_wakeable_hook)(void);
static void sb_wsc_install(void) __attribute__((constructor));
static void sb_wsc_install(void) { sb_wsc_drain_hook = sb_wsc_drain; sb_wsc_hook = sb_wsc_op; sb_wsc_wakeable_hook = sb_wsc_wakeable; }
// WSC:END
`;

// R2 put: the body is its own parameter, so it never gets escaped.
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbR2PutRaw(path, bucket, key, body, httpJson, customJson) {
  let res = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __p; size_t __pl; char* __po = 0;
    porf_native_fetch_read_value(path, &__p, &__pl, &__po);
    char* __path = (char*)malloc(__pl + 1); memcpy(__path, __p, __pl); __path[__pl] = 0;
    if (__po) free(__po);

    const char* __bk; size_t __bkl; char* __bko = 0;
    porf_native_fetch_read_value(bucket, &__bk, &__bkl, &__bko);
    char* __bucket = (char*)malloc(__bkl + 1); memcpy(__bucket, __bk, __bkl); __bucket[__bkl] = 0;
    if (__bko) free(__bko);

    const char* __k; size_t __kl; char* __ko = 0;
    porf_native_fetch_read_value(key, &__k, &__kl, &__ko);
    char* __key = (char*)malloc(__kl + 1); memcpy(__key, __k, __kl); __key[__kl] = 0;
    if (__ko) free(__ko);

    const char* __h; size_t __hl; char* __ho = 0;
    porf_native_fetch_read_value(httpJson, &__h, &__hl, &__ho);
    char* __http = (char*)malloc(__hl + 1); memcpy(__http, __h, __hl); __http[__hl] = 0;
    if (__ho) free(__ho);

    const char* __c; size_t __cl; char* __co = 0;
    porf_native_fetch_read_value(customJson, &__c, &__cl, &__co);
    char* __custom = (char*)malloc(__cl + 1); memcpy(__custom, __c, __cl); __custom[__cl] = 0;
    if (__co) free(__co);

    // baronunread/sproutboat#184 -- read raw, not through porf_native_fetch_
    // read_value's bytestring branch, which always UTF-8-encodes (correct for
    // genuine text, wrong for opaque bytes -- request.body off a raw HTTP
    // upload is exactly that). R2 is object storage: put()/get() need to be
    // byte-preserving, not text-preserving. Only a bytestring-typed value can
    // be read raw; a genuine multi-byte JS string (real Unicode, "string" type
    // rather than "bytestring") isn't one, so it falls back to the normal
    // encoding path, which already handles that type correctly.
    const char* __b; size_t __bl; char* __bo = 0;
    if (porf_native_fetch_read_raw_bytes(body, &__b, &__bl) != 0) {
      porf_native_fetch_read_value(body, &__b, &__bl, &__bo);
    }
    char* __out = sb_r2_put_c(__path, __bucket, __key, __b, __bl, __http, __custom);
    if (__bo) free(__bo);

    free(__path); free(__bucket); free(__key); free(__http); free(__custom);
    if (__out) {
      res = porf_box((f64)porf_native_fetch_alloc_bytestring(__out, strlen(__out)), 195);
      free(__out);
    }
  `;
  return res;
}

// Multipart parts are persisted individually. Completion streams them through
// a fixed 64 KiB C buffer, so the standalone heap never holds the whole object.
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbR2MultipartPutRaw(path, bucket, key, uploadId, partNumberText, body) {
  let res = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __p; size_t __pl; char* __po = 0;
    porf_native_fetch_read_value(path, &__p, &__pl, &__po);
    char* __path = (char*)malloc(__pl + 1); memcpy(__path, __p, __pl); __path[__pl] = 0;
    if (__po) free(__po);

    const char* __bk; size_t __bkl; char* __bko = 0;
    porf_native_fetch_read_value(bucket, &__bk, &__bkl, &__bko);
    char* __bucket = (char*)malloc(__bkl + 1); memcpy(__bucket, __bk, __bkl); __bucket[__bkl] = 0;
    if (__bko) free(__bko);

    const char* __k; size_t __kl; char* __ko = 0;
    porf_native_fetch_read_value(key, &__k, &__kl, &__ko);
    char* __key = (char*)malloc(__kl + 1); memcpy(__key, __k, __kl); __key[__kl] = 0;
    if (__ko) free(__ko);

    const char* __u; size_t __ul; char* __uo = 0;
    porf_native_fetch_read_value(uploadId, &__u, &__ul, &__uo);
    char* __upload = (char*)malloc(__ul + 1); memcpy(__upload, __u, __ul); __upload[__ul] = 0;
    if (__uo) free(__uo);

    const char* __pn; size_t __pnl; char* __pno = 0;
    porf_native_fetch_read_value(partNumberText, &__pn, &__pnl, &__pno);
    char __partbuf[16];
    size_t __partlen = __pnl < sizeof(__partbuf) - 1 ? __pnl : sizeof(__partbuf) - 1;
    memcpy(__partbuf, __pn, __partlen); __partbuf[__partlen] = 0;
    if (__pno) free(__pno);

    const char* __b; size_t __bl; char* __bo = 0;
    if (porf_native_fetch_read_raw_bytes(body, &__b, &__bl) != 0) {
      porf_native_fetch_read_value(body, &__b, &__bl, &__bo);
    }
    char* __out = sb_r2_part_put_c(__path, __bucket, __key, __upload, atoi(__partbuf), __b, __bl);
    if (__bo) free(__bo);
    free(__path); free(__bucket); free(__key); free(__upload);
    if (__out) {
      res = porf_box((f64)porf_native_fetch_alloc_bytestring(__out, strlen(__out)), 195);
      free(__out);
    }
  `;
  return res;
}

// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbR2MultipartCompleteRaw(path, bucket, key, uploadId) {
  let res = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __p; size_t __pl; char* __po = 0;
    porf_native_fetch_read_value(path, &__p, &__pl, &__po);
    char* __path = (char*)malloc(__pl + 1); memcpy(__path, __p, __pl); __path[__pl] = 0;
    if (__po) free(__po);
    const char* __bk; size_t __bkl; char* __bko = 0;
    porf_native_fetch_read_value(bucket, &__bk, &__bkl, &__bko);
    char* __bucket = (char*)malloc(__bkl + 1); memcpy(__bucket, __bk, __bkl); __bucket[__bkl] = 0;
    if (__bko) free(__bko);
    const char* __k; size_t __kl; char* __ko = 0;
    porf_native_fetch_read_value(key, &__k, &__kl, &__ko);
    char* __key = (char*)malloc(__kl + 1); memcpy(__key, __k, __kl); __key[__kl] = 0;
    if (__ko) free(__ko);
    const char* __u; size_t __ul; char* __uo = 0;
    porf_native_fetch_read_value(uploadId, &__u, &__ul, &__uo);
    char* __upload = (char*)malloc(__ul + 1); memcpy(__upload, __u, __ul); __upload[__ul] = 0;
    if (__uo) free(__uo);
    char* __out = sb_r2_multipart_complete_c(__path, __bucket, __key, __upload);
    free(__path); free(__bucket); free(__key); free(__upload);
    if (__out) {
      res = porf_box((f64)porf_native_fetch_alloc_bytestring(__out, strlen(__out)), 195);
      free(__out);
    }
  `;
  return res;
}

// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbR2MultipartDeleteRaw(path, bucket, key, uploadId) {
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __p; size_t __pl; char* __po = 0;
    porf_native_fetch_read_value(path, &__p, &__pl, &__po);
    char* __path = (char*)malloc(__pl + 1); memcpy(__path, __p, __pl); __path[__pl] = 0;
    if (__po) free(__po);
    const char* __bk; size_t __bkl; char* __bko = 0;
    porf_native_fetch_read_value(bucket, &__bk, &__bkl, &__bko);
    char* __bucket = (char*)malloc(__bkl + 1); memcpy(__bucket, __bk, __bkl); __bucket[__bkl] = 0;
    if (__bko) free(__bko);
    const char* __k; size_t __kl; char* __ko = 0;
    porf_native_fetch_read_value(key, &__k, &__kl, &__ko);
    char* __key = (char*)malloc(__kl + 1); memcpy(__key, __k, __kl); __key[__kl] = 0;
    if (__ko) free(__ko);
    const char* __u; size_t __ul; char* __uo = 0;
    porf_native_fetch_read_value(uploadId, &__u, &__ul, &__uo);
    char* __upload = (char*)malloc(__ul + 1); memcpy(__upload, __u, __ul); __upload[__ul] = 0;
    if (__uo) free(__uo);
    sb_r2_multipart_delete_parts_c(__path, __bucket, __key, __upload);
    free(__path); free(__bucket); free(__key); free(__upload);
  `;
}

// R2 get: the bytes come back as a bytestring, not inside a reply frame.
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbR2GetRaw(path, bucket, key, blobId) {
  let res = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __p; size_t __pl; char* __po = 0;
    porf_native_fetch_read_value(path, &__p, &__pl, &__po);
    char* __path = (char*)malloc(__pl + 1); memcpy(__path, __p, __pl); __path[__pl] = 0;
    if (__po) free(__po);

    const char* __bk; size_t __bkl; char* __bko = 0;
    porf_native_fetch_read_value(bucket, &__bk, &__bkl, &__bko);
    char* __bucket = (char*)malloc(__bkl + 1); memcpy(__bucket, __bk, __bkl); __bucket[__bkl] = 0;
    if (__bko) free(__bko);

    const char* __k; size_t __kl; char* __ko = 0;
    porf_native_fetch_read_value(key, &__k, &__kl, &__ko);
    char* __key = (char*)malloc(__kl + 1); memcpy(__key, __k, __kl); __key[__kl] = 0;
    if (__ko) free(__ko);

    const char* __g; size_t __gl; char* __go = 0;
    porf_native_fetch_read_value(blobId, &__g, &__gl, &__go);
    char* __generation = (char*)malloc(__gl + 1); memcpy(__generation, __g, __gl); __generation[__gl] = 0;
    if (__go) free(__go);

    int __found = 0;
    u32 __bs = sb_r2_get_c(__path, __bucket, __key, __generation, &__found);
    free(__path); free(__bucket); free(__key); free(__generation);
    if (__found) res = porf_box((f64)__bs, 195);
  `;
  return res;
}

// R2 delete: also removes the object's own file, not just the metadata row
// (#56 — sb_r2_delete_blob is best-effort, a missing file is not an error).
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbR2DeleteRaw(path, bucket, key, blobId) {
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __p; size_t __pl; char* __po = 0;
    porf_native_fetch_read_value(path, &__p, &__pl, &__po);
    char* __path = (char*)malloc(__pl + 1); memcpy(__path, __p, __pl); __path[__pl] = 0;
    if (__po) free(__po);

    const char* __bk; size_t __bkl; char* __bko = 0;
    porf_native_fetch_read_value(bucket, &__bk, &__bkl, &__bko);
    char* __bucket = (char*)malloc(__bkl + 1); memcpy(__bucket, __bk, __bkl); __bucket[__bkl] = 0;
    if (__bko) free(__bko);

    const char* __k; size_t __kl; char* __ko = 0;
    porf_native_fetch_read_value(key, &__k, &__kl, &__ko);
    char* __key = (char*)malloc(__kl + 1); memcpy(__key, __k, __kl); __key[__kl] = 0;
    if (__ko) free(__ko);

    const char* __g; size_t __gl; char* __go = 0;
    porf_native_fetch_read_value(blobId, &__g, &__gl, &__go);
    char* __generation = (char*)malloc(__gl + 1); memcpy(__generation, __g, __gl); __generation[__gl] = 0;
    if (__go) free(__go);

    sb_r2_delete_blob(__path, __bucket, __key, __generation);
    free(__path); free(__bucket); free(__key); free(__generation);
  `;
}

// Multi-statement exec. Same string-param pattern as __sbSqlRaw.
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbSqlScriptRaw(path, sql) {
  let res = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __p; size_t __pl; char* __po = 0;
    porf_native_fetch_read_value(path, &__p, &__pl, &__po);
    char* __path = (char*)malloc(__pl + 1); memcpy(__path, __p, __pl); __path[__pl] = 0;
    if (__po) free(__po);

    const char* __s; size_t __sl; char* __so = 0;
    porf_native_fetch_read_value(sql, &__s, &__sl, &__so);
    char* __sql = (char*)malloc(__sl + 1); memcpy(__sql, __s, __sl); __sql[__sl] = 0;
    if (__so) free(__so);

    char* __out = sb_sql_script(__path, __sql);
    free(__path); free(__sql);
    if (__out) {
      res = porf_box((f64)porf_native_fetch_alloc_bytestring(__out, strlen(__out)), 195);
      free(__out);
    }
  `;
  return res;
}

// The bytes under a directory, as a decimal string (sb_dir_bytes).
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbDirBytesRaw(dir) {
  let res = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __d; size_t __dl; char* __do = 0;
    porf_native_fetch_read_value(dir, &__d, &__dl, &__do);
    char* __dir = (char*)malloc(__dl + 1); memcpy(__dir, __d, __dl); __dir[__dl] = 0;
    if (__do) free(__do);
    char __n[32]; int __k = snprintf(__n, sizeof(__n), "%lld", sb_dir_bytes(__dir, 0));
    free(__dir);
    res = porf_box((f64)porf_native_fetch_alloc_bytestring(__n, (size_t)__k), 195);
  `;
  return res;
}

// "captured" of __sbD1DbRaw as a number: no text made in C and parsed here, on every D1 query.
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbD1Captured_(path) {
  let status = -1;
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __p; size_t __pl; char* __po = 0;
    porf_native_fetch_read_value(path, &__p, &__pl, &__po);
    char* __path = (char*)malloc(__pl + 1); memcpy(__path, __p, __pl); __path[__pl] = 0;
    if (__po) free(__po);
    status = (f64)sb_db_quota_freeze(__path, -1);
    free(__path);
  `;
  return status;
}

// sb_db_page_size and sb_db_quota_freeze, for the quota (a path and a "0"/"1" in, a number out).
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbD1DbRaw(path, what) {
  let res = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __p; size_t __pl; char* __po = 0;
    porf_native_fetch_read_value(path, &__p, &__pl, &__po);
    char* __path = (char*)malloc(__pl + 1); memcpy(__path, __p, __pl); __path[__pl] = 0;
    if (__po) free(__po);
    const char* __w; size_t __wl; char* __wo = 0;
    porf_native_fetch_read_value(what, &__w, &__wl, &__wo);
    int __r = __wl && __w[0] == 'p' ? sb_db_page_size(__path) : __wl && __w[0] == 'c' ? sb_db_quota_freeze(__path, -1) : sb_db_quota_freeze(__path, __wl && __w[0] == 'f');
    if (__wo) free(__wo);
    free(__path);
    char __n[16]; int __k = snprintf(__n, sizeof(__n), "%d", __r);
    res = porf_box((f64)porf_native_fetch_alloc_bytestring(__n, (size_t)__k), 195);
  `;
  return res;
}

// #164 — VACUUM INTO a fresh file. Two strings in, JSON out. Same pattern as
// __sbSqlScriptRaw.
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbD1BackupRaw(src, dest) {
  let res = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __s; size_t __sl; char* __so = 0;
    porf_native_fetch_read_value(src, &__s, &__sl, &__so);
    char* __src = (char*)malloc(__sl + 1); memcpy(__src, __s, __sl); __src[__sl] = 0;
    if (__so) free(__so);

    const char* __d; size_t __dl; char* __do = 0;
    porf_native_fetch_read_value(dest, &__d, &__dl, &__do);
    char* __dest = (char*)malloc(__dl + 1); memcpy(__dest, __d, __dl); __dest[__dl] = 0;
    if (__do) free(__do);

    char* __out = sb_sql_backup(__src, __dest);
    free(__src); free(__dest);
    if (__out) {
      res = porf_box((f64)porf_native_fetch_alloc_bytestring(__out, strlen(__out)), 195);
      free(__out);
    }
  `;
  return res;
}

// Outbound HTTP. String params so C can read each directly; the JS side has
// already split the URL; the connect refuses private addresses. `tlsFlag` is "1" or "0" —
// a string like the rest, so the marshalling stays uniform.
// asyncId > 0 (B18): queue the request under that timer id and return "" at once;
// its callback reads the reply with __sbHttpAsyncResult.
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbHttpRaw(host, portStr, path, method, headersText, body, tlsFlag, asyncId) {
  let res = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __h; size_t __hl; char* __ho = 0;
    porf_native_fetch_read_value(host, &__h, &__hl, &__ho);
    char* __host = (char*)malloc(__hl + 1); memcpy(__host, __h, __hl); __host[__hl] = 0;
    if (__ho) free(__ho);

    const char* __pt; size_t __ptl; char* __pto = 0;
    porf_native_fetch_read_value(portStr, &__pt, &__ptl, &__pto);
    char __portbuf[16]; size_t __ptk = __ptl < 15 ? __ptl : 15;
    memcpy(__portbuf, __pt, __ptk); __portbuf[__ptk] = 0;
    if (__pto) free(__pto);

    const char* __pa; size_t __pal; char* __pao = 0;
    porf_native_fetch_read_value(path, &__pa, &__pal, &__pao);
    char* __path = (char*)malloc(__pal + 1); memcpy(__path, __pa, __pal); __path[__pal] = 0;
    if (__pao) free(__pao);

    const char* __m; size_t __ml; char* __mo = 0;
    porf_native_fetch_read_value(method, &__m, &__ml, &__mo);
    char* __method = (char*)malloc(__ml + 1); memcpy(__method, __m, __ml); __method[__ml] = 0;
    if (__mo) free(__mo);

    const char* __hd; size_t __hdl; char* __hdo = 0;
    porf_native_fetch_read_value(headersText, &__hd, &__hdl, &__hdo);
    char* __hdrs = (char*)malloc(__hdl + 1); memcpy(__hdrs, __hd, __hdl); __hdrs[__hdl] = 0;
    if (__hdo) free(__hdo);

    // tlsFlag is "0"/"1", plus "b" when the body is raw bytes (#233-style flag
    // for #232's request half): one char per byte, sent as-is, not UTF-8 encoded.
    const char* __t; size_t __tl; char* __to = 0;
    porf_native_fetch_read_value(tlsFlag, &__t, &__tl, &__to);
    int __tls = (__tl > 0 && __t[0] == '1') ? 1 : 0;
    int __rawBody = (__tl > 1 && __t[1] == 'b') ? 1 : 0;
    if (__to) free(__to);

    const char* __b; size_t __bl; char* __bo = 0;
    if (__rawBody && porf_native_fetch_read_raw_bytes(body, &__b, &__bl) == 0) {
      // a bytestring is already one byte per char
    } else if (__rawBody && body.type == 67) {
      // A UTF-16 string (type 67: u32 length, then u16 units) still holds one
      // byte per unit here; narrow each unit instead of UTF-8 encoding it.
      const u32 __bp = (u32)body.val;
      __bl = (size_t)*(u32*)(MEM + __bp);
      __bo = (char*)malloc(__bl + 1);
      const u16* __bs = (const u16*)(MEM + __bp + 4);
      for (size_t __i = 0; __i < __bl; __i++) __bo[__i] = (char)(__bs[__i] & 0xff);
      __b = __bo;
    } else {
      porf_native_fetch_read_value(body, &__b, &__bl, &__bo);
    }
    char* __body = (char*)malloc(__bl + 1); memcpy(__body, __b, __bl); __body[__bl] = 0;
    if (__bo) free(__bo);

    const u32 __async = asyncId.type == 1 && asyncId.val > 0 ? (u32)asyncId.val : 0;
    if (__async) {
      void sb_async_submit(u32, int, int, char*, char*, char*, char*, char*, size_t);
      sb_async_submit(__async, atoi(__portbuf), __tls, __host, __path, __method, __hdrs, __body, __bl);
    } else {
      char* __out = sb_http_request(__host, atoi(__portbuf), __path, __method, __hdrs, __body, __bl, __tls);
      free(__host); free(__path); free(__method); free(__hdrs); free(__body);
      if (__out) {
        res = porf_box((f64)porf_native_fetch_alloc_bytestring(__out, strlen(__out)), 195);
        free(__out);
      }
    }
  `;
  return res;
}

// The reply of the async request now firing its callback (B18), or "".
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbHttpAsyncResult(asyncId) {
  let res = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* sb_async_reply(u32);
    const char* __r = asyncId.type == 1 ? sb_async_reply((u32)asyncId.val) : 0;
    if (__r) res = porf_box((f64)porf_native_fetch_alloc_bytestring(__r, strlen(__r)), 195);
  `;
  return res;
}

// An async request's caller gave up. The host's request runs to the end; with its
// placeholder timer cleared, the reply is dropped when it arrives.
function __sbCancelAsync() {}

// sproutd ran fetch() off its loop, as a promise, at every compatibility date (B18).
function __sbAsyncAtAnyDate() {
  return true;
}

// Whether the host runs async requests (sb_async_enable was called).
function __sbHttpAsyncEnabled() {
  let res = false;
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    int sb_async_enabled(void);
    if (sb_async_enabled()) res = porf_box(1, 2);
  `;
  return res;
}

// The outbound client's JSON reply -> the fetch op's result.
function __sbFetchReply(raw) {
  const reply = JSON.parse(raw);
  if (reply.ok === false) throw new Error(reply.error);
  // A TLS peer that closed without close_notify is normal on Connection:
  // close, and also what a truncation attack looks like. Accept it only when
  // Content-Length says the body arrived whole.
  if (reply.unclean && !reply.complete) {
    throw new Error("connection closed before the response was complete");
  }
  return { ok: true, status: reply.status, headers: reply.headers, body: reply.body };
}

// One statement in, one JSON reply out. `path`, `sql` and `paramsJson` are
// parameters so the generated C names them directly.
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbSqlRaw(path, sql, paramsJson) {
  let res = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __p; size_t __pl; char* __po = 0;
    porf_native_fetch_read_value(path, &__p, &__pl, &__po);
    char* __path = (char*)malloc(__pl + 1); memcpy(__path, __p, __pl); __path[__pl] = 0;
    if (__po) free(__po);

    const char* __s; size_t __sl; char* __so = 0;
    porf_native_fetch_read_value(sql, &__s, &__sl, &__so);
    char* __sql = (char*)malloc(__sl + 1); memcpy(__sql, __s, __sl); __sql[__sl] = 0;
    if (__so) free(__so);

    const char* __a; size_t __al; char* __ao = 0;
    porf_native_fetch_read_value(paramsJson, &__a, &__al, &__ao);
    char* __args = (char*)malloc(__al + 1); memcpy(__args, __a, __al); __args[__al] = 0;
    if (__ao) free(__ao);

    char* __out = sb_sql_run(__path, __sql, __args);
    free(__path); free(__sql); free(__args);
    if (__out) {
      res = porf_box((f64)porf_native_fetch_alloc_bytestring(__out, strlen(__out)), 195);
      free(__out);
    } else {
      res = porf_box((f64)porf_native_fetch_alloc_bytestring("{\"ok\":false,\"error\":\"no result\"}", 38), 195);
    }
  `;
  return res;
}

// One strict D1 statement: [header, rows, columns, changes, rowid]. A result has the empty string
// for its header, rows an array of row arrays built here from the cells (BLOBs as byte arrays),
// columns the array of names, and changes and rowid numbers: no JSON is written or parsed. Any
// other reply is the error JSON in the header, with nothing after it.
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbSqlRowsRaw(path, sql, paramsJson) {
  let res = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __p; size_t __pl; char* __po = 0;
    porf_native_fetch_read_value(path, &__p, &__pl, &__po);
    char* __path = (char*)malloc(__pl + 1); memcpy(__path, __p, __pl); __path[__pl] = 0;
    if (__po) free(__po);

    const char* __s; size_t __sl; char* __so = 0;
    porf_native_fetch_read_value(sql, &__s, &__sl, &__so);
    char* __sql = (char*)malloc(__sl + 1); memcpy(__sql, __s, __sl); __sql[__sl] = 0;
    if (__so) free(__so);

    const char* __a; size_t __al; char* __ao = 0;
    porf_native_fetch_read_value(paramsJson, &__a, &__al, &__ao);
    char* __args = (char*)malloc(__al + 1); memcpy(__args, __a, __al); __args[__al] = 0;
    if (__ao) free(__ao);

    sb_cells __cells = { 0, 0, 0, 0, 0 };
    char* __out = sb_sql_run_x(__path, __sql, __args, &__cells);
    free(__path); free(__sql); free(__args);
    const u32 __pair = porf_arr_new(5, 5);
    res = porf_box((f64)__pair, 72);
    const int __native = !__out && __cells.used == 1;
    if (!__out && !__native) __out = strdup("{\"ok\":false,\"error\":\"no result\"}");
    porf_arr_set(__pair, 0, porf_box((f64)porf_native_fetch_alloc_bytestring(__out ? __out : "", __out ? strlen(__out) : 0), 195));
    free(__out);
    if (__native) {
      const size_t __ncol = (size_t)__cells.ncol;
      const size_t __hdr = (size_t)__cells.hdr;
      const size_t __nrow = __ncol ? (__cells.n - __hdr) / __ncol : 0;
      const u32 __rows = porf_arr_new(0, (i32)(__nrow ? __nrow : 1));
      porf_arr_set(__pair, 1, porf_box((f64)__rows, 72));
      porf_arr_set(__pair, 3, porf_box_num((f64)__cells.changes));
      porf_arr_set(__pair, 4, porf_box_num((f64)__cells.rowid));
      if (!__ncol) porf_arr_set(__pair, 2, porf_box((f64)porf_arr_new(0, 1), 72));
      // Row index -1 is the column names; the data rows follow.
      for (long long __r = (__ncol ? -1 : 0); __r < (long long)__nrow; __r++) {
        const u32 __row = porf_arr_new((i32)__ncol, (i32)__ncol);
        if (__r < 0) porf_arr_set(__pair, 2, porf_box((f64)__row, 72));
        else porf_arr_set(__rows, (u32)__r, porf_box((f64)__row, 72));
        for (size_t __c = 0; __c < __ncol; __c++) {
          const sb_cell* __cell = &__cells.c[(__r < 0 ? 0 : __hdr + (size_t)__r * __ncol) + __c];
          jsval __v = porf_box(0.0, 7);
          if (__cell->t == 1) __v = porf_box_num(__cell->d);
          else if (__cell->t == 2 && __cell->ascii) {
            __v = porf_box((f64)porf_native_fetch_alloc_bytestring(__cells.a + __cell->off, (size_t)__cell->n), 195);
          } else if (__cell->t == 2) {
            const size_t __n = (size_t)__cell->n;
            uint16_t* __u = (uint16_t*)malloc(__n * 2 + 2);
            if (__u) {
              int __wide = 0;
              const size_t __k = sb_text_units((const unsigned char*)(__cells.a + __cell->off), __n, __u, &__wide);
              if (__wide) {
                const u32 __str = porf_native_fetch_alloc((u32)(4 + __k * 2), 67);
                *(u32*)(MEM + __str) = (u32)__k;
                memcpy(MEM + __str + 4, __u, __k * 2);
                __v = porf_box((f64)__str, 67);
              } else {
                unsigned char* __b = (unsigned char*)malloc(__k + 1);
                if (__b) {
                  for (size_t __i = 0; __i < __k; __i++) __b[__i] = (unsigned char)__u[__i];
                  __v = porf_box((f64)porf_native_fetch_alloc_bytestring((const char*)__b, __k), 195);
                  free(__b);
                }
              }
              free(__u);
            }
          } else if (__cell->t == 3) {
            const u32 __bytes = porf_arr_new((i32)__cell->n, (i32)__cell->n);
            for (int __i = 0; __i < __cell->n; __i++) porf_arr_set(__bytes, (u32)__i, porf_box_num((f64)(unsigned char)__cells.a[__cell->off + __i]));
            __v = porf_box((f64)__bytes, 72);
          }
          porf_arr_set(__row, (u32)__c, __v);
        }
      }
    }
    sb_cells_free(&__cells);
  `;
  return res;
}

// --- the op dispatch, in JS -------------------------------------------------
// Deliberately the same SQL and the same partition keys as broker.ts. When one
// changes the other has to, and the conformance suite is what says so.

var __sbDataDir = "";
function __sbDir() {
  // SB_DATA_DIR, then SPROUTBOAT_DATA, then <name>.data relative to the working
  // directory. Environment only: a native-fetch binary never sees argv, because
  // Porffor's runtime init calls porf_init(0, NULL). Resolved once — the answer
  // cannot change mid-run.
  if (!__sbDataDir) {
    __sbDataDir =
      __sbEnv("SB_DATA_DIR") ||
      __sbEnv("SPROUTBOAT_DATA") ||
      (globalThis.__sbAppName || "app") + ".data";
  }
  return __sbDataDir;
}
// The storage quota: an app's data directory holds at most SB_STORAGE_MAX_BYTES (sproutd
// sets it per app; 10 GiB when unset, after D1's 10 GB per database). Past it, writes are
// refused with an error that says so; reads and deletes still work, so an app can make
// room. The size is measured at most once a second, and on a write's way in, so a write
// can overshoot by what one second of writes adds. A D1 database is also capped at 10 GB.
var __sbQuotaMax = -1;
var __sbQuotaUsed = 0;
var __sbQuotaAt = -1;
function __sbQuotaLimit() {
  if (__sbQuotaMax < 0) {
    const v = Number(__sbEnv("SB_STORAGE_MAX_BYTES"));
    __sbQuotaMax = v > 0 ? v : 10737418240;
  }
  return __sbQuotaMax;
}
function __sbQuotaFull() {
  const now = Date.now();
  if (__sbQuotaAt < 0 || now - __sbQuotaAt >= 1000) {
    __sbQuotaUsed = Number(__sbDirBytesRaw(__sbDir())) || 0;
    __sbQuotaAt = now;
  }
  return __sbQuotaUsed >= __sbQuotaLimit();
}
function __sbQuotaCheck(what) {
  if (__sbQuotaFull())
    throw new Error(
      what + " failed: storage quota exceeded (this app stores " + __sbQuotaUsed + " bytes; the limit is " + __sbQuotaLimit() + ")",
    );
}
var __sbQuotaOps = {
  "kv.put": "KV put()",
  "do.storage.put": "Durable Object storage put()",
  "do.alarm.set": "Durable Object setAlarm()",
  "queue.send": "Queue send()",
  "queue.send_batch": "Queue sendBatch()",
  "cache.put": "Cache put()",
  "ae.write": "Analytics Engine writeDataPoint()",
  "r2.put": "R2 put()",
  "r2.multipart.create": "R2 createMultipartUpload()",
  "r2.multipart.complete": "R2 completeMultipartUpload()",
};
// D1 over the quota: pin each database at its current size (SQLITE_FULL on growth, so
// reads and deletes still run); under it, cap it at 10 GB or the quota, whichever is less.
// A database under LTX capture is frozen instead: every write is refused, because even a
// DELETE adds a file to the replication spool, which counts toward the quota.
var __sbD1Capped = {};
var __sbD1Captured = {};
var __sbD1Checkpointed = {};
function __sbD1Quota(path) {
  // Whether capture owns this database, from the private helper (no SQL), before anything
  // below depends on it. A database that cannot open (or whose capture failed) is left to
  // the call itself, which reports why.
  const status = __sbD1Captured_(path);
  if (status < 0) return;
  __sbD1Captured[path] = status === 1;
  let full = __sbQuotaFull();
  // Over the quota, a database's -wal file can hold space the app has already freed (a
  // DELETE, a VACUUM): checkpoint it into the database and truncate it, at most once a
  // second, then measure again. Not under capture: LTX owns that database's checkpoints.
  if (full && !__sbD1Captured[path] && Date.now() - (__sbD1Checkpointed[path] || 0) >= 1000) {
    __sbD1Checkpointed[path] = Date.now();
    JSON.parse(__sbSqlRaw(path, "PRAGMA wal_checkpoint(TRUNCATE)", "[]"));
    __sbQuotaAt = -1;
    full = __sbQuotaFull();
  }
  if (__sbD1Capped[path] === full) return;
  __sbD1Capped[path] = full;
  const frozen = Number(__sbD1DbRaw(path, full ? "freeze" : "thaw"));
  if (frozen < 0) return;
  const captured = frozen === 1;
  __sbD1Captured[path] = captured;
  if (full && captured) return;
  const size = Number(__sbD1DbRaw(path, "page_size")) || 4096;
  const pages = full
    ? Number(__sbSql(path, "PRAGMA page_count", []).rows[0][0])
    : Math.floor(Math.min(__sbQuotaLimit(), 10000000000) / size);
  __sbSql(path, "PRAGMA max_page_count = " + Math.max(1, pages), []);
}
function __sbStore() {
  return __sbDir() + "/store.sqlite";
}
// "<data>/do-sql/CLASS/FILE.sqlite". The shim sends the file as 64 hex digits (the id, or a
// hash of an older id); both parts are checked so nothing leaves the directory.
function __sbDOSqlName(text, hex) {
  if (!text.length || text.length > (hex ? 64 : 200) || (hex && text.length !== 64)) return false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ok = hex
      ? (c >= 48 && c <= 57) || (c >= 97 && c <= 102)
      : (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
    if (!ok) return false;
  }
  return true;
}
function __sbDOSqlPath(cls, file) {
  const c = String(cls);
  const f = String(file);
  if (!__sbDOSqlName(c, false) || !__sbDOSqlName(f, true)) throw new Error("invalid Durable Object SQL database");
  return __sbDir() + "/do-sql/" + c + "/" + f + ".sqlite";
}
// The last database's path: an app has one or two, and every query asks, so three concatenations
// are done once. The directory cannot change mid-run (see __sbDir).
var __sbD1PathName = "";
var __sbD1PathValue = "";
function __sbD1Path(name) {
  if (name === __sbD1PathName) return __sbD1PathValue;
  const path = __sbDir() + "/d1/" + name + ".sqlite";
  __sbD1PathName = name;
  __sbD1PathValue = path;
  return path;
}

function __sbSql(path, sql, params) {
  const reply = JSON.parse(__sbSqlRaw(path, sql, params == null ? "[]" : JSON.stringify(params)));
  if (reply.ok === false) throw new Error("sqlite: " + reply.error);
  return reply;
}

var __sbSchemaReady = false;
function __sbEnsureSchema() {
  if (__sbSchemaReady) return;
  __sbSchemaReady = true;
  const s = __sbStore();
  __sbSql(
    s,
    "CREATE TABLE IF NOT EXISTS kv (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, " +
      "expires_at INTEGER, PRIMARY KEY (ns, key))",
  );
  const kvColumns = __sbSql(s, "PRAGMA table_info(kv)", []).rows;
  let hasKvExpiresAt = false;
  for (let i = 0; i < kvColumns.length; i++)
    if (kvColumns[i][1] === "expires_at") hasKvExpiresAt = true;
  if (!hasKvExpiresAt) __sbSql(s, "ALTER TABLE kv ADD COLUMN expires_at INTEGER", []);
  // #233 — 1 when the value was put as bytes, same column as the broker's.
  let hasKvBinary = false;
  for (let i = 0; i < kvColumns.length; i++) if (kvColumns[i][1] === "binary") hasKvBinary = true;
  if (!hasKvBinary) __sbSql(s, "ALTER TABLE kv ADD COLUMN binary INTEGER NOT NULL DEFAULT 0", []);
  // A key's metadata (put(key, value, { metadata })), as JSON text; same column as the broker's.
  let hasKvMetadata = false;
  for (let i = 0; i < kvColumns.length; i++) if (kvColumns[i][1] === "metadata") hasKvMetadata = true;
  if (!hasKvMetadata) __sbSql(s, "ALTER TABLE kv ADD COLUMN metadata TEXT", []);
  // #56 — no `body` column: an object's bytes live in their own file under
  // "<data-dir>/r2-blobs/" (sb_r2_put_c/sb_r2_get_c), never in the sqlite row.
  __sbSql(
    s,
    "CREATE TABLE IF NOT EXISTS r2 (bucket TEXT NOT NULL, key TEXT NOT NULL, size INTEGER NOT NULL, " +
      "etag TEXT NOT NULL, uploaded TEXT NOT NULL, http_json TEXT NOT NULL DEFAULT '{}', custom_json TEXT NOT NULL DEFAULT '{}', " +
      "blob_id TEXT, " +
      "PRIMARY KEY (bucket, key))",
  );
  const r2Columns = __sbSql(s, "PRAGMA table_info(r2)", []).rows;
  let hasBlobId = false;
  for (let i = 0; i < r2Columns.length; i++) if (r2Columns[i][1] === "blob_id") hasBlobId = true;
  if (!hasBlobId) __sbSql(s, "ALTER TABLE r2 ADD COLUMN blob_id TEXT", []);
  // The MD5 of an object's bytes, its etag from compatibility date 2026-10-26 (r2.md5).
  let hasR2Md5 = false;
  for (let i = 0; i < r2Columns.length; i++) if (r2Columns[i][1] === "md5") hasR2Md5 = true;
  if (!hasR2Md5) __sbSql(s, "ALTER TABLE r2 ADD COLUMN md5 TEXT", []);
  __sbSql(
    s,
    "CREATE TABLE IF NOT EXISTS r2_upload (bucket TEXT NOT NULL, key TEXT NOT NULL, upload_id TEXT NOT NULL, " +
      "uploaded TEXT NOT NULL, http_json TEXT NOT NULL DEFAULT '{}', custom_json TEXT NOT NULL DEFAULT '{}', " +
      "PRIMARY KEY (bucket, key, upload_id))",
  );
  __sbSql(
    s,
    "CREATE TABLE IF NOT EXISTS r2_part (bucket TEXT NOT NULL, key TEXT NOT NULL, upload_id TEXT NOT NULL, " +
      "part_number INTEGER NOT NULL, size INTEGER NOT NULL, etag TEXT NOT NULL, " +
      "PRIMARY KEY (bucket, key, upload_id, part_number))",
  );
  __sbSql(
    s,
    "CREATE TABLE IF NOT EXISTS r2_transfer (token TEXT PRIMARY KEY, bucket TEXT NOT NULL, key TEXT NOT NULL, " +
      "method TEXT NOT NULL, expires INTEGER NOT NULL, max_bytes INTEGER NOT NULL, expected_sha256 TEXT NOT NULL DEFAULT '', " +
      "http_json TEXT NOT NULL DEFAULT '{}', custom_json TEXT NOT NULL DEFAULT '{}', used INTEGER NOT NULL DEFAULT 0)",
  );
  const expired = __sbSql(s, "SELECT bucket, key, upload_id FROM r2_upload WHERE uploaded < ?", [
    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
  ]).rows;
  for (let i = 0; i < expired.length; i++) {
    __sbR2MultipartDeleteRaw(
      s,
      String(expired[i][0]),
      String(expired[i][1]),
      String(expired[i][2]),
    );
    __sbSql(s, "DELETE FROM r2_part WHERE bucket = ? AND key = ? AND upload_id = ?", expired[i]);
    __sbSql(s, "DELETE FROM r2_upload WHERE bucket = ? AND key = ? AND upload_id = ?", expired[i]);
  }
  __sbSql(
    s,
    "CREATE TABLE IF NOT EXISTS mq (queue TEXT NOT NULL, id TEXT PRIMARY KEY, body TEXT NOT NULL, " +
      "visible_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, dead INTEGER NOT NULL DEFAULT 0)",
  );
  // Additive: old standalone store.sqlite files gain the poll index on open.
  __sbSql(s, "CREATE INDEX IF NOT EXISTS mq_due ON mq (queue, dead, visible_at)", []);
  const mqColumns = __sbSql(s, "PRAGMA table_info(mq)", []).rows;
  let mqClaim = false;
  let mqSent = false;
  for (let i = 0; i < mqColumns.length; i++) {
    if (mqColumns[i][1] === "claim_token") mqClaim = true;
    if (mqColumns[i][1] === "sent_at") mqSent = true;
  }
  if (!mqClaim) __sbSql(s, "ALTER TABLE mq ADD COLUMN claim_token TEXT NOT NULL DEFAULT ''", []);
  // When the message was sent (message.timestamp); 0 for messages queued before the column.
  if (!mqSent) __sbSql(s, "ALTER TABLE mq ADD COLUMN sent_at INTEGER NOT NULL DEFAULT 0", []);
  __sbSql(
    s,
    "CREATE TABLE IF NOT EXISTS do_storage (cls TEXT NOT NULL, id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (cls, id, key))",
  );
  __sbSql(
    s,
    "CREATE TABLE IF NOT EXISTS do_alarm (cls TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (cls, id))",
  );
  __sbSql(s, "CREATE INDEX IF NOT EXISTS do_alarm_due ON do_alarm (at)", []);
  __sbSql(
    s,
    "CREATE TABLE IF NOT EXISTS do_alarm_delivery (cls TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, attempts INTEGER NOT NULL, token TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(cls,id))",
    [],
  );
  __sbSql(
    s,
    "CREATE TABLE IF NOT EXISTS ae (dataset TEXT NOT NULL, ts INTEGER NOT NULL, indexes_json TEXT NOT NULL, blobs_json TEXT NOT NULL, doubles_json TEXT NOT NULL)",
  );
  __sbSql(
    s,
    "CREATE TABLE IF NOT EXISTS ratelimit (name TEXT NOT NULL, key TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (name, key))",
  );
  // #59 — caches.default, ambient like the broker's copy of this table.
  __sbSql(
    s,
    "CREATE TABLE IF NOT EXISTS cache (name TEXT NOT NULL, cache_key TEXT NOT NULL, status INTEGER NOT NULL, headers_json TEXT NOT NULL, body TEXT NOT NULL, expires_at INTEGER, PRIMARY KEY (name, cache_key))",
  );
}

// One page of r2.list for the shim from 2026-10-26: at most LIMIT entries after CURSOR,
// keys under PREFIX, those holding DELIMITER after it grouped into delimitedPrefixes (a
// group counts as one entry). Same rules as the broker's r2ListPage.
// ponytail: with a delimiter every key after the cursor is read; an index on the
// delimited prefix if buckets grow past ~100k keys.
function __sbR2ListPage(store, msg) {
  const prefix = String(msg.prefix || "");
  const delimiter = String(msg.delimiter || "");
  const limit = Math.min(Math.max(Math.floor(Number(msg.limit)) || 1000, 1), 1000);
  const r = __sbSql(
    store,
    "SELECT key, size, etag, uploaded, http_json, custom_json, md5 FROM r2 WHERE bucket = ?1 AND substr(key, 1, length(?2)) = ?2 " +
      "AND key > ?3 ORDER BY key" + (delimiter ? "" : " LIMIT " + (limit + 1)),
    [msg.bucket, prefix, String(msg.cursor || "")],
  );
  const objects = [];
  const delimitedPrefixes = [];
  let last = "";
  let truncated = false;
  for (let i = 0; i < r.rows.length; i++) {
    const row = r.rows[i];
    const at = delimiter ? row[0].indexOf(delimiter, prefix.length) : -1;
    const group = at < 0 ? "" : row[0].slice(0, at + delimiter.length);
    if (!group || delimitedPrefixes[delimitedPrefixes.length - 1] !== group) {
      if (objects.length + delimitedPrefixes.length >= limit) {
        truncated = true;
        break;
      }
      if (group) delimitedPrefixes.push(group);
      else
        objects.push({
          key: row[0],
          size: Number(row[1]),
          etag: row[2],
          uploaded: row[3],
          httpMetadata: JSON.parse(row[4] || "{}"),
          customMetadata: JSON.parse(row[5] || "{}"),
          md5: row[6],
        });
    }
    last = row[0];
  }
  return { ok: true, objects, delimitedPrefixes, truncated, cursor: truncated ? last : "" };
}

function __sbHex(n) {
  let out = "";
  const bytes = __sbRandomBytes(String(n));
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes.charCodeAt(i).toString(16);
    out += h.length === 1 ? "0" + h : h;
  }
  return out;
}

function __sbEmbeddedDispatch(msg) {
  __sbEnsureSchema();
  const store = __sbStore();
  const op = msg.op;
  if (__sbQuotaOps[op]) __sbQuotaCheck(__sbQuotaOps[op]);

  if (op === "ping") return { ok: true, op: "pong", echo: msg.msg };

  if (op === "kv.get") {
    const r = __sbSql(store, "SELECT value, expires_at, binary, metadata FROM kv WHERE ns = ? AND key = ?", [
      msg.ns,
      msg.key,
    ]);
    if (!r.rows.length) return { ok: true, found: false, value: null };
    const expiresAt = r.rows[0][1];
    if (expiresAt != null && expiresAt <= Date.now()) {
      __sbSql(store, "DELETE FROM kv WHERE ns = ? AND key = ?", [msg.ns, msg.key]);
      return { ok: true, found: false, value: null };
    }
    return {
      ok: true,
      found: true,
      value: r.rows[0][0],
      binary: r.rows[0][2] === 1,
      metadata: r.rows[0][3],
      expiration: expiresAt == null ? null : Math.floor(expiresAt / 1000),
    };
  }
  if (op === "kv.put") {
    // #58 — CF rejects expirationTtl under 60 seconds; matched here.
    let expiresAt = null;
    if (msg.expirationTtl != null) {
      const ttl = Number(msg.expirationTtl);
      if (!(ttl >= 60)) throw new Error("expirationTtl must be at least 60 seconds");
      expiresAt = Date.now() + ttl * 1000;
    } else if (msg.expiration != null) {
      expiresAt = Number(msg.expiration) * 1000;
    }
    __sbSql(
      store,
      "INSERT INTO kv (ns, key, value, expires_at, binary, metadata) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT (ns, key) DO UPDATE SET value = ?3, expires_at = ?4, binary = ?5, metadata = ?6",
      [msg.ns, msg.key, msg.value, expiresAt, msg.binary === true ? 1 : 0, msg.metadata == null ? null : String(msg.metadata)],
    );
    return { ok: true };
  }
  if (op === "kv.delete") {
    __sbSql(store, "DELETE FROM kv WHERE ns = ? AND key = ?", [msg.ns, msg.key]);
    return { ok: true };
  }
  if (op === "kv.list") {
    // The prefix matches exactly: LIKE ignored case and read "_" and "%" in it as wildcards.
    // With a limit (the shim from 2026-10-25), a page of entries after the cursor (the last
    // key of the previous page), with each key's expiration and metadata; without one,
    // every key, as before.
    const prefix = msg.prefix || "";
    const paged = msg.limit != null;
    const limit = paged ? Math.max(0, Math.floor(Number(msg.limit))) : -1;
    const r = __sbSql(
      store,
      "SELECT key, expires_at, metadata FROM kv WHERE ns = ?1 AND substr(key, 1, length(?2)) = ?2 AND key > ?3 " +
        "AND (expires_at IS NULL OR expires_at > ?4) ORDER BY key LIMIT ?5",
      [msg.ns, prefix, paged && msg.cursor ? String(msg.cursor) : "", Date.now(), paged ? limit + 1 : -1],
    );
    const keys = [];
    const entries = [];
    const count = paged ? Math.min(r.rows.length, limit) : r.rows.length;
    for (let i = 0; i < count; i++) {
      keys.push(r.rows[i][0]);
      entries.push({ name: r.rows[i][0], expiration: r.rows[i][1] == null ? null : Math.floor(r.rows[i][1] / 1000), metadata: r.rows[i][2] });
    }
    const complete = !paged || r.rows.length <= limit;
    return { ok: true, keys, entries, list_complete: complete, cursor: complete ? "" : keys[keys.length - 1] };
  }

  if (op === "assets.get") {
    // Assets are baked into the module by the build (wrap.ts), so a standalone
    // binary serves them with nothing beside it on disk. Same resolution rules
    // as src/assets.ts and the same reply shape as the broker.
    const bundle = globalThis.__sbAssets;
    if (!bundle) throw new Error("assets not bound");
    const files = bundle.files || {};
    const meta = (bundle.manifest && bundle.manifest.files) || {};
    let path = String(msg.path || "/");
    if (path.charAt(0) !== "/") path = "/" + path;
    const redirects = (bundle.manifest && bundle.manifest.redirects) || [];
    for (let i = 0; i < redirects.length; i++) {
      const location = __sbAssetRedirect(redirects[i], path);
      if (location !== null) return { ok: true, found: false, status: redirects[i].status, location };
    }

    let key = null;
    if (path.charAt(path.length - 1) === "/") {
      const index = path + "index.html";
      if (files[index] != null) key = index;
    } else if (files[path] != null) {
      key = path;
    } else {
      const base = path.slice(path.lastIndexOf("/") + 1);
      if (base.indexOf(".") === -1) {
        if (files[path + ".html"] != null) key = path + ".html";
        else if (files[path + "/index.html"] != null) key = path + "/index.html";
      }
    }
    if (key != null) {
      const info = meta[key] || {};
      return {
        ok: true,
        found: true,
        status: 200,
        type: info.type,
        hash: info.hash,
        body: files[key],
      };
    }
    const nfh = (bundle.manifest && bundle.manifest.notFound) || "none";
    if (nfh === "single-page-application" && files["/index.html"] != null) {
      const info = meta["/index.html"] || {};
      return {
        ok: true,
        found: true,
        status: 200,
        type: info.type,
        hash: info.hash,
        body: files["/index.html"],
      };
    }
    if (nfh === "404-page" && files["/404.html"] != null) {
      const info = meta["/404.html"] || {};
      return { ok: true, found: false, status: 404, type: info.type, body: files["/404.html"] };
    }
    return { ok: true, found: false, status: 404, body: "Not Found" };
  }

  if (op === "fetch") {
    const url = new URL(String(msg.url));
    const tls = url.protocol === "https:";
    if (!tls && url.protocol !== "http:") throw new Error("unsupported protocol: " + url.protocol);
    let headerText = "";
    const pairs = msg.headers || [];
    for (let i = 0; i < pairs.length; i++) {
      const key = String(pairs[i][0]).toLowerCase();
      // Host, Connection and Content-Length are ours to set.
      if (key === "host" || key === "connection" || key === "content-length") continue;
      headerText += pairs[i][0] + ": " + pairs[i][1] + "\r\n";
    }
    const port = url.port ? url.port : tls ? "443" : "80";
    const asyncId = msg.asyncId > 0 ? msg.asyncId : 0;
    const raw = __sbHttpRaw(
      url.hostname,
      port,
      url.pathname + url.search,
      String(msg.method || "GET").toUpperCase(),
      headerText,
      msg.body == null ? "" : String(msg.body),
      (tls ? "1" : "0") + (msg.bodyBinary === true ? "b" : ""),
      asyncId,
    );
    // B18: queued; the reply reaches the callback registered under asyncId.
    if (asyncId) return { ok: true, pending: true };
    return __sbFetchReply(raw);
  }

  if (op === "secret.get") {
    // Secrets reach a standalone binary through the environment, the same
    // channel the launcher and the supervisor use; there is nothing to decrypt.
    const value = __sbEnv(String(msg.name));
    if (!value) throw new Error("secret not set: " + msg.name);
    return { ok: true, value };
  }

  if (op === "d1.query" || op === "d1.exec" || op === "d1.batch") {
    const path = __sbD1Path(String(msg.db));
    if (op === "d1.exec") {
      // exec() takes a script; a single prepare would run only its first
      // statement and quietly drop the rest.
      __sbD1Open(path, msg.strict === true);
      __sbD1Quota(path);
      if (msg.strict === true && Array.isArray(msg.lines)) {
        __sbD1ExecLines(path, msg.lines, msg.parity === true);
        return { ok: true };
      }
      const reply = JSON.parse(__sbSqlScriptRaw(path, String(msg.sql)));
      if (reply.ok === false) throw new Error("sqlite: " + reply.error);
      return { ok: true };
    }
    const strict = msg.strict === true;
    __sbD1Open(path, strict);
    __sbD1Quota(path);
    if (op === "d1.batch") return { ok: true, results: __sbD1Batch(path, msg.statements || [], strict, msg.parity === true) };
    const one = __sbD1Run(path, msg.sql, msg.params, strict, msg.parity === true);
    return { ok: true, results: one.results, columns: one.columns, rows: one.rows, native: one.native, meta: one.meta, success: true };
  }

  // Durable Objects storage.sql (compatibility date 2026-10-29): one database per object,
  // run like a strict D1 query (BLOBs as hex, D1_ERROR text the shim rewords).
  if (op === "do.sql") {
    const path = __sbDOSqlPath(msg.cls, msg.file);
    // Its handle may have been closed and reopened since (SB_DO_SQL_OPEN), which drops the
    // size cap: set it again.
    delete __sbD1Capped[path];
    __sbD1Quota(path);
    const r = JSON.parse(__sbSqlRaw(path, "/*sb-d1-strict*/" + String(msg.sql), JSON.stringify(msg.params || [])));
    if (r.ok === false) throw __sbD1Error(r);
    return { ok: true, columns: r.cols, rows: r.rows, meta: { changes: r.changes } };
  }

  if (op === "d1.backup") {
    const src = __sbD1Path(String(msg.db));
    // A caller-supplied name must be a plain basename; anything else falls back
    // to the timestamped default, so nothing can climb out of backups/.
    const given = String(msg.name || "");
    const name = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(given)
      ? given
      : String(msg.db) + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".sqlite";
    const dest = __sbDir() + "/backups/" + name;
    const reply = JSON.parse(__sbD1BackupRaw(src, dest));
    if (reply.ok === false) throw new Error("d1 backup: " + reply.error);
    return { ok: true, path: dest, bytes: reply.bytes };
  }

  // r2.put/get route through the same raw C path (__sbR2PutRaw/__sbR2GetRaw,
  // sb_r2_put_c/sb_r2_get_c) the R2 binding's own put()/get() use — reachable
  // separately only via a raw `__sbCall(op:"r2.put"/"r2.get")`, which nothing
  // in this codebase does today, but broker.ts's dispatch() answers the same
  // two ops, so the contract stays identical on both backends either way
  // (#56: neither one keeps object bytes in SQLite any more).
  if (op === "r2.put") {
    const reply = JSON.parse(
      __sbR2PutRaw(
        store,
        String(msg.bucket),
        String(msg.key),
        String(msg.body == null ? "" : msg.body),
        JSON.stringify(msg.httpMetadata || {}),
        JSON.stringify(msg.customMetadata || {}),
      ),
    );
    if (reply.ok === false) throw new Error("r2 put: " + reply.error);
    return {
      ok: true,
      object: { key: msg.key, size: reply.size, etag: reply.etag, uploaded: reply.uploaded },
    };
  }
  if (op === "r2.transfer.create") {
    const method = msg.method === "upload" || msg.method === "download" ? msg.method : "";
    if (!method) throw new Error("transfer method must be upload or download");
    const expiresIn = Math.min(Math.max(Number(msg.expiresIn) || 900, 30), 3600);
    const maxBytes =
      method === "upload"
        ? Math.min(Math.max(Number(msg.maxBytes) || 100 * 1024 * 1024, 1), 5 * 1024 * 1024 * 1024)
        : 0;
    const expectedSha256 = String(msg.sha256 || "").toLowerCase();
    if (expectedSha256 && !/^[0-9a-f]{64}$/.test(expectedSha256))
      throw new Error("sha256 must be 64 hexadecimal characters");
    const expires = Date.now() + expiresIn * 1000;
    __sbSql(store, "DELETE FROM r2_transfer WHERE expires < ? OR used = 1", [Date.now()]);
    const token = __sbHex(12);
    __sbSql(
      store,
      "INSERT INTO r2_transfer (token, bucket, key, method, expires, max_bytes, expected_sha256, http_json, custom_json) " +
        "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
      [
        token,
        msg.bucket,
        msg.key,
        method,
        expires,
        maxBytes,
        expectedSha256,
        JSON.stringify(msg.httpMetadata || {}),
        JSON.stringify(msg.customMetadata || {}),
      ],
    );
    return {
      ok: true,
      url: "/__sb/r2/transfer/" + encodeURIComponent(String(msg.bucket)) + "/" + token,
      expiresAt: new Date(expires).toISOString(),
    };
  }
  if (op === "r2.multipart.create") {
    const uploadId = String(msg.uploadId || __sbHex(16));
    __sbSql(
      store,
      "INSERT INTO r2_upload (bucket, key, upload_id, uploaded, http_json, custom_json) VALUES (?1,?2,?3,?4,?5,?6) " +
        "ON CONFLICT (bucket, key, upload_id) DO NOTHING",
      [
        msg.bucket,
        msg.key,
        uploadId,
        new Date().toISOString(),
        JSON.stringify(msg.httpMetadata || {}),
        JSON.stringify(msg.customMetadata || {}),
      ],
    );
    return { ok: true, key: msg.key, uploadId };
  }
  if (op === "r2.multipart.complete") {
    const upload = __sbSql(
      store,
      "SELECT http_json, custom_json FROM r2_upload WHERE bucket = ? AND key = ? AND upload_id = ?",
      [msg.bucket, msg.key, msg.uploadId],
    );
    if (!upload.rows.length) throw new Error("multipart upload not found");
    const stored = __sbSql(
      store,
      "SELECT part_number, size, etag FROM r2_part WHERE bucket = ? AND key = ? AND upload_id = ? ORDER BY part_number",
      [msg.bucket, msg.key, msg.uploadId],
    ).rows;
    const requested = msg.parts || [];
    if (!requested.length) throw new Error("complete requires at least one uploaded part");
    if (requested.length !== stored.length) throw new Error("uploaded parts do not match");
    for (let i = 0; i < stored.length; i++) {
      const part = requested[i] || {};
      const partNumber = Number(part.partNumber);
      if (partNumber !== Number(stored[i][0]) || String(part.etag || "") !== String(stored[i][2]))
        throw new Error("uploaded parts do not match");
      if (i > 0 && partNumber <= Number(requested[i - 1].partNumber))
        throw new Error("uploaded parts must be ordered by partNumber");
      if (i < stored.length - 1 && Number(stored[i][1]) !== Number(stored[0][1]))
        throw new Error("all multipart parts except the last must have the same size");
      if (
        i === stored.length - 1 &&
        stored.length > 1 &&
        Number(stored[i][1]) > Number(stored[0][1])
      )
        throw new Error("the last multipart part cannot be larger than the others");
    }
    const previous = __sbSql(store, "SELECT blob_id FROM r2 WHERE bucket = ? AND key = ?", [
      msg.bucket,
      msg.key,
    ]);
    const completed = JSON.parse(
      __sbR2MultipartCompleteRaw(store, String(msg.bucket), String(msg.key), String(msg.uploadId)),
    );
    if (completed.ok === false) throw new Error("r2 multipart complete: " + completed.error);
    const uploaded = new Date().toISOString();
    try {
      __sbSql(
        store,
        "INSERT INTO r2 (bucket, key, size, etag, uploaded, http_json, custom_json, blob_id) " +
          "VALUES (?1,?2,?3,?4,?5,?6,?7,?8) " +
          "ON CONFLICT (bucket, key) DO UPDATE SET size=?3, etag=?4, uploaded=?5, http_json=?6, custom_json=?7, blob_id=?8",
        [
          msg.bucket,
          msg.key,
          completed.size,
          completed.etag,
          uploaded,
          upload.rows[0][0],
          upload.rows[0][1],
          completed.etag,
        ],
      );
    } catch (error) {
      if (!previous.rows.length || String(previous.rows[0][0] || "") !== String(completed.etag))
        __sbR2DeleteRaw(store, String(msg.bucket), String(msg.key), String(completed.etag));
      throw error;
    }
    if (previous.rows.length && String(previous.rows[0][0] || "") !== String(completed.etag))
      __sbR2DeleteRaw(
        store,
        String(msg.bucket),
        String(msg.key),
        String(previous.rows[0][0] || ""),
      );
    __sbR2MultipartDeleteRaw(store, String(msg.bucket), String(msg.key), String(msg.uploadId));
    __sbSql(store, "DELETE FROM r2_part WHERE bucket = ? AND key = ? AND upload_id = ?", [
      msg.bucket,
      msg.key,
      msg.uploadId,
    ]);
    __sbSql(store, "DELETE FROM r2_upload WHERE bucket = ? AND key = ? AND upload_id = ?", [
      msg.bucket,
      msg.key,
      msg.uploadId,
    ]);
    return {
      ok: true,
      object: {
        key: msg.key,
        size: completed.size,
        etag: completed.etag,
        uploaded,
        httpMetadata: JSON.parse(upload.rows[0][0] || "{}"),
        customMetadata: JSON.parse(upload.rows[0][1] || "{}"),
      },
    };
  }
  if (op === "r2.multipart.abort") {
    const upload = __sbSql(
      store,
      "SELECT 1 FROM r2_upload WHERE bucket = ? AND key = ? AND upload_id = ?",
      [msg.bucket, msg.key, msg.uploadId],
    );
    if (!upload.rows.length) throw new Error("multipart upload not found");
    __sbR2MultipartDeleteRaw(store, String(msg.bucket), String(msg.key), String(msg.uploadId));
    __sbSql(store, "DELETE FROM r2_part WHERE bucket = ? AND key = ? AND upload_id = ?", [
      msg.bucket,
      msg.key,
      msg.uploadId,
    ]);
    __sbSql(store, "DELETE FROM r2_upload WHERE bucket = ? AND key = ? AND upload_id = ?", [
      msg.bucket,
      msg.key,
      msg.uploadId,
    ]);
    return { ok: true };
  }
  if (op === "r2.get" || op === "r2.head") {
    // head must not read the blob file: reading an 8 MB object only to drop
    // it costs the read and a full JSON escape for nothing.
    const wantsBody = op === "r2.get";
    const r = __sbSql(
      store,
      "SELECT size, etag, uploaded, http_json, custom_json, blob_id, md5 FROM r2 WHERE bucket = ? AND key = ?",
      [msg.bucket, msg.key],
    );
    if (!r.rows.length) return { ok: true, found: false };
    const row = r.rows[0];
    // Shape must match the broker's exactly: the shim reads `r.object`.
    return {
      ok: true,
      found: true,
      object: {
        key: msg.key,
        size: Number(row[0]),
        etag: row[1],
        uploaded: row[2],
        httpMetadata: JSON.parse(row[3] || "{}"),
        customMetadata: JSON.parse(row[4] || "{}"),
        md5: row[6],
      },
      blobId: row[5] || "",
      body: wantsBody
        ? __sbR2GetRaw(store, String(msg.bucket), String(msg.key), String(row[5] || ""))
        : undefined,
    };
  }
  if (op === "r2.delete") {
    const existing = __sbSql(store, "SELECT blob_id FROM r2 WHERE bucket = ? AND key = ?", [
      msg.bucket,
      msg.key,
    ]);
    __sbSql(store, "DELETE FROM r2 WHERE bucket = ? AND key = ?", [msg.bucket, msg.key]);
    if (existing.rows.length)
      __sbR2DeleteRaw(
        store,
        String(msg.bucket),
        String(msg.key),
        String(existing.rows[0][0] || ""),
      );
    return { ok: true };
  }
  if (op === "r2.md5") {
    // Recorded after the put that wrote these bytes (etag): the shim from 2026-10-26 hashes them.
    __sbSql(store, "UPDATE r2 SET md5 = ?1 WHERE bucket = ?2 AND key = ?3 AND etag = ?4", [
      String(msg.md5),
      msg.bucket,
      msg.key,
      String(msg.etag),
    ]);
    return { ok: true };
  }
  if (op === "r2.list") {
    // The prefix matches exactly at every date: LIKE ignored case and read "_" and "%" as
    // wildcards. With `page` (the shim from 2026-10-26), a page after the cursor.
    if (msg.page) return __sbR2ListPage(store, msg);
    const r = __sbSql(
      store,
      "SELECT key, size, etag, uploaded FROM r2 WHERE bucket = ?1 AND substr(key, 1, length(?2)) = ?2 ORDER BY key",
      [msg.bucket, msg.prefix || ""],
    );
    const objects = [];
    for (let i = 0; i < r.rows.length; i++) {
      objects.push({
        key: r.rows[i][0],
        size: Number(r.rows[i][1]),
        etag: r.rows[i][2],
        uploaded: r.rows[i][3],
        httpMetadata: {},
        customMetadata: {},
      });
    }
    return { ok: true, objects };
  }

  if (op === "queue.send" || op === "queue.send_batch") {
    // send_batch's items are { body, delaySeconds } objects, like the broker's. They were
    // stored with String(item), so every sendBatch() body arrived as "[object Object]"
    // (data loss), and delaySeconds was ignored on both calls.
    const items = op === "queue.send" ? [{ body: msg.body, delaySeconds: msg.delaySeconds }] : msg.messages || [];
    let first = -1;
    const now = Date.now();
    for (let i = 0; i < items.length; i++) {
      const item = items[i] || {};
      const delay = Math.max(0, Number(item.delaySeconds) || 0) * 1000;
      const visible = now + delay;
      if (first < 0 || visible < first) first = visible;
      __sbSql(
        store,
        "INSERT INTO mq (queue, id, body, visible_at, attempts, dead, sent_at) VALUES (?1,?2,?3,?4,0,0,?5)",
        [msg.queue, __sbHex(12), String(item.body), visible, now],
      );
    }
    // B22: on sproutd, the host delivers the batch (waking the app if it sleeps by then).
    if (first >= 0 && __sbLocal !== null && __sbLocal.queues.indexOf(msg.queue) !== -1) __sbHostDue(first);
    return msg.metrics ? { ok: true, metrics: __sbQueueBacklog(store, msg.queue) } : { ok: true };
  }

  if (op === "queue.metrics") return { ok: true, metrics: __sbQueueBacklog(store, msg.queue) };

  // A consumer announces itself (the broker uses it to pick the delivery rules of the app's
  // compatibility date); the embedded store reads the date itself.
  if (op === "queue.consumer") return { ok: true };

  if (op === "do.storage.get") {
    const r = __sbSql(store, "SELECT value FROM do_storage WHERE cls = ? AND id = ? AND key = ?", [
      msg.cls,
      msg.id,
      msg.key,
    ]);
    return r.rows.length
      ? { ok: true, found: true, value: r.rows[0][0] }
      : { ok: true, found: false };
  }
  if (op === "do.storage.put") {
    __sbSql(
      store,
      "INSERT INTO do_storage (cls, id, key, value) VALUES (?1,?2,?3,?4) ON CONFLICT (cls, id, key) DO UPDATE SET value = ?4",
      [msg.cls, msg.id, msg.key, msg.value],
    );
    return { ok: true };
  }
  if (op === "do.storage.delete") {
    const r = __sbSql(store, "DELETE FROM do_storage WHERE cls = ? AND id = ? AND key = ?", [
      msg.cls,
      msg.id,
      msg.key,
    ]);
    return { ok: true, deleted: r.changes > 0 };
  }
  if (op === "do.storage.delete_all") {
    __sbSql(store, "DELETE FROM do_storage WHERE cls = ? AND id = ?", [msg.cls, msg.id]);
    return { ok: true };
  }
  if (op === "do.storage.list") {
    const r = __sbSql(
      store,
      // Same clamp as the broker: an unbounded list builds the whole result in
      // memory before the caller sees any of it.
      // start, startAfter, end and reverse come from 2026-10-28 storage (null when unset).
      // The prefix match is exact: LIKE also matched _ and % as wildcards, case-insensitively.
      "SELECT key, value FROM do_storage WHERE cls = ?1 AND id = ?2 AND substr(key, 1, length(?3)) = ?3" +
        " AND (?5 IS NULL OR key >= ?5) AND (?6 IS NULL OR key > ?6) AND (?7 IS NULL OR key < ?7)" +
        (msg.reverse ? " ORDER BY key DESC" : " ORDER BY key") +
        " LIMIT ?4",
      [
        msg.cls,
        msg.id,
        msg.prefix || "",
        Math.min(Math.max(Number(msg.limit) || 1000, 1), 10000),
        msg.start == null ? null : String(msg.start),
        msg.startAfter == null ? null : String(msg.startAfter),
        msg.end == null ? null : String(msg.end),
      ],
    );
    const entries = [];
    for (let i = 0; i < r.rows.length; i++) entries.push([r.rows[i][0], r.rows[i][1]]);
    return { ok: true, entries };
  }
  if (op === "do.alarm.set") {
    __sbSql(store,"BEGIN IMMEDIATE",[]);
    try {
      __sbSql(store,"DELETE FROM do_alarm_delivery WHERE cls=? AND id=? AND expires<=?",[msg.cls,msg.id,Date.now()]);
      __sbSql(store,"INSERT INTO do_alarm (cls,id,at,attempts) VALUES (?1,?2,?3,0) ON CONFLICT (cls,id) DO UPDATE SET at=?3,attempts=0",[msg.cls,msg.id,Math.trunc(Number(msg.at)||0)]);
      __sbSql(store,"COMMIT",[]);
    } catch (error) {__sbSql(store,"ROLLBACK",[]);throw error;}
    // B22: on sproutd, the host runs the alarm at its time, waking the app if it sleeps.
    __sbHostDue(Math.trunc(Number(msg.at)||0));
    return {ok:true};
  }
  if (op === "do.alarm.get") {
    const r = __sbSql(store, "SELECT at FROM do_alarm WHERE cls=?1 AND id=?2 UNION ALL SELECT at FROM do_alarm_delivery WHERE cls=?1 AND id=?2 AND expires<=?3 AND attempts<5 LIMIT 1", [msg.cls,msg.id,Date.now()+5000]);
    return { ok: true, at: r.rows.length ? Number(r.rows[0][0]) : null };
  }
  if (op === "do.alarm.delete") {
    __sbSql(store,"BEGIN IMMEDIATE",[]);
    try {
      const retry=__sbSql(store,"DELETE FROM do_alarm_delivery WHERE cls=? AND id=?",[msg.cls,msg.id]);
      const pending=__sbSql(store,"DELETE FROM do_alarm WHERE cls=? AND id=?",[msg.cls,msg.id]);
      __sbSql(store,"COMMIT",[]);
      return {ok:true,deleted:Number(retry.changes)+Number(pending.changes)>0};
    } catch (error) {__sbSql(store,"ROLLBACK",[]);throw error;}
  }

  if (op === "ae.write") {
    __sbSql(
      store,
      "INSERT INTO ae (dataset, ts, indexes_json, blobs_json, doubles_json) VALUES (?1,?2,?3,?4,?5)",
      [
        msg.dataset,
        Date.now(),
        JSON.stringify(msg.indexes || []),
        JSON.stringify(msg.blobs || []),
        JSON.stringify(msg.doubles || []),
      ],
    );
    return { ok: true };
  }
  if (op === "ae.query") {
    // Reply must match the broker's: { count, rows: [{timestamp, indexes, blobs, doubles}] }.
    const limit = Math.min(Math.max(Number(msg.limit) || 20, 1), 200);
    const r = __sbSql(
      store,
      "SELECT ts, indexes_json, blobs_json, doubles_json FROM ae WHERE dataset = ? ORDER BY ts DESC, rowid DESC LIMIT ?",
      [msg.dataset, limit],
    );
    const total = __sbSql(store, "SELECT count(*) FROM ae WHERE dataset = ?", [msg.dataset]);
    const rows = [];
    for (let i = 0; i < r.rows.length; i++) {
      rows.push({
        timestamp: Number(r.rows[i][0]),
        indexes: JSON.parse(r.rows[i][1]),
        blobs: JSON.parse(r.rows[i][2]),
        doubles: JSON.parse(r.rows[i][3]),
      });
    }
    return { ok: true, count: total.rows.length ? Number(total.rows[0][0]) : 0, rows };
  }

  if (op === "ratelimit.check") {
    // #69 — fixed window. limit/period come in the message (the transport holds
    // no config). One upsert: same window -> count+1, new window -> reset to 1.
    // ponytail: fixed window, so a burst straddling the boundary can briefly
    // reach ~2x limit. Swap for a two-window weighted count if that matters.
    const limit = Math.max(Number(msg.limit) || 1, 1);
    const period = Math.max(Number(msg.period) || 60, 1);
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % period);
    const r = __sbSql(
      store,
      "INSERT INTO ratelimit (name, key, window_start, count) VALUES (?1, ?2, ?3, 1) " +
        "ON CONFLICT (name, key) DO UPDATE SET count = CASE WHEN window_start = ?3 THEN count + 1 ELSE 1 END, " +
        "window_start = ?3 RETURNING count",
      [String(msg.name), String(msg.key == null ? "" : msg.key), windowStart],
    );
    const count = r.rows.length ? Number(r.rows[0][0]) : 1;
    return { ok: true, success: count <= limit, resetAt: (windowStart + period) * 1000 };
  }

  if (op === "cache.match") {
    const name = msg.name || "default";
    const r = __sbSql(
      store,
      "SELECT status, headers_json, body, expires_at FROM cache WHERE name = ? AND cache_key = ?",
      [name, msg.key],
    );
    if (!r.rows.length) return { ok: true, found: false };
    const [status, headersJson, body, expiresAt] = r.rows[0];
    if (expiresAt != null && expiresAt <= Date.now()) {
      __sbSql(store, "DELETE FROM cache WHERE name = ? AND cache_key = ?", [name, msg.key]);
      return { ok: true, found: false };
    }
    return { ok: true, found: true, status, headers: JSON.parse(headersJson), body };
  }
  if (op === "cache.put") {
    const name = msg.name || "default";
    const status = Number(msg.status) || 200;
    const headers = msg.headers || {};
    const cacheControl = String(
      headers["cache-control"] || headers["Cache-Control"] || "",
    ).toLowerCase();
    // Mirrors Workers' own caches.default.put(): a 206 or an explicit
    // no-store/private is a silent no-op, not an error.
    if (
      status === 206 ||
      cacheControl.indexOf("no-store") !== -1 ||
      cacheControl.indexOf("private") !== -1
    ) {
      return { ok: true, stored: false };
    }
    const sMaxAge = /s-maxage=(\d+)/.exec(cacheControl);
    const maxAge = /max-age=(\d+)/.exec(cacheControl);
    const ttlSeconds = sMaxAge ? Number(sMaxAge[1]) : maxAge ? Number(maxAge[1]) : null;
    const expiresAt = ttlSeconds != null ? Date.now() + ttlSeconds * 1000 : null;
    __sbSql(
      store,
      "INSERT INTO cache (name, cache_key, status, headers_json, body, expires_at) VALUES (?1,?2,?3,?4,?5,?6) " +
        "ON CONFLICT (name, cache_key) DO UPDATE SET status = ?3, headers_json = ?4, body = ?5, expires_at = ?6",
      [name, msg.key, status, JSON.stringify(headers), msg.body, expiresAt],
    );
    return { ok: true, stored: true };
  }
  if (op === "cache.delete") {
    const name = msg.name || "default";
    const r = __sbSql(store, "DELETE FROM cache WHERE name = ? AND cache_key = ?", [name, msg.key]);
    return { ok: true, deleted: r.changes > 0 };
  }

  throw new Error("unknown op: " + op);
}

/** One D1 statement, shaped like the broker's d1Run. */
// BEGIN D1 OPS (lifted by test/native-d1.ts)
// D1 calls from compatibility date 2026-10-24 come with msg.strict (the shim sets it):
// exact parameter counts, foreign keys enforced, D1's error text, and rows as arrays with
// their column names (the shim builds the objects, so duplicate names survive in raw()).
// A BLOB comes from C as {"$blob":"HEX"}; strict calls get it so, older ones get the one
// char per byte string they always had.
var __sbD1Opened = {};
function __sbD1Open(path, strict) {
  if (__sbD1Opened[path] === strict) return;
  __sbD1Opened[path] = strict;
  __sbSql(path, strict ? "PRAGMA foreign_keys = ON" : "PRAGMA foreign_keys = OFF", []);
}
var __sbSqliteCodes = ["", "SQLITE_ERROR", "SQLITE_INTERNAL", "SQLITE_PERM", "SQLITE_ABORT", "SQLITE_BUSY",
  "SQLITE_LOCKED", "SQLITE_NOMEM", "SQLITE_READONLY", "SQLITE_INTERRUPT", "SQLITE_IOERR", "SQLITE_CORRUPT",
  "SQLITE_NOTFOUND", "SQLITE_FULL", "SQLITE_CANTOPEN", "SQLITE_PROTOCOL", "SQLITE_EMPTY", "SQLITE_SCHEMA",
  "SQLITE_TOOBIG", "SQLITE_CONSTRAINT", "SQLITE_MISMATCH", "SQLITE_MISUSE", "SQLITE_NOLFS", "SQLITE_AUTH",
  "SQLITE_FORMAT", "SQLITE_RANGE", "SQLITE_NOTADB"];
var __sbSqliteConstraints = { 275: "CHECK", 531: "COMMITHOOK", 787: "FOREIGNKEY", 1043: "FUNCTION",
  1299: "NOTNULL", 1555: "PRIMARYKEY", 1811: "TRIGGER", 2067: "UNIQUE", 2323: "VTAB", 2579: "ROWID",
  2835: "PINNED", 3091: "DATATYPE" };
function __sbD1Error(reply) {
  const code = Number(reply.code) || 0;
  const base = __sbSqliteCodes[code & 255] || "";
  let text = "D1_ERROR: " + reply.error;
  if (reply.offset >= 0) text += " at offset " + reply.offset;
  if (base) {
    text += ": " + base;
    if (__sbSqliteConstraints[code]) text += " (extended: SQLITE_CONSTRAINT_" + __sbSqliteConstraints[code] + ")";
  }
  return new Error(text);
}
function __sbD1Bytes(cell) {
  let out = "";
  const hex = String(cell.$blob);
  for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return out;
}
function __sbD1Run(path, sql, params, strict, multi) {
  if (strict) {
    // Rows come back as arrays, built in C (see __sbSqlRowsRaw); the header is small JSON.
    const pair = __sbSqlRowsRaw(path, multi ? "/*sb-d1-strict*//*sb-d1-multi*/" + String(sql) : "/*sb-d1-strict*/" + String(sql), JSON.stringify(params || []));
    if (pair[0] !== "") {
      const head = JSON.parse(pair[0]);
      if (head.ok === false) throw __sbD1Error(head);
    }
    const rows = pair[1];
    return { columns: pair[2], rows, native: true, meta: { changes: pair[3], last_row_id: pair[4], rows_read: rows.length } };
  }
  const r = JSON.parse(__sbSqlRaw(path, (strict ? "/*sb-d1-strict*/" : "") + String(sql), JSON.stringify(params || [])));
  if (r.ok === false) throw strict ? __sbD1Error(r) : new Error("sqlite: " + r.error);
  const meta = { changes: r.changes, last_row_id: r.rowid, rows_read: r.rows.length };
  if (strict) return { columns: r.cols, rows: r.rows, meta };
  const results = [];
  for (let i = 0; i < r.rows.length; i++) {
    const row = {};
    for (let c = 0; c < r.cols.length; c++) {
      const cell = r.rows[i][c];
      row[r.cols[c]] = cell !== null && Object(cell) === cell ? __sbD1Bytes(cell) : cell;
    }
    results.push(row);
  }
  return { results, meta };
}
// One statement of our own (SAVEPOINT, RELEASE, ...), failing in the caller's terms.
function __sbD1Control(path, sql, strict) {
  const r = JSON.parse(__sbSqlRaw(path, sql, "[]"));
  if (r.ok === false) throw strict ? __sbD1Error(r) : new Error("sqlite: " + r.error);
}
// Undo after a failure, best effort: the error the caller sees is the first one. If LTX
// capture failed, SQLite may already have committed; that error says so, and the database
// stays closed to writes (the capture latch), so a cleanup failure must not replace it.
function __sbD1Undo(path, savepoint) {
  try {
    __sbD1Control(path, "ROLLBACK TO " + savepoint, false);
    __sbD1Control(path, "RELEASE " + savepoint, false);
  } catch (ignored) {
    return ignored;
  }
  return null;
}
// One transaction, like D1: a statement that fails undoes the ones before it.
function __sbD1Batch(path, list, strict, multi) {
  const results = [];
  __sbD1Control(path, "SAVEPOINT sb_d1_batch", strict);
  try {
    for (let i = 0; i < list.length; i++) results.push(__sbD1Run(path, list[i].sql, list[i].params, strict, multi));
  } catch (err) {
    __sbD1Undo(path, "sb_d1_batch");
    throw err;
  }
  __sbD1Release(path, "sb_d1_batch", strict);
  return results;
}
// RELEASE of our outermost savepoint is the commit. A deferred constraint can fail it and
// leave the transaction open: undo it. A capture failure (code 10) comes after SQLite has
// committed: nothing to undo, and that error is the one to report.
function __sbD1Release(path, savepoint, strict) {
  const r = JSON.parse(__sbSqlRaw(path, "RELEASE " + savepoint, "[]"));
  if (r.ok !== false) return;
  if (Number(r.code) !== 10) __sbD1Undo(path, savepoint);
  throw strict ? __sbD1Error(r) : new Error("sqlite: " + r.error);
}
// exec() from 2026-10-24: line by line as workerd runs it, all or nothing.
function __sbD1ExecLines(path, lines, parity) {
  __sbD1Control(path, "SAVEPOINT sb_d1_exec", true);
  for (let i = 0; i < lines.length; i++) {
    const reply = JSON.parse(__sbSqlScriptRaw(path, String(lines[i])));
    if (reply.ok === false) {
      if (Number(reply.code) !== 10) __sbD1Undo(path, "sb_d1_exec");
      // parity (2026-11-03): D1's own wording after the line, " at offset N: SQLITE_ERROR" and all
      const detail = parity ? __sbD1Error(reply).message.slice(10) : reply.error;
      throw new Error("D1_EXEC_ERROR: Error in line " + (i + 1) + ": " + lines[i] + ": " + detail);
    }
  }
  __sbD1Release(path, "sb_d1_exec", true);
}
// END D1 OPS

/**
 * R2 object bodies, out of band (#56).
 *
 * The core shim calls these instead of putting an object body in a frame. The
 * broker transport defines the same two names in terms of __sbRpc, so the shim
 * itself does not know which backend it is on.
 */
globalThis.__sbR2Put = function (bucket, key, body, httpMetadata, customMetadata) {
  __sbQuotaCheck("R2 put()");
  __sbEnsureSchema();
  const reply = JSON.parse(
    __sbR2PutRaw(
      __sbStore(),
      String(bucket),
      String(key),
      body == null ? "" : String(body),
      JSON.stringify(httpMetadata || {}),
      JSON.stringify(customMetadata || {}),
    ),
  );
  if (reply.ok === false) throw new Error("sproutboat r2.put: " + reply.error);
  return {
    object: { key: String(key), size: reply.size, etag: reply.etag, uploaded: reply.uploaded },
  };
};

globalThis.__sbR2Get = function (bucket, key) {
  // Metadata through the normal path (small), bytes through their own.
  const meta = __sbEmbeddedDispatch({ op: "r2.head", bucket, key });
  if (!meta.found) return { found: false };
  return {
    found: true,
    object: meta.object,
    body: __sbR2GetRaw(__sbStore(), String(bucket), String(key), String(meta.blobId || "")),
  };
};

globalThis.__sbR2MultipartPut = function (bucket, key, uploadId, partNumber, body) {
  __sbQuotaCheck("R2 uploadPart()");
  __sbEnsureSchema();
  const store = __sbStore();
  const upload = __sbSql(
    store,
    "SELECT 1 FROM r2_upload WHERE bucket = ? AND key = ? AND upload_id = ?",
    [bucket, key, uploadId],
  );
  if (!upload.rows.length)
    throw new Error("sproutboat r2.multipart.put: multipart upload not found");
  const reply = JSON.parse(
    __sbR2MultipartPutRaw(
      store,
      String(bucket),
      String(key),
      String(uploadId),
      String(partNumber),
      body,
    ),
  );
  if (reply.ok === false) throw new Error("sproutboat r2.multipart.put: " + reply.error);
  __sbSql(
    store,
    "INSERT INTO r2_part (bucket, key, upload_id, part_number, size, etag) VALUES (?1,?2,?3,?4,?5,?6) " +
      "ON CONFLICT (bucket, key, upload_id, part_number) DO UPDATE SET size=?5, etag=?6",
    [bucket, key, uploadId, partNumber, reply.size, reply.etag],
  );
  return { ok: true, part: { partNumber, etag: reply.etag } };
};

// #232 — the C HTTP client already hands back raw bytes, one char per byte.
globalThis.__sbFetchUpstream = function (op, msg) {
  return __sbRpc(op, msg);
};

globalThis.__sbAssetsGet = function (path) {
  const reply = __sbEmbeddedDispatch({ op: "assets.get", path });
  const manifest = globalThis.__sbAssets.manifest || {};
  reply.rules = { headers: manifest.headers || [], redirects: manifest.redirects || [] };
  return reply;
};

/** The transport contract: one request string in, one reply string out. */
function __sbLtxConfigure() {
  // oxlint-disable-next-line no-unused-expressions -- configures the inline C transport.
  Porffor.c`sb_ltx_compat = 1;`;
}

function __sbCall(reqJson) {
  if (__sbCompatDate() >= "2026-10-22") __sbLtxConfigure();
  try {
    return JSON.stringify(__sbEmbeddedDispatch(JSON.parse(reqJson)));
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
}

// A strict D1 query without the generic dispatch: no request object, no copy of its fields, no walk
// down the op list and no result object. The same steps __sbEmbeddedDispatch runs for "d1.query".
__sbD1QueryDirect = function (db, sql, params) {
  if (__sbCompatDate() >= "2026-10-22") __sbLtxConfigure();
  __sbEnsureSchema();
  const path = __sbD1Path(String(db));
  __sbD1Open(path, true);
  __sbD1Quota(path);
  return __sbD1Run(path, sql, params, true, __sbCompatDate() >= "2026-11-03");
};

// The same dispatch without the JSON text either side: D1 calls take this (see __sbRpcDirect).
__sbCallDirect = function (req) {
  if (__sbCompatDate() >= "2026-10-22") __sbLtxConfigure();
  return __sbEmbeddedDispatch(req);
};

// --- local triggers ---------------------------------------------------------
// A deployed sprout is driven by the broker: it POSTs x-sb-trigger for cron
// ticks, queue batches and DO alarms. An embedded binary has no broker, so the
// same work runs on timers in this process and calls the handler directly.
// Porffor's native-fetch runtime provides setInterval, so this needs no C.

/** 5-field cron match (min hour dom month dow, UTC) — the same rules broker.ts applies. */
function __sbCronMatches(expr, when) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const fields = [
    when.getUTCMinutes(),
    when.getUTCHours(),
    when.getUTCDate(),
    when.getUTCMonth() + 1,
    when.getUTCDay(),
  ];
  for (let i = 0; i < 5; i++) {
    const spec = parts[i];
    const value = fields[i];
    const tokens = spec.split(",");
    let hit = false;
    for (let t = 0; t < tokens.length; t++) {
      const token = tokens[t];
      if (token === "*") {
        hit = true;
        break;
      }
      if (token.indexOf("*/") === 0) {
        const step = Number(token.slice(2));
        if (step && value % step === 0) {
          hit = true;
          break;
        }
        continue;
      }
      const range = token.split("-");
      if (range.length === 2) {
        if (value >= Number(range[0]) && value <= Number(range[1])) {
          hit = true;
          break;
        }
        continue;
      }
      if (Number(token) === value) {
        hit = true;
        break;
      }
    }
    if (!hit) return false;
  }
  return true;
}

var __sbLastCronTick = "";

// A queue's backlog as Queues reports it (send() results, batch.metadata): its live
// messages, their bytes and the oldest one's send time.
function __sbQueueBacklog(store, queue) {
  const r = __sbSql(
    store,
    "SELECT COUNT(*), COALESCE(SUM(LENGTH(CAST(body AS BLOB))),0), MIN(NULLIF(sent_at,0)) FROM mq WHERE queue=? AND dead=0",
    [queue],
  ).rows[0];
  return { backlogCount: Number(r[0]) || 0, backlogBytes: Number(r[1]) || 0, oldestMessageTimestamp: Number(r[2]) || 0 };
}

function __sbQueueAttemptCap(settings) {
  const retries = (settings.maxRetries !== undefined ? Number(settings.maxRetries) : 3) + 1;
  // From 2026-11-05 a lost delivery counts as a retry, so there is no floor of 5.
  return __sbQueuesFixed() ? retries : Math.max(5, retries);
}

// How long a queue's due messages wait to fill a batch (max_batch_timeout), in ms.
function __sbQueueWaitMs(binding) {
  return Math.max(0, Number(__sbQueueSettings(binding).maxBatchTimeout) || 0) * 1000;
}

// One delivery pass over the queues this worker consumes: claims up to max_batch_size (10)
// due messages per queue, hands them to queue() and applies its acks and retries. With a
// max_batch_timeout, a batch smaller than max_batch_size waits until its oldest message
// has been due that long.
async function __sbQueuePass(handlers, queues) {
  __sbEnsureSchema();
  const store = __sbStore();
  const now = Date.now();
  for (let q = 0; q < queues.length; q++) {
    const name = queues[q];
    const settings = __sbQueueSettings(name);
    const size = Math.min(100, Math.max(1, Number(settings.maxBatchSize) || 10));
    const wait = __sbQueueWaitMs(name);
    const claim = String(now) + ":" + String(Math.random());
    __sbSql(store, "BEGIN IMMEDIATE", []);
    let due;
    try {
      // A message whose deliveries never came back (the worker died or timed out each time)
      // stops after 5 attempts, or max_retries + 1 when that is more.
      if (__sbQueuesFixed()) __sbQueueRetire(store, name, settings, now);
      else
        __sbSql(store, "UPDATE mq SET dead=1 WHERE queue=? AND visible_at<=? AND attempts>=?", [
          name,
          now,
          __sbQueueAttemptCap(settings),
        ]);
      due = __sbSql(
        store,
        "SELECT id,body,attempts,sent_at,visible_at FROM mq WHERE queue=? AND dead=0 AND visible_at<=? ORDER BY visible_at LIMIT ?",
        [name, now, size],
      );
      if (wait > 0 && due.rows.length > 0 && due.rows.length < size && Number(due.rows[0][4]) + wait > now)
        due = { rows: [] };
      for (let i = 0; i < due.rows.length; i++)
        __sbSql(
          store,
          "UPDATE mq SET visible_at=?,claim_token=?,attempts=attempts+1 WHERE queue=? AND id=?",
          [now + 30000, claim, name, due.rows[i][0]],
        );
      __sbSql(store, "COMMIT", []);
    } catch (error) {
      __sbSql(store, "ROLLBACK", []);
      throw error;
    }
    if (due.rows.length === 0) continue;
    // Hide the batch first, so a slow handler cannot have it delivered twice.
    const messages = [];
    for (let i = 0; i < due.rows.length; i++) {
      const row = due.rows[i];
      messages.push({ id: row[0], body: row[1], timestamp: Number(row[3]) || now, attempts: Number(row[2]) + 1 });
    }
    const metadata = { metrics: __sbQueueBacklog(store, name) };
    // #171 — same ctx.waitUntil as the broker-delivered path, and the same
    // fix for the handler's own promise: `__sbRunQueueBatch` used to be
    // called fire-and-forget here too, so an async `queue()`'s ack/retry
    // calls made after its first `await` never reached these SQL writes.
    const __sbTasks = [];
    const ctx = {
      waitUntil(p) {
        if (p && __sbIsFn(p.then)) __sbTasks.push(p);
      },
    };
    // From 2026-11-05 a consumer that runs past the 30 s lease keeps its messages: the lease
    // is renewed while it runs, so they are not delivered a second time or lose their ack.
    const beat = __sbQueuesFixed()
      ? setInterval(() => {
          __sbSql(store, "UPDATE mq SET visible_at=? WHERE queue=? AND claim_token=? AND visible_at>?", [Date.now() + 30000, name, claim, Date.now()]);
        }, 10000)
      : null;
    let result;
    try {
      result = __sbRunQueueBatch(handlers, { queue: name, messages, metadata }, ctx);
      if (result && __sbIsFn(result.then)) result = await result;
      if (__sbTasks.length) await __sbDrainWaitUntil(__sbTasks);
    } finally {
      if (beat !== null) clearInterval(beat);
    }
    __sbQueueSettle(store, name, claim, result);
  }
}

// From 2026-11-05, the messages whose last allowed delivery never came back (the worker died or
// timed out): they leave the queue as a message past max_retries does, into the dead letter
// queue when there is one, or dropped. Runs inside the claim transaction.
function __sbQueueRetire(store, name, settings, now) {
  const rows = __sbSql(store, "SELECT id FROM mq WHERE queue=? AND dead=0 AND visible_at<=? AND attempts>=?", [
    name,
    now,
    __sbQueueAttemptCap(settings),
  ]).rows;
  if (rows.length === 0) return;
  if (settings.deadLetterQueue === undefined) {
    __sbSql(store, "UPDATE mq SET dead=1 WHERE queue=? AND visible_at<=? AND attempts>=?", [name, now, __sbQueueAttemptCap(settings)]);
    return;
  }
  const part = __sbQueuePart(settings.deadLetterQueue);
  for (let i = 0; i < rows.length; i++)
    __sbSql(store, "UPDATE mq SET queue=?,visible_at=?,attempts=0,claim_token='',dead=0 WHERE queue=? AND id=?", [part, now, name, rows[i][0]]);
  if (__sbLocal !== null && __sbLocal.queues.indexOf(part) !== -1) __sbHostDue(now);
}

// Applies a batch's outcome to the claimed rows. `dead` (past max_retries) move to the dead
// letter queue `deadLetter` as new messages, or are marked dead; `delays` gives each retry's
// delay in seconds (5 when the runtime sends none). A row whose claim expired meanwhile was
// handed out again and is left alone.
function __sbQueueSettle(store, name, claim, result) {
  const now = Date.now();
  const dead = result.dead || [];
  const delays = result.delays || null;
  for (let i = 0; i < dead.length; i++) {
    if (result.deadLetter)
      __sbSql(
        store,
        "UPDATE mq SET queue=?,visible_at=?,attempts=0,claim_token='',dead=0 WHERE queue=? AND id=? AND claim_token=? AND visible_at>?",
        [String(result.deadLetter), now, name, dead[i], claim, now],
      );
    else
      __sbSql(store, "UPDATE mq SET dead=1,claim_token='' WHERE queue=? AND id=? AND claim_token=? AND visible_at>?", [
        name,
        dead[i],
        claim,
        now,
      ]);
  }
  for (let i = 0; i < result.ack.length; i++) {
    __sbSql(
      store,
      "DELETE FROM mq WHERE queue=? AND id=? AND claim_token=? AND visible_at>?",
      [name, result.ack[i], claim, now],
    );
  }
  for (let i = 0; i < result.retry.length; i++) {
    const id = result.retry[i];
    if (dead.indexOf(id) !== -1) continue;
    const delay = delays !== null && delays[id] != null ? Math.max(0, Number(delays[id]) || 0) * 1000 : 5000;
    __sbSql(
      store,
      "UPDATE mq SET visible_at=?,claim_token='',dead=CASE WHEN attempts>=5 AND ?=0 THEN 1 ELSE 0 END WHERE queue=? AND id=? AND claim_token=? AND visible_at>?",
      [now + delay, delays !== null ? 1 : 0, name, id, claim, now],
    );
  }
  if (result.deadLetter && dead.length && __sbLocal !== null && __sbLocal.queues.indexOf(String(result.deadLetter)) !== -1)
    __sbHostDue(now);
}

// One pass over the Durable Object alarms that are due: claims up to 10 and runs alarm().
async function __sbAlarmPass() {
  __sbEnsureSchema();
  const store = __sbStore();
  const now = Date.now();
  __sbSql(store, "BEGIN IMMEDIATE", []);
  let due;
  const claim = String(now) + ":" + String(Math.random());
  try {
    __sbSql(store,"DELETE FROM do_alarm_delivery WHERE expires<=? AND attempts>=5 AND EXISTS (SELECT 1 FROM do_alarm a WHERE a.cls=do_alarm_delivery.cls AND a.id=do_alarm_delivery.id)",[now]);
    const pending = __sbSql(
      store,
      "SELECT cls,id,at,attempts FROM do_alarm WHERE at<=? AND NOT EXISTS (SELECT 1 FROM do_alarm_delivery d WHERE d.cls=do_alarm.cls AND d.id=do_alarm.id) ORDER BY at LIMIT 10",
      [now],
    );
    for (let i = 0; i < pending.rows.length; i++) {
      const r = pending.rows[i];
      __sbSql(store, "INSERT INTO do_alarm_delivery VALUES (?,?,?,?,?,?)", [
        r[0],
        r[1],
        r[2],
        r[3],
        "",
        0,
      ]);
      __sbSql(store, "DELETE FROM do_alarm WHERE cls=? AND id=? AND at=?", [r[0], r[1], r[2]]);
    }
    due = __sbSql(
      store,
      "SELECT cls,id,at,attempts FROM do_alarm_delivery WHERE expires<=? AND attempts<5 LIMIT 10",
      [now],
    );
    for (let i = 0; i < due.rows.length; i++)
      __sbSql(
        store,
        "UPDATE do_alarm_delivery SET token=?,expires=?,attempts=attempts+1 WHERE cls=? AND id=?",
        [claim, now + 30000, due.rows[i][0], due.rows[i][1]],
      );
    __sbSql(store, "COMMIT", []);
  } catch (error) {
    __sbSql(store, "ROLLBACK", []);
    throw error;
  }
  for (let i = 0; i < due.rows.length; i++) {
    const cls = due.rows[i][0];
    const id = due.rows[i][1];
    try {
      const instance = __sbGetDOInstance(cls, id);
      if (__sbIsFn(instance.alarm)) {
        const res = __sbDOGated()
          ? __sbDOEnter(instance.__sbGate, () => __sbDOAlarmCall(instance, cls, id, due.rows[i][2], null))
          : __sbDOAlarmCall(instance, cls, id, due.rows[i][2], null);
        if (res && __sbIsFn(res.then)) await res;
        if (instance.__sbTasks.length) await __sbDrainWaitUntil(instance.__sbTasks);
      }
      __sbSql(
        store,
        "DELETE FROM do_alarm_delivery WHERE cls=? AND id=? AND token=? AND expires>?",
        [cls, id, claim, Date.now()],
      );
    } catch {
      const scheduled = __sbSql(store, "SELECT 1 FROM do_alarm WHERE cls=? AND id=?", [
        cls,
        id,
      ]);
      if (scheduled.rows.length)
        __sbSql(
          store,
          "DELETE FROM do_alarm_delivery WHERE cls=? AND id=? AND token=? AND expires>?",
          [cls, id, claim, Date.now()],
        );
      else
        __sbSql(
          store,
          "UPDATE do_alarm_delivery SET expires=? WHERE cls=? AND id=? AND token=? AND expires>?",
          [Date.now() + 5000, cls, id, claim, Date.now()],
        );
    }
  }
}

// B22: on a host that delivers triggers (sproutd), what this worker consumes. Set by
// __sbStartLocalTriggers; null when the host does not drive this worker's triggers.
var __sbLocal = null;

// Tells the host when a queued message or an alarm falls due at `at` (epoch ms), so it
// wakes the app then, even from a reap. The host keeps the earliest time it was told.
function __sbHostDue(at) {
  if (__sbLocal !== null && __sbLocal.consumes) __sbHostNote("due " + String(Math.max(0, Math.trunc(Number(at) || 0))));
}

// When a queue next has a batch to deliver: its earliest visible message, plus the batch
// timeout unless a whole batch is already there.
function __sbQueueNextDue(store, queue) {
  const r = __sbSql(store, "SELECT MIN(visible_at) FROM mq WHERE queue=? AND dead=0", [queue]);
  const wait = __sbQueueWaitMs(queue);
  if (wait === 0 || !r.rows.length || r.rows[0][0] == null) return r;
  const size = Math.min(100, Math.max(1, Number(__sbQueueSettings(queue).maxBatchSize) || 10));
  const full = __sbSql(store, "SELECT COUNT(*) FROM mq WHERE queue=? AND dead=0 AND visible_at<=?", [queue, Date.now()]);
  return Number(full.rows[0][0]) >= size ? r : { rows: [[Number(r.rows[0][0]) + wait]] };
}

// The earliest time something this worker consumes falls due: a message becomes visible
// (or its claim expires), an alarm is set for, or a failed alarm is retried. -1 for none.
function __sbNextDue() {
  const store = __sbStore();
  let next = -1;
  const take = (r) => {
    if (r.rows.length && r.rows[0][0] != null) {
      const at = Number(r.rows[0][0]);
      if (next < 0 || at < next) next = at;
    }
  };
  const queues = __sbLocal.queues;
  for (let q = 0; q < queues.length; q++)
    take(__sbQueueNextDue(store, queues[q]));
  if (__sbLocal.alarms) {
    take(__sbSql(store, "SELECT MIN(at) FROM do_alarm", []));
    take(__sbSql(store, "SELECT MIN(expires) FROM do_alarm_delivery WHERE attempts<5", []));
  }
  return next;
}

// B22: the host's `due` trigger. Delivers what is due, then tells the host when to come back
// ("next -1": nothing is pending). The host sends one at a time per app.
globalThis.__sbRunLocalDue = async function () {
  if (__sbLocal === null) return new Response("no local triggers", { status: 404 });
  try {
    if (__sbLocal.queues.length) await __sbQueuePass(__sbLocal.handlers, __sbLocal.queues);
    if (__sbLocal.alarms) await __sbAlarmPass();
  } catch (error) {
    __sbLogUncaught("queue/alarm delivery", error);
  }
  let next = -1;
  try {
    next = __sbNextDue();
  } catch {
    // Unknown: the host asks again later rather than forgetting the app.
    next = Date.now() + 30000;
  }
  __sbHostNote("next " + String(next));
  return new Response(null, { status: 204 });
};

/**
 * Start the timers an embedded binary needs. Called from the generated module
 * once the handler object exists; the broker transport defines a no-op of the
 * same name, so the generated code is identical either way.
 *
 * B22: on sproutd the host delivers the triggers instead, and wakes a reaped app for
 * them: this reports the crons and whether the worker consumes queues or alarms, and
 * starts no timer (an interval would also keep the worker from ever going idle).
 */
globalThis.__sbStartLocalTriggers = function (handlers, bindings) {
  const crons = bindings.crons || [];
  const dos = bindings.do || [];
  const queues = __sbHandles(handlers, "queue") ? bindings.queues || [] : [];
  const scheduled = crons.length > 0 && __sbHandles(handlers, "scheduled");

  if (__sbHosted()) {
    __sbLocal = { handlers, queues, alarms: dos.length > 0, consumes: queues.length > 0 || dos.length > 0 };
    if (scheduled) __sbHostNote("crons\n" + crons.join("\n"));
    if (__sbLocal.consumes) __sbHostNote("local");
    return;
  }

  if (scheduled) {
    setInterval(async function () {
      const now = new Date();
      const stamp =
        now.getUTCFullYear() +
        "-" +
        now.getUTCMonth() +
        "-" +
        now.getUTCDate() +
        "-" +
        now.getUTCHours() +
        "-" +
        now.getUTCMinutes();
      if (stamp === __sbLastCronTick) return; // once a minute, like the broker
      __sbLastCronTick = stamp;
      for (let i = 0; i < crons.length; i++) {
        if (__sbCronMatches(crons[i], now)) {
          // #171 — ctx.waitUntil, and stop dropping the handler's own promise
          // (was fire-and-forget, same bug the broker-dispatched path had).
          const __sbTasks = [];
          const ctx = {
            waitUntil(p) {
              if (p && __sbIsFn(p.then)) __sbTasks.push(p);
            },
          };
          try {
            const receiver = __sbReceiver(handlers, ctx);
            const event = { cron: crons[i], scheduledTime: now.getTime(), noRetry() {} };
            const res = __sbCompatDate() >= "2026-09-28"
              ? receiver.scheduled(event, __sbEnvValue(), ctx)
              : receiver.scheduled(event, ctx);
            if (res && __sbIsFn(res.then)) await res;
          } catch (error) {
            __sbLogUncaught("scheduled", error);
          }
          if (__sbTasks.length) await __sbDrainWaitUntil(__sbTasks);
        }
      }
    }, 15000);
  }

  if (queues.length > 0) setInterval(() => __sbQueuePass(handlers, queues), 500);

  if (dos.length > 0) setInterval(() => __sbAlarmPass(), 500);
};

// crypto.subtle, native half: RSA, ECDSA, Ed25519, PBKDF2, HKDF and key encodings over BearSSL and
// Monocypher (packages/runtime/src/subtle/README.md). The C is generated into the block below from
// src/subtle/subtle.c and its vendored files: `bun run gen:subtle`.
// SUBTLE:BEGIN (generated by `bun run gen:subtle`; edit src/subtle/subtle.c, not this block)
// oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
Porffor.c`
// Monocypher 4.0.2 (BSD-2-Clause OR CC0-1.0), Loup Vaillant: vendor/monocypher*.[ch] without comments.
#define i8 sbm_i8
#define u8 sbm_u8
#define i16 sbm_i16
#define u32 sbm_u32
#define i32 sbm_i32
#define i64 sbm_i64
#define u64 sbm_u64
#define fe sbm_fe
#define ge sbm_ge
#define ge_cached sbm_ge_cached
#define ge_precomp sbm_ge_precomp
#define blk sbm_blk
#ifndef MONOCYPHER_H
#define MONOCYPHER_H

#include <stddef.h>
#include <stdint.h>


int crypto_verify16(const uint8_t a[16], const uint8_t b[16]);
int crypto_verify32(const uint8_t a[32], const uint8_t b[32]);
int crypto_verify64(const uint8_t a[64], const uint8_t b[64]);

void crypto_wipe(void *secret, size_t size);

void crypto_aead_lock(uint8_t       *cipher_text,
                      uint8_t        mac  [16],
                      const uint8_t  key  [32],
                      const uint8_t  nonce[24],
                      const uint8_t *ad,         size_t ad_size,
                      const uint8_t *plain_text, size_t text_size);
int crypto_aead_unlock(uint8_t       *plain_text,
                       const uint8_t  mac  [16],
                       const uint8_t  key  [32],
                       const uint8_t  nonce[24],
                       const uint8_t *ad,          size_t ad_size,
                       const uint8_t *cipher_text, size_t text_size);

typedef struct {
	uint64_t counter;
	uint8_t  key[32];
	uint8_t  nonce[8];
} crypto_aead_ctx;

void crypto_aead_init_x(crypto_aead_ctx *ctx,
                        const uint8_t key[32], const uint8_t nonce[24]);
void crypto_aead_init_djb(crypto_aead_ctx *ctx,
                          const uint8_t key[32], const uint8_t nonce[8]);
void crypto_aead_init_ietf(crypto_aead_ctx *ctx,
                           const uint8_t key[32], const uint8_t nonce[12]);

void crypto_aead_write(crypto_aead_ctx *ctx,
                       uint8_t         *cipher_text,
                       uint8_t          mac[16],
                       const uint8_t   *ad        , size_t ad_size,
                       const uint8_t   *plain_text, size_t text_size);
int crypto_aead_read(crypto_aead_ctx *ctx,
                     uint8_t         *plain_text,
                     const uint8_t    mac[16],
                     const uint8_t   *ad        , size_t ad_size,
                     const uint8_t   *cipher_text, size_t text_size);

void crypto_blake2b(uint8_t *hash,          size_t hash_size,
                    const uint8_t *message, size_t message_size);

void crypto_blake2b_keyed(uint8_t *hash,          size_t hash_size,
                          const uint8_t *key,     size_t key_size,
                          const uint8_t *message, size_t message_size);

typedef struct {

	uint64_t hash[8];
	uint64_t input_offset[2];
	uint64_t input[16];
	size_t   input_idx;
	size_t   hash_size;
} crypto_blake2b_ctx;

void crypto_blake2b_init(crypto_blake2b_ctx *ctx, size_t hash_size);
void crypto_blake2b_keyed_init(crypto_blake2b_ctx *ctx, size_t hash_size,
                               const uint8_t *key, size_t key_size);
void crypto_blake2b_update(crypto_blake2b_ctx *ctx,
                           const uint8_t *message, size_t message_size);
void crypto_blake2b_final(crypto_blake2b_ctx *ctx, uint8_t *hash);

#define CRYPTO_ARGON2_D  0
#define CRYPTO_ARGON2_I  1
#define CRYPTO_ARGON2_ID 2

typedef struct {
	uint32_t algorithm;
	uint32_t nb_blocks;
	uint32_t nb_passes;
	uint32_t nb_lanes;
} crypto_argon2_config;

typedef struct {
	const uint8_t *pass;
	const uint8_t *salt;
	uint32_t pass_size;
	uint32_t salt_size;
} crypto_argon2_inputs;

typedef struct {
	const uint8_t *key;
	const uint8_t *ad;
	uint32_t key_size;
	uint32_t ad_size;
} crypto_argon2_extras;

extern const crypto_argon2_extras crypto_argon2_no_extras;

void crypto_argon2(uint8_t *hash, uint32_t hash_size, void *work_area,
                   crypto_argon2_config config,
                   crypto_argon2_inputs inputs,
                   crypto_argon2_extras extras);

void crypto_x25519_public_key(uint8_t       public_key[32],
                              const uint8_t secret_key[32]);
void crypto_x25519(uint8_t       raw_shared_secret[32],
                   const uint8_t your_secret_key  [32],
                   const uint8_t their_public_key [32]);

void crypto_x25519_to_eddsa(uint8_t eddsa[32], const uint8_t x25519[32]);

void crypto_x25519_inverse(uint8_t       blind_salt [32],
                           const uint8_t private_key[32],
                           const uint8_t curve_point[32]);

void crypto_x25519_dirty_small(uint8_t pk[32], const uint8_t sk[32]);
void crypto_x25519_dirty_fast (uint8_t pk[32], const uint8_t sk[32]);

void crypto_eddsa_key_pair(uint8_t secret_key[64],
                           uint8_t public_key[32],
                           uint8_t seed[32]);
void crypto_eddsa_sign(uint8_t        signature [64],
                       const uint8_t  secret_key[64],
                       const uint8_t *message, size_t message_size);
int crypto_eddsa_check(const uint8_t  signature [64],
                       const uint8_t  public_key[32],
                       const uint8_t *message, size_t message_size);

void crypto_eddsa_to_x25519(uint8_t x25519[32], const uint8_t eddsa[32]);

void crypto_eddsa_trim_scalar(uint8_t out[32], const uint8_t in[32]);
void crypto_eddsa_reduce(uint8_t reduced[32], const uint8_t expanded[64]);
void crypto_eddsa_mul_add(uint8_t r[32],
                          const uint8_t a[32],
                          const uint8_t b[32],
                          const uint8_t c[32]);
void crypto_eddsa_scalarbase(uint8_t point[32], const uint8_t scalar[32]);
int crypto_eddsa_check_equation(const uint8_t signature[64],
                                const uint8_t public_key[32],
                                const uint8_t h_ram[32]);

void crypto_chacha20_h(uint8_t       out[32],
                       const uint8_t key[32],
                       const uint8_t in [16]);

uint64_t crypto_chacha20_djb(uint8_t       *cipher_text,
                             const uint8_t *plain_text,
                             size_t         text_size,
                             const uint8_t  key[32],
                             const uint8_t  nonce[8],
                             uint64_t       ctr);
uint32_t crypto_chacha20_ietf(uint8_t       *cipher_text,
                              const uint8_t *plain_text,
                              size_t         text_size,
                              const uint8_t  key[32],
                              const uint8_t  nonce[12],
                              uint32_t       ctr);
uint64_t crypto_chacha20_x(uint8_t       *cipher_text,
                           const uint8_t *plain_text,
                           size_t         text_size,
                           const uint8_t  key[32],
                           const uint8_t  nonce[24],
                           uint64_t       ctr);

void crypto_poly1305(uint8_t        mac[16],
                     const uint8_t *message, size_t message_size,
                     const uint8_t  key[32]);

typedef struct {

	uint8_t  c[16];
	size_t   c_idx;
	uint32_t r  [4];
	uint32_t pad[4];
	uint32_t h  [5];
} crypto_poly1305_ctx;

void crypto_poly1305_init  (crypto_poly1305_ctx *ctx, const uint8_t key[32]);
void crypto_poly1305_update(crypto_poly1305_ctx *ctx,
                            const uint8_t *message, size_t message_size);
void crypto_poly1305_final (crypto_poly1305_ctx *ctx, uint8_t mac[16]);

void crypto_elligator_map(uint8_t curve [32], const uint8_t hidden[32]);
int  crypto_elligator_rev(uint8_t hidden[32], const uint8_t curve [32],
                          uint8_t tweak);

void crypto_elligator_key_pair(uint8_t hidden[32], uint8_t secret_key[32],
                               uint8_t seed[32]);


#endif

#ifndef ED25519_H
#define ED25519_H



typedef struct {
	uint64_t hash[8];
	uint64_t input[16];
	uint64_t input_size[2];
	size_t   input_idx;
} crypto_sha512_ctx;

typedef struct {
	uint8_t key[128];
	crypto_sha512_ctx ctx;
} crypto_sha512_hmac_ctx;

void crypto_sha512_init  (crypto_sha512_ctx *ctx);
void crypto_sha512_update(crypto_sha512_ctx *ctx,
                          const uint8_t *message, size_t  message_size);
void crypto_sha512_final (crypto_sha512_ctx *ctx, uint8_t hash[64]);
void crypto_sha512(uint8_t hash[64],
                   const uint8_t *message, size_t message_size);

void crypto_sha512_hmac_init(crypto_sha512_hmac_ctx *ctx,
                             const uint8_t *key, size_t key_size);
void crypto_sha512_hmac_update(crypto_sha512_hmac_ctx *ctx,
                               const uint8_t *message, size_t  message_size);
void crypto_sha512_hmac_final(crypto_sha512_hmac_ctx *ctx, uint8_t hmac[64]);
void crypto_sha512_hmac(uint8_t hmac[64],
                        const uint8_t *key    , size_t key_size,
                        const uint8_t *message, size_t message_size);

void crypto_sha512_hkdf_expand(uint8_t       *okm,  size_t okm_size,
                               const uint8_t *prk,  size_t prk_size,
                               const uint8_t *info, size_t info_size);
void crypto_sha512_hkdf(uint8_t       *okm , size_t okm_size,
                        const uint8_t *ikm , size_t ikm_size,
                        const uint8_t *salt, size_t salt_size,
                        const uint8_t *info, size_t info_size);

void crypto_ed25519_key_pair(uint8_t secret_key[64],
                             uint8_t public_key[32],
                             uint8_t seed[32]);
void crypto_ed25519_sign(uint8_t        signature [64],
                         const uint8_t  secret_key[64],
                         const uint8_t *message, size_t message_size);
int crypto_ed25519_check(const uint8_t  signature [64],
                         const uint8_t  public_key[32],
                         const uint8_t *message, size_t message_size);

void crypto_ed25519_ph_sign(uint8_t       signature   [64],
                            const uint8_t secret_key  [64],
                            const uint8_t message_hash[64]);
int crypto_ed25519_ph_check(const uint8_t signature   [64],
                            const uint8_t public_key  [32],
                            const uint8_t message_hash[64]);


#endif

#define zero sbm1_zero
#define gap sbm1_gap
#define load24_le sbm1_load24_le
#define load32_le sbm1_load32_le
#define load64_le sbm1_load64_le
#define store32_le sbm1_store32_le
#define store64_le sbm1_store64_le
#define load32_le_buf sbm1_load32_le_buf
#define load64_le_buf sbm1_load64_le_buf
#define store32_le_buf sbm1_store32_le_buf
#define store64_le_buf sbm1_store64_le_buf
#define rotr64 sbm1_rotr64
#define rotl32 sbm1_rotl32
#define neq0 sbm1_neq0
#define x16 sbm1_x16
#define x32 sbm1_x32
#define x64 sbm1_x64
#define chacha20_rounds sbm1_chacha20_rounds
#define chacha20_constant sbm1_chacha20_constant
#define poly_blocks sbm1_poly_blocks
#define iv sbm1_iv
#define blake2b_compress sbm1_blake2b_compress
#define blake_update_32 sbm1_blake_update_32
#define blake_update_32_buf sbm1_blake_update_32_buf
#define copy_block sbm1_copy_block
#define xor_block sbm1_xor_block
#define extended_hash sbm1_extended_hash
#define g_rounds sbm1_g_rounds
#define fe_one sbm1_fe_one
#define sqrtm1 sbm1_sqrtm1
#define d sbm1_d
#define D2 sbm1_D2
#define lop_x sbm1_lop_x
#define lop_y sbm1_lop_y
#define ufactor sbm1_ufactor
#define A2 sbm1_A2
#define fe_0 sbm1_fe_0
#define fe_1 sbm1_fe_1
#define fe_copy sbm1_fe_copy
#define fe_neg sbm1_fe_neg
#define fe_add sbm1_fe_add
#define fe_sub sbm1_fe_sub
#define fe_cswap sbm1_fe_cswap
#define fe_ccopy sbm1_fe_ccopy
#define fe_frombytes_mask sbm1_fe_frombytes_mask
#define fe_frombytes sbm1_fe_frombytes
#define fe_tobytes sbm1_fe_tobytes
#define fe_mul_small sbm1_fe_mul_small
#define fe_mul sbm1_fe_mul
#define fe_sq sbm1_fe_sq
#define fe_isodd sbm1_fe_isodd
#define fe_isequal sbm1_fe_isequal
#define invsqrt sbm1_invsqrt
#define fe_invert sbm1_fe_invert
#define scalar_bit sbm1_scalar_bit
#define scalarmult sbm1_scalarmult
#define L sbm1_L
#define multiply sbm1_multiply
#define is_above_l sbm1_is_above_l
#define remove_l sbm1_remove_l
#define mod_l sbm1_mod_l
#define ge_zero sbm1_ge_zero
#define ge_tobytes sbm1_ge_tobytes
#define ge_frombytes_neg_vartime sbm1_ge_frombytes_neg_vartime
#define ge_cache sbm1_ge_cache
#define ge_add sbm1_ge_add
#define ge_sub sbm1_ge_sub
#define ge_madd sbm1_ge_madd
#define ge_msub sbm1_ge_msub
#define ge_double sbm1_ge_double
#define b_window sbm1_b_window
#define slide_init sbm1_slide_init
#define slide_step sbm1_slide_step
#define b_comb_low sbm1_b_comb_low
#define b_comb_high sbm1_b_comb_high
#define lookup_add sbm1_lookup_add
#define ge_scalarmult_base sbm1_ge_scalarmult_base
#define hash_reduce sbm1_hash_reduce
#define add_xl sbm1_add_xl
#define select_lop sbm1_select_lop
#define A sbm1_A
#define redc sbm1_redc
#define lock_auth sbm1_lock_auth


#define FOR_T(type, i, start, end) for (type i = (start); i < (end); i++)
#define FOR(i, start, end)         FOR_T(size_t, i, start, end)
#define COPY(dst, src, size)       FOR(_i_, 0, size) (dst)[_i_] = (src)[_i_]
#define ZERO(buf, size)            FOR(_i_, 0, size) (buf)[_i_] = 0
#define WIPE_CTX(ctx)              crypto_wipe(ctx   , sizeof(*(ctx)))
#define WIPE_BUFFER(buffer)        crypto_wipe(buffer, sizeof(buffer))
#define MIN(a, b)                  ((a) <= (b) ? (a) : (b))
#define MAX(a, b)                  ((a) >= (b) ? (a) : (b))

typedef int8_t   i8;
typedef uint8_t  u8;
typedef int16_t  i16;
typedef uint32_t u32;
typedef int32_t  i32;
typedef int64_t  i64;
typedef uint64_t u64;

static const u8 zero[128] = {0};

static size_t gap(size_t x, size_t pow_2)
{
	return (~x + 1) & (pow_2 - 1);
}

static u32 load24_le(const u8 s[3])
{
	return
		((u32)s[0] <<  0) |
		((u32)s[1] <<  8) |
		((u32)s[2] << 16);
}

static u32 load32_le(const u8 s[4])
{
	return
		((u32)s[0] <<  0) |
		((u32)s[1] <<  8) |
		((u32)s[2] << 16) |
		((u32)s[3] << 24);
}

static u64 load64_le(const u8 s[8])
{
	return load32_le(s) | ((u64)load32_le(s+4) << 32);
}

static void store32_le(u8 out[4], u32 in)
{
	out[0] =  in        & 0xff;
	out[1] = (in >>  8) & 0xff;
	out[2] = (in >> 16) & 0xff;
	out[3] = (in >> 24) & 0xff;
}

static void store64_le(u8 out[8], u64 in)
{
	store32_le(out    , (u32)in );
	store32_le(out + 4, in >> 32);
}

static void load32_le_buf (u32 *dst, const u8 *src, size_t size) {
	FOR(i, 0, size) { dst[i] = load32_le(src + i*4); }
}
static void load64_le_buf (u64 *dst, const u8 *src, size_t size) {
	FOR(i, 0, size) { dst[i] = load64_le(src + i*8); }
}
static void store32_le_buf(u8 *dst, const u32 *src, size_t size) {
	FOR(i, 0, size) { store32_le(dst + i*4, src[i]); }
}
static void store64_le_buf(u8 *dst, const u64 *src, size_t size) {
	FOR(i, 0, size) { store64_le(dst + i*8, src[i]); }
}

static u64 rotr64(u64 x, u64 n) { return (x >> n) ^ (x << (64 - n)); }
static u32 rotl32(u32 x, u32 n) { return (x << n) ^ (x >> (32 - n)); }

static int neq0(u64 diff)
{

	u64 half = (diff >> 32) | ((u32)diff);
	return (1 & ((half - 1) >> 32)) - 1;
}

static u64 x16(const u8 a[16], const u8 b[16])
{
	return (load64_le(a + 0) ^ load64_le(b + 0))
		|  (load64_le(a + 8) ^ load64_le(b + 8));
}
static u64 x32(const u8 a[32],const u8 b[32]){return x16(a,b)| x16(a+16, b+16);}
static u64 x64(const u8 a[64],const u8 b[64]){return x32(a,b)| x32(a+32, b+32);}
int crypto_verify16(const u8 a[16], const u8 b[16]){ return neq0(x16(a, b)); }
int crypto_verify32(const u8 a[32], const u8 b[32]){ return neq0(x32(a, b)); }
int crypto_verify64(const u8 a[64], const u8 b[64]){ return neq0(x64(a, b)); }

void crypto_wipe(void *secret, size_t size)
{
	volatile u8 *v_secret = (u8*)secret;
	ZERO(v_secret, size);
}

#define QUARTERROUND(a, b, c, d)	\
	a += b;  d = rotl32(d ^ a, 16); \
	c += d;  b = rotl32(b ^ c, 12); \
	a += b;  d = rotl32(d ^ a,  8); \
	c += d;  b = rotl32(b ^ c,  7)

static void chacha20_rounds(u32 out[16], const u32 in[16])
{

	u32 t0  = in[ 0];  u32 t1  = in[ 1];  u32 t2  = in[ 2];  u32 t3  = in[ 3];
	u32 t4  = in[ 4];  u32 t5  = in[ 5];  u32 t6  = in[ 6];  u32 t7  = in[ 7];
	u32 t8  = in[ 8];  u32 t9  = in[ 9];  u32 t10 = in[10];  u32 t11 = in[11];
	u32 t12 = in[12];  u32 t13 = in[13];  u32 t14 = in[14];  u32 t15 = in[15];

	FOR (i, 0, 10) {
		QUARTERROUND(t0, t4, t8 , t12);
		QUARTERROUND(t1, t5, t9 , t13);
		QUARTERROUND(t2, t6, t10, t14);
		QUARTERROUND(t3, t7, t11, t15);
		QUARTERROUND(t0, t5, t10, t15);
		QUARTERROUND(t1, t6, t11, t12);
		QUARTERROUND(t2, t7, t8 , t13);
		QUARTERROUND(t3, t4, t9 , t14);
	}
	out[ 0] = t0;   out[ 1] = t1;   out[ 2] = t2;   out[ 3] = t3;
	out[ 4] = t4;   out[ 5] = t5;   out[ 6] = t6;   out[ 7] = t7;
	out[ 8] = t8;   out[ 9] = t9;   out[10] = t10;  out[11] = t11;
	out[12] = t12;  out[13] = t13;  out[14] = t14;  out[15] = t15;
}

static const u8 *chacha20_constant = (const u8*)"expand 32-byte k";

void crypto_chacha20_h(u8 out[32], const u8 key[32], const u8 in [16])
{
	u32 block[16];
	load32_le_buf(block     , chacha20_constant, 4);
	load32_le_buf(block +  4, key              , 8);
	load32_le_buf(block + 12, in               , 4);

	chacha20_rounds(block, block);

	store32_le_buf(out   , block   , 4);
	store32_le_buf(out+16, block+12, 4);
	WIPE_BUFFER(block);
}

u64 crypto_chacha20_djb(u8 *cipher_text, const u8 *plain_text,
                        size_t text_size, const u8 key[32], const u8 nonce[8],
                        u64 ctr)
{
	u32 input[16];
	load32_le_buf(input     , chacha20_constant, 4);
	load32_le_buf(input +  4, key              , 8);
	load32_le_buf(input + 14, nonce            , 2);
	input[12] = (u32) ctr;
	input[13] = (u32)(ctr >> 32);

	u32    pool[16];
	size_t nb_blocks = text_size >> 6;
	FOR (i, 0, nb_blocks) {
		chacha20_rounds(pool, input);
		if (plain_text != 0) {
			FOR (j, 0, 16) {
				u32 p = pool[j] + input[j];
				store32_le(cipher_text, p ^ load32_le(plain_text));
				cipher_text += 4;
				plain_text  += 4;
			}
		} else {
			FOR (j, 0, 16) {
				u32 p = pool[j] + input[j];
				store32_le(cipher_text, p);
				cipher_text += 4;
			}
		}
		input[12]++;
		if (input[12] == 0) {
			input[13]++;
		}
	}
	text_size &= 63;

	if (text_size > 0) {
		if (plain_text == 0) {
			plain_text = zero;
		}
		chacha20_rounds(pool, input);
		u8 tmp[64];
		FOR (i, 0, 16) {
			store32_le(tmp + i*4, pool[i] + input[i]);
		}
		FOR (i, 0, text_size) {
			cipher_text[i] = tmp[i] ^ plain_text[i];
		}
		WIPE_BUFFER(tmp);
	}
	ctr = input[12] + ((u64)input[13] << 32) + (text_size > 0);

	WIPE_BUFFER(pool);
	WIPE_BUFFER(input);
	return ctr;
}

u32 crypto_chacha20_ietf(u8 *cipher_text, const u8 *plain_text,
                         size_t text_size,
                         const u8 key[32], const u8 nonce[12], u32 ctr)
{
	u64 big_ctr = ctr + ((u64)load32_le(nonce) << 32);
	return (u32)crypto_chacha20_djb(cipher_text, plain_text, text_size,
	                                key, nonce + 4, big_ctr);
}

u64 crypto_chacha20_x(u8 *cipher_text, const u8 *plain_text,
                      size_t text_size,
                      const u8 key[32], const u8 nonce[24], u64 ctr)
{
	u8 sub_key[32];
	crypto_chacha20_h(sub_key, key, nonce);
	ctr = crypto_chacha20_djb(cipher_text, plain_text, text_size,
	                          sub_key, nonce + 16, ctr);
	WIPE_BUFFER(sub_key);
	return ctr;
}

static void poly_blocks(crypto_poly1305_ctx *ctx, const u8 *in,
                        size_t nb_blocks, unsigned end)
{

	const u32 r0 = ctx->r[0];
	const u32 r1 = ctx->r[1];
	const u32 r2 = ctx->r[2];
	const u32 r3 = ctx->r[3];
	const u32 rr0 = (r0 >> 2) * 5;
	const u32 rr1 = (r1 >> 2) + r1;
	const u32 rr2 = (r2 >> 2) + r2;
	const u32 rr3 = (r3 >> 2) + r3;
	const u32 rr4 = r0 & 3;
	u32 h0 = ctx->h[0];
	u32 h1 = ctx->h[1];
	u32 h2 = ctx->h[2];
	u32 h3 = ctx->h[3];
	u32 h4 = ctx->h[4];

	FOR (i, 0, nb_blocks) {

		const u64 s0 = (u64)h0 + load32_le(in);  in += 4;
		const u64 s1 = (u64)h1 + load32_le(in);  in += 4;
		const u64 s2 = (u64)h2 + load32_le(in);  in += 4;
		const u64 s3 = (u64)h3 + load32_le(in);  in += 4;
		const u32 s4 =      h4 + end;

		const u64 x0 = s0*r0+ s1*rr3+ s2*rr2+ s3*rr1+ s4*rr0;
		const u64 x1 = s0*r1+ s1*r0 + s2*rr3+ s3*rr2+ s4*rr1;
		const u64 x2 = s0*r2+ s1*r1 + s2*r0 + s3*rr3+ s4*rr2;
		const u64 x3 = s0*r3+ s1*r2 + s2*r1 + s3*r0 + s4*rr3;
		const u32 x4 =                                s4*rr4;

		const u32 u5 = x4 + (x3 >> 32);
		const u64 u0 = (u5 >>  2) * 5 + (x0 & 0xffffffff);
		const u64 u1 = (u0 >> 32)     + (x1 & 0xffffffff) + (x0 >> 32);
		const u64 u2 = (u1 >> 32)     + (x2 & 0xffffffff) + (x1 >> 32);
		const u64 u3 = (u2 >> 32)     + (x3 & 0xffffffff) + (x2 >> 32);
		const u32 u4 = (u3 >> 32)     + (u5 & 3);

		h0 = u0 & 0xffffffff;
		h1 = u1 & 0xffffffff;
		h2 = u2 & 0xffffffff;
		h3 = u3 & 0xffffffff;
		h4 = u4;
	}
	ctx->h[0] = h0;
	ctx->h[1] = h1;
	ctx->h[2] = h2;
	ctx->h[3] = h3;
	ctx->h[4] = h4;
}

void crypto_poly1305_init(crypto_poly1305_ctx *ctx, const u8 key[32])
{
	ZERO(ctx->h, 5);
	ctx->c_idx = 0;

	load32_le_buf(ctx->r  , key   , 4);
	load32_le_buf(ctx->pad, key+16, 4);
	FOR (i, 0, 1) { ctx->r[i] &= 0x0fffffff; }
	FOR (i, 1, 4) { ctx->r[i] &= 0x0ffffffc; }
}

void crypto_poly1305_update(crypto_poly1305_ctx *ctx,
                            const u8 *message, size_t message_size)
{

	if (message_size == 0) {
		return;
	}

	size_t aligned = MIN(gap(ctx->c_idx, 16), message_size);
	FOR (i, 0, aligned) {
		ctx->c[ctx->c_idx] = *message;
		ctx->c_idx++;
		message++;
		message_size--;
	}

	if (ctx->c_idx == 16) {
		poly_blocks(ctx, ctx->c, 1, 1);
		ctx->c_idx = 0;
	}

	size_t nb_blocks = message_size >> 4;
	poly_blocks(ctx, message, nb_blocks, 1);
	message      += nb_blocks << 4;
	message_size &= 15;

	FOR (i, 0, message_size) {
		ctx->c[ctx->c_idx] = message[i];
		ctx->c_idx++;
	}
}

void crypto_poly1305_final(crypto_poly1305_ctx *ctx, u8 mac[16])
{

	if (ctx->c_idx != 0) {
		ZERO(ctx->c + ctx->c_idx, 16 - ctx->c_idx);
		ctx->c[ctx->c_idx] = 1;
		poly_blocks(ctx, ctx->c, 1, 0);
	}

	u64 c = 5;
	FOR (i, 0, 4) {
		c  += ctx->h[i];
		c >>= 32;
	}
	c += ctx->h[4];
	c  = (c >> 2) * 5;

	FOR (i, 0, 4) {
		c += (u64)ctx->h[i] + ctx->pad[i];
		store32_le(mac + i*4, (u32)c);
		c = c >> 32;
	}
	WIPE_CTX(ctx);
}

void crypto_poly1305(u8     mac[16],  const u8 *message,
                     size_t message_size, const u8  key[32])
{
	crypto_poly1305_ctx ctx;
	crypto_poly1305_init  (&ctx, key);
	crypto_poly1305_update(&ctx, message, message_size);
	crypto_poly1305_final (&ctx, mac);
}

static const u64 iv[8] = {
	0x6a09e667f3bcc908, 0xbb67ae8584caa73b,
	0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1,
	0x510e527fade682d1, 0x9b05688c2b3e6c1f,
	0x1f83d9abfb41bd6b, 0x5be0cd19137e2179,
};

static void blake2b_compress(crypto_blake2b_ctx *ctx, int is_last_block)
{
	static const u8 sigma[12][16] = {
		{  0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15 },
		{ 14, 10,  4,  8,  9, 15, 13,  6,  1, 12,  0,  2, 11,  7,  5,  3 },
		{ 11,  8, 12,  0,  5,  2, 15, 13, 10, 14,  3,  6,  7,  1,  9,  4 },
		{  7,  9,  3,  1, 13, 12, 11, 14,  2,  6,  5, 10,  4,  0, 15,  8 },
		{  9,  0,  5,  7,  2,  4, 10, 15, 14,  1, 11, 12,  6,  8,  3, 13 },
		{  2, 12,  6, 10,  0, 11,  8,  3,  4, 13,  7,  5, 15, 14,  1,  9 },
		{ 12,  5,  1, 15, 14, 13,  4, 10,  0,  7,  6,  3,  9,  2,  8, 11 },
		{ 13, 11,  7, 14, 12,  1,  3,  9,  5,  0, 15,  4,  8,  6,  2, 10 },
		{  6, 15, 14,  9, 11,  3,  0,  8, 12,  2, 13,  7,  1,  4, 10,  5 },
		{ 10,  2,  8,  4,  7,  6,  1,  5, 15, 11,  9, 14,  3, 12, 13,  0 },
		{  0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15 },
		{ 14, 10,  4,  8,  9, 15, 13,  6,  1, 12,  0,  2, 11,  7,  5,  3 },
	};

	u64   *x = ctx->input_offset;
	size_t y = ctx->input_idx;
	x[0] += y;
	if (x[0] < y) {
		x[1]++;
	}

	u64 v0 = ctx->hash[0];  u64 v8  = iv[0];
	u64 v1 = ctx->hash[1];  u64 v9  = iv[1];
	u64 v2 = ctx->hash[2];  u64 v10 = iv[2];
	u64 v3 = ctx->hash[3];  u64 v11 = iv[3];
	u64 v4 = ctx->hash[4];  u64 v12 = iv[4] ^ ctx->input_offset[0];
	u64 v5 = ctx->hash[5];  u64 v13 = iv[5] ^ ctx->input_offset[1];
	u64 v6 = ctx->hash[6];  u64 v14 = iv[6] ^ (u64)~(is_last_block - 1);
	u64 v7 = ctx->hash[7];  u64 v15 = iv[7];

	u64 *input = ctx->input;
#define BLAKE2_G(a, b, c, d, x, y)	\
	a += b + x;  d = rotr64(d ^ a, 32); \
	c += d;      b = rotr64(b ^ c, 24); \
	a += b + y;  d = rotr64(d ^ a, 16); \
	c += d;      b = rotr64(b ^ c, 63)
#define BLAKE2_ROUND(i)	\
	BLAKE2_G(v0, v4, v8 , v12, input[sigma[i][ 0]], input[sigma[i][ 1]]); \
	BLAKE2_G(v1, v5, v9 , v13, input[sigma[i][ 2]], input[sigma[i][ 3]]); \
	BLAKE2_G(v2, v6, v10, v14, input[sigma[i][ 4]], input[sigma[i][ 5]]); \
	BLAKE2_G(v3, v7, v11, v15, input[sigma[i][ 6]], input[sigma[i][ 7]]); \
	BLAKE2_G(v0, v5, v10, v15, input[sigma[i][ 8]], input[sigma[i][ 9]]); \
	BLAKE2_G(v1, v6, v11, v12, input[sigma[i][10]], input[sigma[i][11]]); \
	BLAKE2_G(v2, v7, v8 , v13, input[sigma[i][12]], input[sigma[i][13]]); \
	BLAKE2_G(v3, v4, v9 , v14, input[sigma[i][14]], input[sigma[i][15]])

#ifdef BLAKE2_NO_UNROLLING
	FOR (i, 0, 12) {
		BLAKE2_ROUND(i);
	}
#else
	BLAKE2_ROUND(0);  BLAKE2_ROUND(1);  BLAKE2_ROUND(2);  BLAKE2_ROUND(3);
	BLAKE2_ROUND(4);  BLAKE2_ROUND(5);  BLAKE2_ROUND(6);  BLAKE2_ROUND(7);
	BLAKE2_ROUND(8);  BLAKE2_ROUND(9);  BLAKE2_ROUND(10); BLAKE2_ROUND(11);
#endif

	ctx->hash[0] ^= v0 ^ v8;   ctx->hash[1] ^= v1 ^ v9;
	ctx->hash[2] ^= v2 ^ v10;  ctx->hash[3] ^= v3 ^ v11;
	ctx->hash[4] ^= v4 ^ v12;  ctx->hash[5] ^= v5 ^ v13;
	ctx->hash[6] ^= v6 ^ v14;  ctx->hash[7] ^= v7 ^ v15;
}

void crypto_blake2b_keyed_init(crypto_blake2b_ctx *ctx, size_t hash_size,
                               const u8 *key, size_t key_size)
{

	COPY(ctx->hash, iv, 8);
	ctx->hash[0] ^= 0x01010000 ^ (key_size << 8) ^ hash_size;

	ctx->input_offset[0] = 0;
	ctx->input_offset[1] = 0;
	ctx->hash_size       = hash_size;
	ctx->input_idx       = 0;
	ZERO(ctx->input, 16);

	if (key_size > 0) {
		u8 key_block[128] = {0};
		COPY(key_block, key, key_size);

		load64_le_buf(ctx->input, key_block, 16);
		ctx->input_idx = 128;
	}
}

void crypto_blake2b_init(crypto_blake2b_ctx *ctx, size_t hash_size)
{
	crypto_blake2b_keyed_init(ctx, hash_size, 0, 0);
}

void crypto_blake2b_update(crypto_blake2b_ctx *ctx,
                           const u8 *message, size_t message_size)
{

	if (message_size == 0) {
		return;
	}

	if ((ctx->input_idx & 7) != 0) {
		size_t nb_bytes = MIN(gap(ctx->input_idx, 8), message_size);
		size_t word     = ctx->input_idx >> 3;
		size_t byte     = ctx->input_idx & 7;
		FOR (i, 0, nb_bytes) {
			ctx->input[word] |= (u64)message[i] << ((byte + i) << 3);
		}
		ctx->input_idx += nb_bytes;
		message        += nb_bytes;
		message_size   -= nb_bytes;
	}

	if ((ctx->input_idx & 127) != 0) {
		size_t nb_words = MIN(gap(ctx->input_idx, 128), message_size) >> 3;
		load64_le_buf(ctx->input + (ctx->input_idx >> 3), message, nb_words);
		ctx->input_idx += nb_words << 3;
		message        += nb_words << 3;
		message_size   -= nb_words << 3;
	}

	size_t nb_blocks = message_size >> 7;
	FOR (i, 0, nb_blocks) {
		if (ctx->input_idx == 128) {
			blake2b_compress(ctx, 0);
		}
		load64_le_buf(ctx->input, message, 16);
		message += 128;
		ctx->input_idx = 128;
	}
	message_size &= 127;

	if (message_size != 0) {

		if (ctx->input_idx == 128) {
			blake2b_compress(ctx, 0);
			ctx->input_idx = 0;
		}
		if (ctx->input_idx == 0) {
			ZERO(ctx->input, 16);
		}

		size_t nb_words = message_size >> 3;
		load64_le_buf(ctx->input, message, nb_words);
		ctx->input_idx += nb_words << 3;
		message        += nb_words << 3;
		message_size   -= nb_words << 3;

		FOR (i, 0, message_size) {
			size_t word = ctx->input_idx >> 3;
			size_t byte = ctx->input_idx & 7;
			ctx->input[word] |= (u64)message[i] << (byte << 3);
			ctx->input_idx++;
		}
	}
}

void crypto_blake2b_final(crypto_blake2b_ctx *ctx, u8 *hash)
{
	blake2b_compress(ctx, 1);
	size_t hash_size = MIN(ctx->hash_size, 64);
	size_t nb_words  = hash_size >> 3;
	store64_le_buf(hash, ctx->hash, nb_words);
	FOR (i, nb_words << 3, hash_size) {
		hash[i] = (ctx->hash[i >> 3] >> (8 * (i & 7))) & 0xff;
	}
	WIPE_CTX(ctx);
}

void crypto_blake2b_keyed(u8 *hash,          size_t hash_size,
                          const u8 *key,     size_t key_size,
                          const u8 *message, size_t message_size)
{
	crypto_blake2b_ctx ctx;
	crypto_blake2b_keyed_init(&ctx, hash_size, key, key_size);
	crypto_blake2b_update    (&ctx, message, message_size);
	crypto_blake2b_final     (&ctx, hash);
}

void crypto_blake2b(u8 *hash, size_t hash_size, const u8 *msg, size_t msg_size)
{
	crypto_blake2b_keyed(hash, hash_size, 0, 0, msg, msg_size);
}

typedef struct { u64 a[128]; } blk;

static void blake_update_32(crypto_blake2b_ctx *ctx, u32 input)
{
	u8 buf[4];
	store32_le(buf, input);
	crypto_blake2b_update(ctx, buf, 4);
	WIPE_BUFFER(buf);
}

static void blake_update_32_buf(crypto_blake2b_ctx *ctx,
                                const u8 *buf, u32 size)
{
	blake_update_32(ctx, size);
	crypto_blake2b_update(ctx, buf, size);
}

static void copy_block(blk *o,const blk*in){FOR(i, 0, 128) o->a[i]  = in->a[i];}
static void  xor_block(blk *o,const blk*in){FOR(i, 0, 128) o->a[i] ^= in->a[i];}

static void extended_hash(u8       *digest, u32 digest_size,
                          const u8 *input , u32 input_size)
{
	crypto_blake2b_ctx ctx;
	crypto_blake2b_init  (&ctx, MIN(digest_size, 64));
	blake_update_32      (&ctx, digest_size);
	crypto_blake2b_update(&ctx, input, input_size);
	crypto_blake2b_final (&ctx, digest);

	if (digest_size > 64) {

		u32 r   = (u32)(((u64)digest_size + 31) >> 5) - 2;
		u32 i   =  1;
		u32 in  =  0;
		u32 out = 32;
		while (i < r) {

			crypto_blake2b(digest + out, 64, digest + in, 64);
			i   +=  1;
			in  += 32;
			out += 32;
		}
		crypto_blake2b(digest + out, digest_size - (32 * r), digest + in , 64);
	}
}

#define LSB(x) ((u64)(u32)x)
#define G(a, b, c, d)	\
	a += b + ((LSB(a) * LSB(b)) << 1);  d ^= a;  d = rotr64(d, 32); \
	c += d + ((LSB(c) * LSB(d)) << 1);  b ^= c;  b = rotr64(b, 24); \
	a += b + ((LSB(a) * LSB(b)) << 1);  d ^= a;  d = rotr64(d, 16); \
	c += d + ((LSB(c) * LSB(d)) << 1);  b ^= c;  b = rotr64(b, 63)
#define ROUND(v0,  v1,  v2,  v3,  v4,  v5,  v6,  v7,	\
              v8,  v9, v10, v11, v12, v13, v14, v15)	\
	G(v0, v4,  v8, v12);  G(v1, v5,  v9, v13); \
	G(v2, v6, v10, v14);  G(v3, v7, v11, v15); \
	G(v0, v5, v10, v15);  G(v1, v6, v11, v12); \
	G(v2, v7,  v8, v13);  G(v3, v4,  v9, v14)

static void g_rounds(blk *b)
{

	for (int i = 0; i < 128; i += 16) {
		ROUND(b->a[i   ], b->a[i+ 1], b->a[i+ 2], b->a[i+ 3],
		      b->a[i+ 4], b->a[i+ 5], b->a[i+ 6], b->a[i+ 7],
		      b->a[i+ 8], b->a[i+ 9], b->a[i+10], b->a[i+11],
		      b->a[i+12], b->a[i+13], b->a[i+14], b->a[i+15]);
	}

	for (int i = 0; i < 16; i += 2) {
		ROUND(b->a[i   ], b->a[i+ 1], b->a[i+ 16], b->a[i+ 17],
		      b->a[i+32], b->a[i+33], b->a[i+ 48], b->a[i+ 49],
		      b->a[i+64], b->a[i+65], b->a[i+ 80], b->a[i+ 81],
		      b->a[i+96], b->a[i+97], b->a[i+112], b->a[i+113]);
	}
}

const crypto_argon2_extras crypto_argon2_no_extras = { 0, 0, 0, 0 };

void crypto_argon2(u8 *hash, u32 hash_size, void *work_area,
                   crypto_argon2_config config,
                   crypto_argon2_inputs inputs,
                   crypto_argon2_extras extras)
{
	const u32 segment_size = config.nb_blocks / config.nb_lanes / 4;
	const u32 lane_size    = segment_size * 4;
	const u32 nb_blocks    = lane_size * config.nb_lanes;

	blk *blocks = (blk*)work_area;
	{
		u8 initial_hash[72];
		crypto_blake2b_ctx ctx;
		crypto_blake2b_init (&ctx, 64);
		blake_update_32     (&ctx, config.nb_lanes );
		blake_update_32     (&ctx, hash_size);
		blake_update_32     (&ctx, config.nb_blocks);
		blake_update_32     (&ctx, config.nb_passes);
		blake_update_32     (&ctx, 0x13);
		blake_update_32     (&ctx, config.algorithm);
		blake_update_32_buf (&ctx, inputs.pass, inputs.pass_size);
		blake_update_32_buf (&ctx, inputs.salt, inputs.salt_size);
		blake_update_32_buf (&ctx, extras.key,  extras.key_size);
		blake_update_32_buf (&ctx, extras.ad,   extras.ad_size);
		crypto_blake2b_final(&ctx, initial_hash);

		u8 hash_area[1024];
		FOR_T(u32, l, 0, config.nb_lanes) {
			FOR_T(u32, i, 0, 2) {
				store32_le(initial_hash + 64, i);
				store32_le(initial_hash + 68, l);
				extended_hash(hash_area, 1024, initial_hash, 72);
				load64_le_buf(blocks[l * lane_size + i].a, hash_area, 128);
			}
		}

		WIPE_BUFFER(initial_hash);
		WIPE_BUFFER(hash_area);
	}

	int constant_time = config.algorithm != CRYPTO_ARGON2_D;

	blk tmp;
	FOR_T(u32, pass, 0, config.nb_passes) {
		FOR_T(u32, slice, 0, 4) {

			u32 pass_offset  = pass == 0 && slice == 0 ? 2 : 0;
			u32 slice_offset = slice * segment_size;

			if (slice == 2 && config.algorithm == CRYPTO_ARGON2_ID) {
				constant_time = 0;
			}

			FOR_T(u32, segment, 0, config.nb_lanes) {
				blk index_block;
				u32 index_ctr = 1;
				FOR_T (u32, block, pass_offset, segment_size) {

					u32  lane_offset   = segment * lane_size;
					blk *segment_start = blocks + lane_offset + slice_offset;
					blk *current       = segment_start + block;
					blk *previous      =
						block == 0 && slice_offset == 0
						? segment_start + lane_size - 1
						: segment_start + block - 1;

					u64 index_seed;
					if (constant_time) {
						if (block == pass_offset || (block % 128) == 0) {

							ZERO(index_block.a, 128);
							index_block.a[0] = pass;
							index_block.a[1] = segment;
							index_block.a[2] = slice;
							index_block.a[3] = nb_blocks;
							index_block.a[4] = config.nb_passes;
							index_block.a[5] = config.algorithm;
							index_block.a[6] = index_ctr;
							index_ctr++;

							copy_block(&tmp, &index_block);
							g_rounds  (&index_block);
							xor_block (&index_block, &tmp);
							copy_block(&tmp, &index_block);
							g_rounds  (&index_block);
							xor_block (&index_block, &tmp);
						}
						index_seed = index_block.a[block % 128];
					} else {
						index_seed = previous->a[0];
					}

					u32 next_slice   = ((slice + 1) % 4) * segment_size;
					u32 window_start = pass == 0 ? 0     : next_slice;
					u32 nb_segments  = pass == 0 ? slice : 3;
					u64 lane         =
						pass == 0 && slice == 0
						? segment
						: (index_seed >> 32) % config.nb_lanes;
					u32 window_size  =
						nb_segments * segment_size +
						(lane  == segment ? block-1 :
						 block == 0       ? (u32)-1 : 0);

					u64  j1        = index_seed & 0xffffffff;
					u64  x         = (j1 * j1)         >> 32;
					u64  y         = (window_size * x) >> 32;
					u64  z         = (window_size - 1) - y;
					u64  ref       = (window_start + z) % lane_size;
					u32  index     = lane * lane_size + (u32)ref;
					blk *reference = blocks + index;

					copy_block(&tmp, previous);
					xor_block (&tmp, reference);
					if (pass == 0) { copy_block(current, &tmp); }
					else           { xor_block (current, &tmp); }
					g_rounds  (&tmp);
					xor_block (current, &tmp);
				}
			}
		}
	}

	volatile u64* p = tmp.a;
	ZERO(p, 128);

	blk *last_block = blocks + lane_size - 1;
	FOR_T (u32, lane, 1, config.nb_lanes) {
		blk *next_block = last_block + lane_size;
		xor_block(next_block, last_block);
		last_block = next_block;
	}

	u8 final_block[1024];
	store64_le_buf(final_block, last_block->a, 128);

	p = (u64*)work_area;
	ZERO(p, 128 * nb_blocks);

	extended_hash(hash, hash_size, final_block, 1024);
	WIPE_BUFFER(final_block);
}

typedef i32 fe[10];

static const fe fe_one  = {1};
static const fe sqrtm1  = {
	-32595792, -7943725, 9377950, 3500415, 12389472,
	-272473, -25146209, -2005654, 326686, 11406482,
};
static const fe d       = {
	-10913610, 13857413, -15372611, 6949391, 114729,
	-8787816, -6275908, -3247719, -18696448, -12055116,
};
static const fe D2      = {
	-21827239, -5839606, -30745221, 13898782, 229458,
	15978800, -12551817, -6495438, 29715968, 9444199,
};
static const fe lop_x   = {
	21352778, 5345713, 4660180, -8347857, 24143090,
	14568123, 30185756, -12247770, -33528939, 8345319,
};
static const fe lop_y   = {
	-6952922, -1265500, 6862341, -7057498, -4037696,
	-5447722, 31680899, -15325402, -19365852, 1569102,
};
static const fe ufactor = {
	-1917299, 15887451, -18755900, -7000830, -24778944,
	544946, -16816446, 4011309, -653372, 10741468,
};
static const fe A2      = {
	12721188, 3529, 0, 0, 0, 0, 0, 0, 0, 0,
};

static void fe_0(fe h) {           ZERO(h  , 10); }
static void fe_1(fe h) { h[0] = 1; ZERO(h+1,  9); }

static void fe_copy(fe h,const fe f           ){FOR(i,0,10) h[i] =  f[i];      }
static void fe_neg (fe h,const fe f           ){FOR(i,0,10) h[i] = -f[i];      }
static void fe_add (fe h,const fe f,const fe g){FOR(i,0,10) h[i] = f[i] + g[i];}
static void fe_sub (fe h,const fe f,const fe g){FOR(i,0,10) h[i] = f[i] - g[i];}

static void fe_cswap(fe f, fe g, int b)
{
	i32 mask = -b;
	FOR (i, 0, 10) {
		i32 x = (f[i] ^ g[i]) & mask;
		f[i] = f[i] ^ x;
		g[i] = g[i] ^ x;
	}
}

static void fe_ccopy(fe f, const fe g, int b)
{
	i32 mask = -b;
	FOR (i, 0, 10) {
		i32 x = (f[i] ^ g[i]) & mask;
		f[i] = f[i] ^ x;
	}
}

#define FE_CARRY	\
	i64 c; \
	c = (t0 + ((i64)1<<25)) >> 26;  t0 -= c * ((i64)1 << 26);  t1 += c; \
	c = (t4 + ((i64)1<<25)) >> 26;  t4 -= c * ((i64)1 << 26);  t5 += c; \
	c = (t1 + ((i64)1<<24)) >> 25;  t1 -= c * ((i64)1 << 25);  t2 += c; \
	c = (t5 + ((i64)1<<24)) >> 25;  t5 -= c * ((i64)1 << 25);  t6 += c; \
	c = (t2 + ((i64)1<<25)) >> 26;  t2 -= c * ((i64)1 << 26);  t3 += c; \
	c = (t6 + ((i64)1<<25)) >> 26;  t6 -= c * ((i64)1 << 26);  t7 += c; \
	c = (t3 + ((i64)1<<24)) >> 25;  t3 -= c * ((i64)1 << 25);  t4 += c; \
	c = (t7 + ((i64)1<<24)) >> 25;  t7 -= c * ((i64)1 << 25);  t8 += c; \
	c = (t4 + ((i64)1<<25)) >> 26;  t4 -= c * ((i64)1 << 26);  t5 += c; \
	c = (t8 + ((i64)1<<25)) >> 26;  t8 -= c * ((i64)1 << 26);  t9 += c; \
	c = (t9 + ((i64)1<<24)) >> 25;  t9 -= c * ((i64)1 << 25);  t0 += c * 19; \
	c = (t0 + ((i64)1<<25)) >> 26;  t0 -= c * ((i64)1 << 26);  t1 += c; \
	h[0]=(i32)t0;  h[1]=(i32)t1;  h[2]=(i32)t2;  h[3]=(i32)t3;  h[4]=(i32)t4; \
	h[5]=(i32)t5;  h[6]=(i32)t6;  h[7]=(i32)t7;  h[8]=(i32)t8;  h[9]=(i32)t9

static void fe_frombytes_mask(fe h, const u8 s[32], unsigned nb_mask)
{
	u32 mask = 0xffffff >> nb_mask;
	i64 t0 =  load32_le(s);
	i64 t1 =  load24_le(s +  4) << 6;
	i64 t2 =  load24_le(s +  7) << 5;
	i64 t3 =  load24_le(s + 10) << 3;
	i64 t4 =  load24_le(s + 13) << 2;
	i64 t5 =  load32_le(s + 16);
	i64 t6 =  load24_le(s + 20) << 7;
	i64 t7 =  load24_le(s + 23) << 5;
	i64 t8 =  load24_le(s + 26) << 4;
	i64 t9 = (load24_le(s + 29) & mask) << 2;
	FE_CARRY;
}

static void fe_frombytes(fe h, const u8 s[32])
{
	fe_frombytes_mask(h, s, 1);
}

static void fe_tobytes(u8 s[32], const fe h)
{
	i32 t[10];
	COPY(t, h, 10);
	i32 q = (19 * t[9] + (((i32) 1) << 24)) >> 25;

	FOR (i, 0, 5) {
		q += t[2*i  ]; q >>= 26;
		q += t[2*i+1]; q >>= 25;
	}

	q *= 19;
	FOR (i, 0, 5) {
		t[i*2  ] += q;  q = t[i*2  ] >> 26;  t[i*2  ] -= q * ((i32)1 << 26);
		t[i*2+1] += q;  q = t[i*2+1] >> 25;  t[i*2+1] -= q * ((i32)1 << 25);
	}

	store32_le(s +  0, ((u32)t[0] >>  0) | ((u32)t[1] << 26));
	store32_le(s +  4, ((u32)t[1] >>  6) | ((u32)t[2] << 19));
	store32_le(s +  8, ((u32)t[2] >> 13) | ((u32)t[3] << 13));
	store32_le(s + 12, ((u32)t[3] >> 19) | ((u32)t[4] <<  6));
	store32_le(s + 16, ((u32)t[5] >>  0) | ((u32)t[6] << 25));
	store32_le(s + 20, ((u32)t[6] >>  7) | ((u32)t[7] << 19));
	store32_le(s + 24, ((u32)t[7] >> 13) | ((u32)t[8] << 12));
	store32_le(s + 28, ((u32)t[8] >> 20) | ((u32)t[9] <<  6));

	WIPE_BUFFER(t);
}

static void fe_mul_small(fe h, const fe f, i32 g)
{
	i64 t0 = f[0] * (i64) g;  i64 t1 = f[1] * (i64) g;
	i64 t2 = f[2] * (i64) g;  i64 t3 = f[3] * (i64) g;
	i64 t4 = f[4] * (i64) g;  i64 t5 = f[5] * (i64) g;
	i64 t6 = f[6] * (i64) g;  i64 t7 = f[7] * (i64) g;
	i64 t8 = f[8] * (i64) g;  i64 t9 = f[9] * (i64) g;

	FE_CARRY;
}

static void fe_mul(fe h, const fe f, const fe g)
{

	i32 f0 = f[0]; i32 f1 = f[1]; i32 f2 = f[2]; i32 f3 = f[3]; i32 f4 = f[4];
	i32 f5 = f[5]; i32 f6 = f[6]; i32 f7 = f[7]; i32 f8 = f[8]; i32 f9 = f[9];
	i32 g0 = g[0]; i32 g1 = g[1]; i32 g2 = g[2]; i32 g3 = g[3]; i32 g4 = g[4];
	i32 g5 = g[5]; i32 g6 = g[6]; i32 g7 = g[7]; i32 g8 = g[8]; i32 g9 = g[9];
	i32 F1 = f1*2; i32 F3 = f3*2; i32 F5 = f5*2; i32 F7 = f7*2; i32 F9 = f9*2;
	i32 G1 = g1*19;  i32 G2 = g2*19;  i32 G3 = g3*19;
	i32 G4 = g4*19;  i32 G5 = g5*19;  i32 G6 = g6*19;
	i32 G7 = g7*19;  i32 G8 = g8*19;  i32 G9 = g9*19;

	i64 t0 = f0*(i64)g0 + F1*(i64)G9 + f2*(i64)G8 + F3*(i64)G7 + f4*(i64)G6
	       + F5*(i64)G5 + f6*(i64)G4 + F7*(i64)G3 + f8*(i64)G2 + F9*(i64)G1;
	i64 t1 = f0*(i64)g1 + f1*(i64)g0 + f2*(i64)G9 + f3*(i64)G8 + f4*(i64)G7
	       + f5*(i64)G6 + f6*(i64)G5 + f7*(i64)G4 + f8*(i64)G3 + f9*(i64)G2;
	i64 t2 = f0*(i64)g2 + F1*(i64)g1 + f2*(i64)g0 + F3*(i64)G9 + f4*(i64)G8
	       + F5*(i64)G7 + f6*(i64)G6 + F7*(i64)G5 + f8*(i64)G4 + F9*(i64)G3;
	i64 t3 = f0*(i64)g3 + f1*(i64)g2 + f2*(i64)g1 + f3*(i64)g0 + f4*(i64)G9
	       + f5*(i64)G8 + f6*(i64)G7 + f7*(i64)G6 + f8*(i64)G5 + f9*(i64)G4;
	i64 t4 = f0*(i64)g4 + F1*(i64)g3 + f2*(i64)g2 + F3*(i64)g1 + f4*(i64)g0
	       + F5*(i64)G9 + f6*(i64)G8 + F7*(i64)G7 + f8*(i64)G6 + F9*(i64)G5;
	i64 t5 = f0*(i64)g5 + f1*(i64)g4 + f2*(i64)g3 + f3*(i64)g2 + f4*(i64)g1
	       + f5*(i64)g0 + f6*(i64)G9 + f7*(i64)G8 + f8*(i64)G7 + f9*(i64)G6;
	i64 t6 = f0*(i64)g6 + F1*(i64)g5 + f2*(i64)g4 + F3*(i64)g3 + f4*(i64)g2
	       + F5*(i64)g1 + f6*(i64)g0 + F7*(i64)G9 + f8*(i64)G8 + F9*(i64)G7;
	i64 t7 = f0*(i64)g7 + f1*(i64)g6 + f2*(i64)g5 + f3*(i64)g4 + f4*(i64)g3
	       + f5*(i64)g2 + f6*(i64)g1 + f7*(i64)g0 + f8*(i64)G9 + f9*(i64)G8;
	i64 t8 = f0*(i64)g8 + F1*(i64)g7 + f2*(i64)g6 + F3*(i64)g5 + f4*(i64)g4
	       + F5*(i64)g3 + f6*(i64)g2 + F7*(i64)g1 + f8*(i64)g0 + F9*(i64)G9;
	i64 t9 = f0*(i64)g9 + f1*(i64)g8 + f2*(i64)g7 + f3*(i64)g6 + f4*(i64)g5
	       + f5*(i64)g4 + f6*(i64)g3 + f7*(i64)g2 + f8*(i64)g1 + f9*(i64)g0;

	FE_CARRY;
}

static void fe_sq(fe h, const fe f)
{
	i32 f0 = f[0]; i32 f1 = f[1]; i32 f2 = f[2]; i32 f3 = f[3]; i32 f4 = f[4];
	i32 f5 = f[5]; i32 f6 = f[6]; i32 f7 = f[7]; i32 f8 = f[8]; i32 f9 = f[9];
	i32 f0_2  = f0*2;   i32 f1_2  = f1*2;   i32 f2_2  = f2*2;   i32 f3_2 = f3*2;
	i32 f4_2  = f4*2;   i32 f5_2  = f5*2;   i32 f6_2  = f6*2;   i32 f7_2 = f7*2;
	i32 f5_38 = f5*38;  i32 f6_19 = f6*19;  i32 f7_38 = f7*38;
	i32 f8_19 = f8*19;  i32 f9_38 = f9*38;

	i64 t0 = f0  *(i64)f0    + f1_2*(i64)f9_38 + f2_2*(i64)f8_19
	       + f3_2*(i64)f7_38 + f4_2*(i64)f6_19 + f5  *(i64)f5_38;
	i64 t1 = f0_2*(i64)f1    + f2  *(i64)f9_38 + f3_2*(i64)f8_19
	       + f4  *(i64)f7_38 + f5_2*(i64)f6_19;
	i64 t2 = f0_2*(i64)f2    + f1_2*(i64)f1    + f3_2*(i64)f9_38
	       + f4_2*(i64)f8_19 + f5_2*(i64)f7_38 + f6  *(i64)f6_19;
	i64 t3 = f0_2*(i64)f3    + f1_2*(i64)f2    + f4  *(i64)f9_38
	       + f5_2*(i64)f8_19 + f6  *(i64)f7_38;
	i64 t4 = f0_2*(i64)f4    + f1_2*(i64)f3_2  + f2  *(i64)f2
	       + f5_2*(i64)f9_38 + f6_2*(i64)f8_19 + f7  *(i64)f7_38;
	i64 t5 = f0_2*(i64)f5    + f1_2*(i64)f4    + f2_2*(i64)f3
	       + f6  *(i64)f9_38 + f7_2*(i64)f8_19;
	i64 t6 = f0_2*(i64)f6    + f1_2*(i64)f5_2  + f2_2*(i64)f4
	       + f3_2*(i64)f3    + f7_2*(i64)f9_38 + f8  *(i64)f8_19;
	i64 t7 = f0_2*(i64)f7    + f1_2*(i64)f6    + f2_2*(i64)f5
	       + f3_2*(i64)f4    + f8  *(i64)f9_38;
	i64 t8 = f0_2*(i64)f8    + f1_2*(i64)f7_2  + f2_2*(i64)f6
	       + f3_2*(i64)f5_2  + f4  *(i64)f4    + f9  *(i64)f9_38;
	i64 t9 = f0_2*(i64)f9    + f1_2*(i64)f8    + f2_2*(i64)f7
	       + f3_2*(i64)f6    + f4  *(i64)f5_2;

	FE_CARRY;
}

static int fe_isodd(const fe f)
{
	u8 s[32];
	fe_tobytes(s, f);
	u8 isodd = s[0] & 1;
	WIPE_BUFFER(s);
	return isodd;
}

static int fe_isequal(const fe f, const fe g)
{
	u8 fs[32];
	u8 gs[32];
	fe_tobytes(fs, f);
	fe_tobytes(gs, g);
	int isdifferent = crypto_verify32(fs, gs);
	WIPE_BUFFER(fs);
	WIPE_BUFFER(gs);
	return 1 + isdifferent;
}

static int invsqrt(fe isr, const fe x)
{
	fe t0, t1, t2;

	fe_sq(t0, x);
	fe_sq(t1,t0);                     fe_sq(t1, t1);    fe_mul(t1, x, t1);
	fe_mul(t0, t0, t1);
	fe_sq(t0, t0);                                      fe_mul(t0, t1, t0);
	fe_sq(t1, t0);  FOR (i, 1,   5) { fe_sq(t1, t1); }  fe_mul(t0, t1, t0);
	fe_sq(t1, t0);  FOR (i, 1,  10) { fe_sq(t1, t1); }  fe_mul(t1, t1, t0);
	fe_sq(t2, t1);  FOR (i, 1,  20) { fe_sq(t2, t2); }  fe_mul(t1, t2, t1);
	fe_sq(t1, t1);  FOR (i, 1,  10) { fe_sq(t1, t1); }  fe_mul(t0, t1, t0);
	fe_sq(t1, t0);  FOR (i, 1,  50) { fe_sq(t1, t1); }  fe_mul(t1, t1, t0);
	fe_sq(t2, t1);  FOR (i, 1, 100) { fe_sq(t2, t2); }  fe_mul(t1, t2, t1);
	fe_sq(t1, t1);  FOR (i, 1,  50) { fe_sq(t1, t1); }  fe_mul(t0, t1, t0);
	fe_sq(t0, t0);  FOR (i, 1,   2) { fe_sq(t0, t0); }  fe_mul(t0, t0, x);

	i32 *quartic = t1;
	fe_sq (quartic, t0);
	fe_mul(quartic, quartic, x);

	i32 *check = t2;
	fe_0  (check);          int z0 = fe_isequal(x      , check);
	fe_1  (check);          int p1 = fe_isequal(quartic, check);
	fe_neg(check, check );  int m1 = fe_isequal(quartic, check);
	fe_neg(check, sqrtm1);  int ms = fe_isequal(quartic, check);

	fe_mul(isr, t0, sqrtm1);
	fe_ccopy(isr, t0, 1 - (m1 | ms));

	WIPE_BUFFER(t0);
	WIPE_BUFFER(t1);
	WIPE_BUFFER(t2);
	return p1 | m1 | z0;
}

static void fe_invert(fe out, const fe x)
{
	fe tmp;
	fe_sq(tmp, x);
	invsqrt(tmp, tmp);
	fe_sq(tmp, tmp);
	fe_mul(out, tmp, x);
	WIPE_BUFFER(tmp);
}

void crypto_eddsa_trim_scalar(u8 out[32], const u8 in[32])
{
	COPY(out, in, 32);
	out[ 0] &= 248;
	out[31] &= 127;
	out[31] |= 64;
}

static int scalar_bit(const u8 s[32], int i)
{
	if (i < 0) { return 0; }
	return (s[i>>3] >> (i&7)) & 1;
}

static void scalarmult(u8 q[32], const u8 scalar[32], const u8 p[32],
                       int nb_bits)
{

	fe x1;
	fe_frombytes(x1, p);

	fe x2, z2, x3, z3, t0, t1;

	fe_1(x2);        fe_0(z2);
	fe_copy(x3, x1); fe_1(z3);
	int swap = 0;
	for (int pos = nb_bits-1; pos >= 0; --pos) {

		int b = scalar_bit(scalar, pos);
		swap ^= b;
		fe_cswap(x2, x3, swap);
		fe_cswap(z2, z3, swap);
		swap = b;

		fe_sub(t0, x3, z3);
		fe_sub(t1, x2, z2);
		fe_add(x2, x2, z2);
		fe_add(z2, x3, z3);
		fe_mul(z3, t0, x2);
		fe_mul(z2, z2, t1);
		fe_sq (t0, t1    );
		fe_sq (t1, x2    );
		fe_add(x3, z3, z2);
		fe_sub(z2, z3, z2);
		fe_mul(x2, t1, t0);
		fe_sub(t1, t1, t0);
		fe_sq (z2, z2    );
		fe_mul_small(z3, t1, 121666);
		fe_sq (x3, x3    );
		fe_add(t0, t0, z3);
		fe_mul(z3, x1, z2);
		fe_mul(z2, t1, t0);
	}

	fe_cswap(x2, x3, swap);
	fe_cswap(z2, z3, swap);

	fe_invert(z2, z2);
	fe_mul(x2, x2, z2);
	fe_tobytes(q, x2);

	WIPE_BUFFER(x1);
	WIPE_BUFFER(x2);  WIPE_BUFFER(z2);  WIPE_BUFFER(t0);
	WIPE_BUFFER(x3);  WIPE_BUFFER(z3);  WIPE_BUFFER(t1);
}

void crypto_x25519(u8       raw_shared_secret[32],
                   const u8 your_secret_key  [32],
                   const u8 their_public_key [32])
{

	u8 e[32];
	crypto_eddsa_trim_scalar(e, your_secret_key);
	scalarmult(raw_shared_secret, e, their_public_key, 255);
	WIPE_BUFFER(e);
}

void crypto_x25519_public_key(u8       public_key[32],
                              const u8 secret_key[32])
{
	static const u8 base_point[32] = {9};
	crypto_x25519(public_key, secret_key, base_point);
}

static const u32 L[8] = {
	0x5cf5d3ed, 0x5812631a, 0xa2f79cd6, 0x14def9de,
	0x00000000, 0x00000000, 0x00000000, 0x10000000,
};

static void multiply(u32 p[16], const u32 a[8], const u32 b[8])
{
	FOR (i, 0, 8) {
		u64 carry = 0;
		FOR (j, 0, 8) {
			carry  += p[i+j] + (u64)a[i] * b[j];
			p[i+j]  = (u32)carry;
			carry >>= 32;
		}
		p[i+8] = (u32)carry;
	}
}

static int is_above_l(const u32 x[8])
{

	u64 carry = 1;
	FOR (i, 0, 8) {
		carry  += (u64)x[i] + (~L[i] & 0xffffffff);
		carry >>= 32;
	}
	return (int)carry;
}

static void remove_l(u32 r[8], const u32 x[8])
{
	u64 carry = (u64)is_above_l(x);
	u32 mask  = ~(u32)carry + 1;
	FOR (i, 0, 8) {
		carry += (u64)x[i] + (~L[i] & mask);
		r[i]   = (u32)carry;
		carry >>= 32;
	}
}

static void mod_l(u8 reduced[32], const u32 x[16])
{
	static const u32 r[9] = {
		0x0a2c131b,0xed9ce5a3,0x086329a7,0x2106215d,
		0xffffffeb,0xffffffff,0xffffffff,0xffffffff,0xf,
	};

	u32 xr[25] = {0};
	FOR (i, 0, 9) {
		u64 carry = 0;
		FOR (j, 0, 16) {
			carry  += xr[i+j] + (u64)r[i] * x[j];
			xr[i+j] = (u32)carry;
			carry >>= 32;
		}
		xr[i+16] = (u32)carry;
	}

	ZERO(xr, 8);
	FOR (i, 0, 8) {
		u64 carry = 0;
		FOR (j, 0, 8-i) {
			carry   += xr[i+j] + (u64)xr[i+16] * L[j];
			xr[i+j] = (u32)carry;
			carry >>= 32;
		}
	}

	u64 carry = 1;
	FOR (i, 0, 8) {
		carry  += (u64)x[i] + (~xr[i] & 0xffffffff);
		xr[i]   = (u32)carry;
		carry >>= 32;
	}

	remove_l(xr, xr);
	store32_le_buf(reduced, xr, 8);

	WIPE_BUFFER(xr);
}

void crypto_eddsa_reduce(u8 reduced[32], const u8 expanded[64])
{
	u32 x[16];
	load32_le_buf(x, expanded, 16);
	mod_l(reduced, x);
	WIPE_BUFFER(x);
}

void crypto_eddsa_mul_add(u8 r[32],
                          const u8 a[32], const u8 b[32], const u8 c[32])
{
	u32 A[8];  load32_le_buf(A, a, 8);
	u32 B[8];  load32_le_buf(B, b, 8);
	u32 p[16]; load32_le_buf(p, c, 8);  ZERO(p + 8, 8);
	multiply(p, A, B);
	mod_l(r, p);
	WIPE_BUFFER(p);
	WIPE_BUFFER(A);
	WIPE_BUFFER(B);
}

typedef struct { fe X;  fe Y;  fe Z; fe T;  } ge;
typedef struct { fe Yp; fe Ym; fe Z; fe T2; } ge_cached;
typedef struct { fe Yp; fe Ym;       fe T2; } ge_precomp;

static void ge_zero(ge *p)
{
	fe_0(p->X);
	fe_1(p->Y);
	fe_1(p->Z);
	fe_0(p->T);
}

static void ge_tobytes(u8 s[32], const ge *h)
{
	fe recip, x, y;
	fe_invert(recip, h->Z);
	fe_mul(x, h->X, recip);
	fe_mul(y, h->Y, recip);
	fe_tobytes(s, y);
	s[31] ^= fe_isodd(x) << 7;

	WIPE_BUFFER(recip);
	WIPE_BUFFER(x);
	WIPE_BUFFER(y);
}

static int ge_frombytes_neg_vartime(ge *h, const u8 s[32])
{
	fe_frombytes(h->Y, s);
	fe_1(h->Z);
	fe_sq (h->T, h->Y);
	fe_mul(h->X, h->T, d   );
	fe_sub(h->T, h->T, h->Z);
	fe_add(h->X, h->X, h->Z);
	fe_mul(h->X, h->T, h->X);
	int is_square = invsqrt(h->X, h->X);
	if (!is_square) {
		return -1;
	}
	fe_mul(h->X, h->T, h->X);
	if (fe_isodd(h->X) == (s[31] >> 7)) {
		fe_neg(h->X, h->X);
	}
	fe_mul(h->T, h->X, h->Y);
	return 0;
}

static void ge_cache(ge_cached *c, const ge *p)
{
	fe_add (c->Yp, p->Y, p->X);
	fe_sub (c->Ym, p->Y, p->X);
	fe_copy(c->Z , p->Z      );
	fe_mul (c->T2, p->T, D2  );
}

static void ge_add(ge *s, const ge *p, const ge_cached *q)
{
	fe a, b;
	fe_add(a   , p->Y, p->X );
	fe_sub(b   , p->Y, p->X );
	fe_mul(a   , a   , q->Yp);
	fe_mul(b   , b   , q->Ym);
	fe_add(s->Y, a   , b    );
	fe_sub(s->X, a   , b    );

	fe_add(s->Z, p->Z, p->Z );
	fe_mul(s->Z, s->Z, q->Z );
	fe_mul(s->T, p->T, q->T2);
	fe_add(a   , s->Z, s->T );
	fe_sub(b   , s->Z, s->T );

	fe_mul(s->T, s->X, s->Y);
	fe_mul(s->X, s->X, b   );
	fe_mul(s->Y, s->Y, a   );
	fe_mul(s->Z, a   , b   );
}

static void ge_sub(ge *s, const ge *p, const ge_cached *q)
{
	ge_cached neg;
	fe_copy(neg.Ym, q->Yp);
	fe_copy(neg.Yp, q->Ym);
	fe_copy(neg.Z , q->Z );
	fe_neg (neg.T2, q->T2);
	ge_add(s, p, &neg);
}

static void ge_madd(ge *s, const ge *p, const ge_precomp *q, fe a, fe b)
{
	fe_add(a   , p->Y, p->X );
	fe_sub(b   , p->Y, p->X );
	fe_mul(a   , a   , q->Yp);
	fe_mul(b   , b   , q->Ym);
	fe_add(s->Y, a   , b    );
	fe_sub(s->X, a   , b    );

	fe_add(s->Z, p->Z, p->Z );
	fe_mul(s->T, p->T, q->T2);
	fe_add(a   , s->Z, s->T );
	fe_sub(b   , s->Z, s->T );

	fe_mul(s->T, s->X, s->Y);
	fe_mul(s->X, s->X, b   );
	fe_mul(s->Y, s->Y, a   );
	fe_mul(s->Z, a   , b   );
}

static void ge_msub(ge *s, const ge *p, const ge_precomp *q, fe a, fe b)
{
	ge_precomp neg;
	fe_copy(neg.Ym, q->Yp);
	fe_copy(neg.Yp, q->Ym);
	fe_neg (neg.T2, q->T2);
	ge_madd(s, p, &neg, a, b);
}

static void ge_double(ge *s, const ge *p, ge *q)
{
	fe_sq (q->X, p->X);
	fe_sq (q->Y, p->Y);
	fe_sq (q->Z, p->Z);
	fe_mul_small(q->Z, q->Z, 2);
	fe_add(q->T, p->X, p->Y);
	fe_sq (s->T, q->T);
	fe_add(q->T, q->Y, q->X);
	fe_sub(q->Y, q->Y, q->X);
	fe_sub(q->X, s->T, q->T);
	fe_sub(q->Z, q->Z, q->Y);

	fe_mul(s->X, q->X , q->Z);
	fe_mul(s->Y, q->T , q->Y);
	fe_mul(s->Z, q->Y , q->Z);
	fe_mul(s->T, q->X , q->T);
}

static const ge_precomp b_window[8] = {
	{{25967493,-14356035,29566456,3660896,-12694345,
	  4014787,27544626,-11754271,-6079156,2047605,},
	 {-12545711,934262,-2722910,3049990,-727428,
	  9406986,12720692,5043384,19500929,-15469378,},
	 {-8738181,4489570,9688441,-14785194,10184609,
	  -12363380,29287919,11864899,-24514362,-4438546,},},
	{{15636291,-9688557,24204773,-7912398,616977,
	  -16685262,27787600,-14772189,28944400,-1550024,},
	 {16568933,4717097,-11556148,-1102322,15682896,
	  -11807043,16354577,-11775962,7689662,11199574,},
	 {30464156,-5976125,-11779434,-15670865,23220365,
	  15915852,7512774,10017326,-17749093,-9920357,},},
	{{10861363,11473154,27284546,1981175,-30064349,
	  12577861,32867885,14515107,-15438304,10819380,},
	 {4708026,6336745,20377586,9066809,-11272109,
	  6594696,-25653668,12483688,-12668491,5581306,},
	 {19563160,16186464,-29386857,4097519,10237984,
	  -4348115,28542350,13850243,-23678021,-15815942,},},
	{{5153746,9909285,1723747,-2777874,30523605,
	  5516873,19480852,5230134,-23952439,-15175766,},
	 {-30269007,-3463509,7665486,10083793,28475525,
	  1649722,20654025,16520125,30598449,7715701,},
	 {28881845,14381568,9657904,3680757,-20181635,
	  7843316,-31400660,1370708,29794553,-1409300,},},
	{{-22518993,-6692182,14201702,-8745502,-23510406,
	  8844726,18474211,-1361450,-13062696,13821877,},
	 {-6455177,-7839871,3374702,-4740862,-27098617,
	  -10571707,31655028,-7212327,18853322,-14220951,},
	 {4566830,-12963868,-28974889,-12240689,-7602672,
	  -2830569,-8514358,-10431137,2207753,-3209784,},},
	{{-25154831,-4185821,29681144,7868801,-6854661,
	  -9423865,-12437364,-663000,-31111463,-16132436,},
	 {25576264,-2703214,7349804,-11814844,16472782,
	  9300885,3844789,15725684,171356,6466918,},
	 {23103977,13316479,9739013,-16149481,817875,
	  -15038942,8965339,-14088058,-30714912,16193877,},},
	{{-33521811,3180713,-2394130,14003687,-16903474,
	  -16270840,17238398,4729455,-18074513,9256800,},
	 {-25182317,-4174131,32336398,5036987,-21236817,
	  11360617,22616405,9761698,-19827198,630305,},
	 {-13720693,2639453,-24237460,-7406481,9494427,
	  -5774029,-6554551,-15960994,-2449256,-14291300,},},
	{{-3151181,-5046075,9282714,6866145,-31907062,
	  -863023,-18940575,15033784,25105118,-7894876,},
	 {-24326370,15950226,-31801215,-14592823,-11662737,
	  -5090925,1573892,-2625887,2198790,-15804619,},
	 {-3099351,10324967,-2241613,7453183,-5446979,
	  -2735503,-13812022,-16236442,-32461234,-12290683,},},
};

typedef struct {
	i16 next_index;
	i8  next_digit;
	u8  next_check;
} slide_ctx;

static void slide_init(slide_ctx *ctx, const u8 scalar[32])
{

	int i = 252;
	while (i > 0 && scalar_bit(scalar, i) == 0) {
		i--;
	}
	ctx->next_check = (u8)(i + 1);
	ctx->next_index = -1;
	ctx->next_digit = -1;
}

static int slide_step(slide_ctx *ctx, int width, int i, const u8 scalar[32])
{
	if (i == ctx->next_check) {
		if (scalar_bit(scalar, i) == scalar_bit(scalar, i - 1)) {
			ctx->next_check--;
		} else {

			int w = MIN(width, i + 1);
			int v = -(scalar_bit(scalar, i) << (w-1));
			FOR_T (int, j, 0, w-1) {
				v += scalar_bit(scalar, i-(w-1)+j) << j;
			}
			v += scalar_bit(scalar, i-w);
			int lsb = v & (~v + 1);
			int s   =
				(((lsb & 0xAA) != 0) << 0) |
				(((lsb & 0xCC) != 0) << 1) |
				(((lsb & 0xF0) != 0) << 2);
			ctx->next_index  = (i16)(i-(w-1)+s);
			ctx->next_digit  = (i8) (v >> s   );
			ctx->next_check -= (u8) w;
		}
	}
	return i == ctx->next_index ? ctx->next_digit: 0;
}

#define P_W_WIDTH 3
#define B_W_WIDTH 5
#define P_W_SIZE  (1<<(P_W_WIDTH-2))

int crypto_eddsa_check_equation(const u8 signature[64], const u8 public_key[32],
                                const u8 h[32])
{
	ge minus_A;
	ge minus_R;
	const u8 *s = signature + 32;

	{
		u32 s32[8];
		load32_le_buf(s32, s, 8);
		if (ge_frombytes_neg_vartime(&minus_A, public_key) ||
		    ge_frombytes_neg_vartime(&minus_R, signature)  ||
		    is_above_l(s32)) {
			return -1;
		}
	}

	ge_cached lutA[P_W_SIZE];
	{
		ge minus_A2, tmp;
		ge_double(&minus_A2, &minus_A, &tmp);
		ge_cache(&lutA[0], &minus_A);
		FOR (i, 1, P_W_SIZE) {
			ge_add(&tmp, &minus_A2, &lutA[i-1]);
			ge_cache(&lutA[i], &tmp);
		}
	}

	slide_ctx h_slide;  slide_init(&h_slide, h);
	slide_ctx s_slide;  slide_init(&s_slide, s);
	int i = MAX(h_slide.next_check, s_slide.next_check);
	ge *sum = &minus_A;
	ge_zero(sum);
	while (i >= 0) {
		ge tmp;
		ge_double(sum, sum, &tmp);
		int h_digit = slide_step(&h_slide, P_W_WIDTH, i, h);
		int s_digit = slide_step(&s_slide, B_W_WIDTH, i, s);
		if (h_digit > 0) { ge_add(sum, sum, &lutA[ h_digit / 2]); }
		if (h_digit < 0) { ge_sub(sum, sum, &lutA[-h_digit / 2]); }
		fe t1, t2;
		if (s_digit > 0) { ge_madd(sum, sum, b_window +  s_digit/2, t1, t2); }
		if (s_digit < 0) { ge_msub(sum, sum, b_window + -s_digit/2, t1, t2); }
		i--;
	}

	ge_cached cached;
	u8 check[32];
	static const u8 zero_point[32] = {1};
	ge_cache(&cached, &minus_R);
	ge_add(sum, sum, &cached);
	ge_double(sum, sum, &minus_R);
	ge_double(sum, sum, &minus_R);
	ge_double(sum, sum, &minus_R);
	ge_tobytes(check, sum);
	return crypto_verify32(check, zero_point);
}

static const ge_precomp b_comb_low[8] = {
	{{-6816601,-2324159,-22559413,124364,18015490,
	  8373481,19993724,1979872,-18549925,9085059,},
	 {10306321,403248,14839893,9633706,8463310,
	  -8354981,-14305673,14668847,26301366,2818560,},
	 {-22701500,-3210264,-13831292,-2927732,-16326337,
	  -14016360,12940910,177905,12165515,-2397893,},},
	{{-12282262,-7022066,9920413,-3064358,-32147467,
	  2927790,22392436,-14852487,2719975,16402117,},
	 {-7236961,-4729776,2685954,-6525055,-24242706,
	  -15940211,-6238521,14082855,10047669,12228189,},
	 {-30495588,-12893761,-11161261,3539405,-11502464,
	  16491580,-27286798,-15030530,-7272871,-15934455,},},
	{{17650926,582297,-860412,-187745,-12072900,
	  -10683391,-20352381,15557840,-31072141,-5019061,},
	 {-6283632,-2259834,-4674247,-4598977,-4089240,
	  12435688,-31278303,1060251,6256175,10480726,},
	 {-13871026,2026300,-21928428,-2741605,-2406664,
	  -8034988,7355518,15733500,-23379862,7489131,},},
	{{6883359,695140,23196907,9644202,-33430614,
	  11354760,-20134606,6388313,-8263585,-8491918,},
	 {-7716174,-13605463,-13646110,14757414,-19430591,
	  -14967316,10359532,-11059670,-21935259,12082603,},
	 {-11253345,-15943946,10046784,5414629,24840771,
	  8086951,-6694742,9868723,15842692,-16224787,},},
	{{9639399,11810955,-24007778,-9320054,3912937,
	  -9856959,996125,-8727907,-8919186,-14097242,},
	 {7248867,14468564,25228636,-8795035,14346339,
	  8224790,6388427,-7181107,6468218,-8720783,},
	 {15513115,15439095,7342322,-10157390,18005294,
	  -7265713,2186239,4884640,10826567,7135781,},},
	{{-14204238,5297536,-5862318,-6004934,28095835,
	  4236101,-14203318,1958636,-16816875,3837147,},
	 {-5511166,-13176782,-29588215,12339465,15325758,
	  -15945770,-8813185,11075932,-19608050,-3776283,},
	 {11728032,9603156,-4637821,-5304487,-7827751,
	  2724948,31236191,-16760175,-7268616,14799772,},},
	{{-28842672,4840636,-12047946,-9101456,-1445464,
	  381905,-30977094,-16523389,1290540,12798615,},
	 {27246947,-10320914,14792098,-14518944,5302070,
	  -8746152,-3403974,-4149637,-27061213,10749585,},
	 {25572375,-6270368,-15353037,16037944,1146292,
	  32198,23487090,9585613,24714571,-1418265,},},
	{{19844825,282124,-17583147,11004019,-32004269,
	  -2716035,6105106,-1711007,-21010044,14338445,},
	 {8027505,8191102,-18504907,-12335737,25173494,
	  -5923905,15446145,7483684,-30440441,10009108,},
	 {-14134701,-4174411,10246585,-14677495,33553567,
	  -14012935,23366126,15080531,-7969992,7663473,},},
};

static const ge_precomp b_comb_high[8] = {
	{{33055887,-4431773,-521787,6654165,951411,
	  -6266464,-5158124,6995613,-5397442,-6985227,},
	 {4014062,6967095,-11977872,3960002,8001989,
	  5130302,-2154812,-1899602,-31954493,-16173976,},
	 {16271757,-9212948,23792794,731486,-25808309,
	  -3546396,6964344,-4767590,10976593,10050757,},},
	{{2533007,-4288439,-24467768,-12387405,-13450051,
	  14542280,12876301,13893535,15067764,8594792,},
	 {20073501,-11623621,3165391,-13119866,13188608,
	  -11540496,-10751437,-13482671,29588810,2197295,},
	 {-1084082,11831693,6031797,14062724,14748428,
	  -8159962,-20721760,11742548,31368706,13161200,},},
	{{2050412,-6457589,15321215,5273360,25484180,
	  124590,-18187548,-7097255,-6691621,-14604792,},
	 {9938196,2162889,-6158074,-1711248,4278932,
	  -2598531,-22865792,-7168500,-24323168,11746309,},
	 {-22691768,-14268164,5965485,9383325,20443693,
	  5854192,28250679,-1381811,-10837134,13717818,},},
	{{-8495530,16382250,9548884,-4971523,-4491811,
	  -3902147,6182256,-12832479,26628081,10395408,},
	 {27329048,-15853735,7715764,8717446,-9215518,
	  -14633480,28982250,-5668414,4227628,242148,},
	 {-13279943,-7986904,-7100016,8764468,-27276630,
	  3096719,29678419,-9141299,3906709,11265498,},},
	{{11918285,15686328,-17757323,-11217300,-27548967,
	  4853165,-27168827,6807359,6871949,-1075745,},
	 {-29002610,13984323,-27111812,-2713442,28107359,
	  -13266203,6155126,15104658,3538727,-7513788,},
	 {14103158,11233913,-33165269,9279850,31014152,
	  4335090,-1827936,4590951,13960841,12787712,},},
	{{1469134,-16738009,33411928,13942824,8092558,
	  -8778224,-11165065,1437842,22521552,-2792954,},
	 {31352705,-4807352,-25327300,3962447,12541566,
	  -9399651,-27425693,7964818,-23829869,5541287,},
	 {-25732021,-6864887,23848984,3039395,-9147354,
	  6022816,-27421653,10590137,25309915,-1584678,},},
	{{-22951376,5048948,31139401,-190316,-19542447,
	  -626310,-17486305,-16511925,-18851313,-12985140,},
	 {-9684890,14681754,30487568,7717771,-10829709,
	  9630497,30290549,-10531496,-27798994,-13812825,},
	 {5827835,16097107,-24501327,12094619,7413972,
	  11447087,28057551,-1793987,-14056981,4359312,},},
	{{26323183,2342588,-21887793,-1623758,-6062284,
	  2107090,-28724907,9036464,-19618351,-13055189,},
	 {-29697200,14829398,-4596333,14220089,-30022969,
	  2955645,12094100,-13693652,-5941445,7047569,},
	 {-3201977,14413268,-12058324,-16417589,-9035655,
	  -7224648,9258160,1399236,30397584,-5684634,},},
};

static void lookup_add(ge *p, ge_precomp *tmp_c, fe tmp_a, fe tmp_b,
                       const ge_precomp comb[8], const u8 scalar[32], int i)
{
	u8 teeth = (u8)((scalar_bit(scalar, i)          ) +
	                (scalar_bit(scalar, i + 32) << 1) +
	                (scalar_bit(scalar, i + 64) << 2) +
	                (scalar_bit(scalar, i + 96) << 3));
	u8 high  = teeth >> 3;
	u8 index = (teeth ^ (high - 1)) & 7;
	FOR (j, 0, 8) {
		i32 select = 1 & (((j ^ index) - 1) >> 8);
		fe_ccopy(tmp_c->Yp, comb[j].Yp, select);
		fe_ccopy(tmp_c->Ym, comb[j].Ym, select);
		fe_ccopy(tmp_c->T2, comb[j].T2, select);
	}
	fe_neg(tmp_a, tmp_c->T2);
	fe_cswap(tmp_c->T2, tmp_a    , high ^ 1);
	fe_cswap(tmp_c->Yp, tmp_c->Ym, high ^ 1);
	ge_madd(p, p, tmp_c, tmp_a, tmp_b);
}

static void ge_scalarmult_base(ge *p, const u8 scalar[32])
{

	static const u8 half_mod_L[32] = {
		247,233,122,46,141,49,9,44,107,206,123,81,239,124,111,10,
		0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,8,
	};

	static const u8 half_ones[32] = {
		142,74,204,70,186,24,118,107,184,231,190,57,250,173,119,99,
		255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,7,
	};

	u8 s_scalar[32];
	crypto_eddsa_mul_add(s_scalar, scalar, half_mod_L, half_ones);

	fe tmp_a, tmp_b;
	ge_precomp tmp_c;
	ge tmp_d;
	fe_1(tmp_c.Yp);
	fe_1(tmp_c.Ym);
	fe_0(tmp_c.T2);

	ge_zero(p);
	lookup_add(p, &tmp_c, tmp_a, tmp_b, b_comb_low , s_scalar, 31);
	lookup_add(p, &tmp_c, tmp_a, tmp_b, b_comb_high, s_scalar, 31+128);

	for (int i = 30; i >= 0; i--) {
		ge_double(p, p, &tmp_d);
		lookup_add(p, &tmp_c, tmp_a, tmp_b, b_comb_low , s_scalar, i);
		lookup_add(p, &tmp_c, tmp_a, tmp_b, b_comb_high, s_scalar, i+128);
	}

	WIPE_BUFFER(tmp_a);  WIPE_CTX(&tmp_d);
	WIPE_BUFFER(tmp_b);  WIPE_CTX(&tmp_c);
	WIPE_BUFFER(s_scalar);
}

void crypto_eddsa_scalarbase(u8 point[32], const u8 scalar[32])
{
	ge P;
	ge_scalarmult_base(&P, scalar);
	ge_tobytes(point, &P);
	WIPE_CTX(&P);
}

void crypto_eddsa_key_pair(u8 secret_key[64], u8 public_key[32], u8 seed[32])
{

	u8 a[64];
	COPY(a, seed, 32);
	crypto_wipe(seed, 32);
	COPY(secret_key, a, 32);
	crypto_blake2b(a, 64, a, 32);
	crypto_eddsa_trim_scalar(a, a);
	crypto_eddsa_scalarbase(secret_key + 32, a);
	COPY(public_key, secret_key + 32, 32);
	WIPE_BUFFER(a);
}

static void hash_reduce(u8 h[32],
                        const u8 *a, size_t a_size,
                        const u8 *b, size_t b_size,
                        const u8 *c, size_t c_size)
{
	u8 hash[64];
	crypto_blake2b_ctx ctx;
	crypto_blake2b_init  (&ctx, 64);
	crypto_blake2b_update(&ctx, a, a_size);
	crypto_blake2b_update(&ctx, b, b_size);
	crypto_blake2b_update(&ctx, c, c_size);
	crypto_blake2b_final (&ctx, hash);
	crypto_eddsa_reduce(h, hash);
}

void crypto_eddsa_sign(u8 signature [64], const u8 secret_key[64],
                       const u8 *message, size_t message_size)
{
	u8 a[64];
	u8 r[32];
	u8 h[32];
	u8 R[32];

	crypto_blake2b(a, 64, secret_key, 32);
	crypto_eddsa_trim_scalar(a, a);
	hash_reduce(r, a + 32, 32, message, message_size, 0, 0);
	crypto_eddsa_scalarbase(R, r);
	hash_reduce(h, R, 32, secret_key + 32, 32, message, message_size);
	COPY(signature, R, 32);
	crypto_eddsa_mul_add(signature + 32, h, a, r);

	WIPE_BUFFER(a);
	WIPE_BUFFER(r);
}

int crypto_eddsa_check(const u8  signature[64], const u8 public_key[32],
                       const u8 *message, size_t message_size)
{
	u8 h[32];
	hash_reduce(h, signature, 32, public_key, 32, message, message_size);
	return crypto_eddsa_check_equation(signature, public_key, h);
}

void crypto_eddsa_to_x25519(u8 x25519[32], const u8 eddsa[32])
{

	fe t1, t2;
	fe_frombytes(t2, eddsa);
	fe_add(t1, fe_one, t2);
	fe_sub(t2, fe_one, t2);
	fe_invert(t2, t2);
	fe_mul(t1, t1, t2);
	fe_tobytes(x25519, t1);
	WIPE_BUFFER(t1);
	WIPE_BUFFER(t2);
}

void crypto_x25519_to_eddsa(u8 eddsa[32], const u8 x25519[32])
{

	fe t1, t2;
	fe_frombytes(t2, x25519);
	fe_sub(t1, t2, fe_one);
	fe_add(t2, t2, fe_one);
	fe_invert(t2, t2);
	fe_mul(t1, t1, t2);
	fe_tobytes(eddsa, t1);
	WIPE_BUFFER(t1);
	WIPE_BUFFER(t2);
}

static void add_xl(u8 s[32], u8 x)
{
	u64 mod8  = x & 7;
	u64 carry = 0;
	FOR (i , 0, 8) {
		carry = carry + load32_le(s + 4*i) + L[i] * mod8;
		store32_le(s + 4*i, (u32)carry);
		carry >>= 32;
	}
}

void crypto_x25519_dirty_small(u8 public_key[32], const u8 secret_key[32])
{

	static const u8 dirty_base_point[32] = {
		0xd8, 0x86, 0x1a, 0xa2, 0x78, 0x7a, 0xd9, 0x26,
		0x8b, 0x74, 0x74, 0xb6, 0x82, 0xe3, 0xbe, 0xc3,
		0xce, 0x36, 0x9a, 0x1e, 0x5e, 0x31, 0x47, 0xa2,
		0x6d, 0x37, 0x7c, 0xfd, 0x20, 0xb5, 0xdf, 0x75,
	};

	u8 scalar[32];
	crypto_eddsa_trim_scalar(scalar, secret_key);

	add_xl(scalar, secret_key[0]);
	scalarmult(public_key, scalar, dirty_base_point, 256);
	WIPE_BUFFER(scalar);
}

static void select_lop(fe out, const fe x, const fe k, u8 cofactor)
{
	fe tmp;
	fe_0(out);
	fe_ccopy(out, k  , (cofactor >> 1) & 1);
	fe_ccopy(out, x  , (cofactor >> 0) & 1);
	fe_neg  (tmp, out);
	fe_ccopy(out, tmp, (cofactor >> 2) & 1);
	WIPE_BUFFER(tmp);
}

void crypto_x25519_dirty_fast(u8 public_key[32], const u8 secret_key[32])
{

	u8 scalar[32];
	ge pk;
	crypto_eddsa_trim_scalar(scalar, secret_key);
	ge_scalarmult_base(&pk, scalar);

	fe t1, t2;
	select_lop(t1, lop_x, sqrtm1, secret_key[0]);
	select_lop(t2, lop_y, fe_one, secret_key[0] + 2);
	ge_precomp low_order_point;
	fe_add(low_order_point.Yp, t2, t1);
	fe_sub(low_order_point.Ym, t2, t1);
	fe_mul(low_order_point.T2, t2, t1);
	fe_mul(low_order_point.T2, low_order_point.T2, D2);

	ge_madd(&pk, &pk, &low_order_point, t1, t2);

	fe_add(t1, pk.Z, pk.Y);
	fe_sub(t2, pk.Z, pk.Y);
	fe_invert(t2, t2);
	fe_mul(t1, t1, t2);

	fe_tobytes(public_key, t1);

	WIPE_BUFFER(t1);    WIPE_CTX(&pk);
	WIPE_BUFFER(t2);    WIPE_CTX(&low_order_point);
	WIPE_BUFFER(scalar);
}

static const fe A = {486662};

void crypto_elligator_map(u8 curve[32], const u8 hidden[32])
{
	fe r, u, t1, t2, t3;
	fe_frombytes_mask(r, hidden, 2);
	fe_sq(r, r);
	fe_add(t1, r, r);
	fe_add(u, t1, fe_one);
	fe_sq (t2, u);
	fe_mul(t3, A2, t1);
	fe_sub(t3, t3, t2);
	fe_mul(t3, t3, A);
	fe_mul(t1, t2, u);
	fe_mul(t1, t3, t1);
	int is_square = invsqrt(t1, t1);
	fe_mul(u, r, ufactor);
	fe_ccopy(u, fe_one, is_square);
	fe_sq (t1, t1);
	fe_mul(u, u, A);
	fe_mul(u, u, t3);
	fe_mul(u, u, t2);
	fe_mul(u, u, t1);
	fe_neg(u, u);
	fe_tobytes(curve, u);

	WIPE_BUFFER(t1);  WIPE_BUFFER(r);
	WIPE_BUFFER(t2);  WIPE_BUFFER(u);
	WIPE_BUFFER(t3);
}

int crypto_elligator_rev(u8 hidden[32], const u8 public_key[32], u8 tweak)
{
	fe t1, t2, t3;
	fe_frombytes(t1, public_key);

	fe_add(t2, t1, A);
	fe_mul(t3, t1, t2);
	fe_mul_small(t3, t3, -2);
	int is_square = invsqrt(t3, t3);
	if (is_square) {

		fe_ccopy    (t1, t2, tweak & 1);
		fe_mul      (t3, t1, t3);
		fe_mul_small(t1, t3, 2);
		fe_neg      (t2, t3);
		fe_ccopy    (t3, t2, fe_isodd(t1));
		fe_tobytes(hidden, t3);

		hidden[31] |= tweak & 0xc0;
	}

	WIPE_BUFFER(t1);
	WIPE_BUFFER(t2);
	WIPE_BUFFER(t3);
	return is_square - 1;
}

void crypto_elligator_key_pair(u8 hidden[32], u8 secret_key[32], u8 seed[32])
{
	u8 pk [32];
	u8 buf[64];
	COPY(buf + 32, seed, 32);
	do {
		crypto_chacha20_djb(buf, 0, 64, buf+32, zero, 0);
		crypto_x25519_dirty_fast(pk, buf);
	} while(crypto_elligator_rev(buf+32, pk, buf[32]));

	crypto_wipe(seed, 32);
	COPY(hidden    , buf + 32, 32);
	COPY(secret_key, buf     , 32);
	WIPE_BUFFER(buf);
	WIPE_BUFFER(pk);
}

static void redc(u32 u[8], u32 x[16])
{
	static const u32 k[8] = {
		0x12547e1b, 0xd2b51da3, 0xfdba84ff, 0xb1a206f2,
		0xffa36bea, 0x14e75438, 0x6fe91836, 0x9db6c6f2,
	};

	u32 s[8] = {0};
	FOR (i, 0, 8) {
		u64 carry = 0;
		FOR (j, 0, 8-i) {
			carry  += s[i+j] + (u64)x[i] * k[j];
			s[i+j]  = (u32)carry;
			carry >>= 32;
		}
	}
	u32 t[16] = {0};
	multiply(t, s, L);

	u64 carry = 0;
	FOR (i, 0, 16) {
		carry  += (u64)t[i] + x[i];
		t[i]    = (u32)carry;
		carry >>= 32;
	}

	remove_l(u, t+8);

	WIPE_BUFFER(s);
	WIPE_BUFFER(t);
}

void crypto_x25519_inverse(u8 blind_salt [32], const u8 private_key[32],
                           const u8 curve_point[32])
{
	static const  u8 Lm2[32] = {
		0xeb, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58,
		0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10,
	};

	u32 m_inv [8] = {
		0x8d98951d, 0xd6ec3174, 0x737dcf70, 0xc6ef5bf4,
		0xfffffffe, 0xffffffff, 0xffffffff, 0x0fffffff,
	};

	u8 scalar[32];
	crypto_eddsa_trim_scalar(scalar, private_key);

	u32 m_scl[8];
	{
		u32 tmp[16];
		ZERO(tmp, 8);
		load32_le_buf(tmp+8, scalar, 8);
		mod_l(scalar, tmp);
		load32_le_buf(m_scl, scalar, 8);
		WIPE_BUFFER(tmp);
	}

	u32 product[16];
	for (int i = 252; i >= 0; i--) {
		ZERO(product, 16);
		multiply(product, m_inv, m_inv);
		redc(m_inv, product);
		if (scalar_bit(Lm2, i)) {
			ZERO(product, 16);
			multiply(product, m_inv, m_scl);
			redc(m_inv, product);
		}
	}

	COPY(product, m_inv, 8);
	ZERO(product + 8, 8);
	redc(m_inv, product);
	store32_le_buf(scalar, m_inv, 8);

	add_xl(scalar, scalar[0] * 3);

	scalarmult(blind_salt, scalar, curve_point, 256);

	WIPE_BUFFER(scalar);   WIPE_BUFFER(m_scl);
	WIPE_BUFFER(product);  WIPE_BUFFER(m_inv);
}

static void lock_auth(u8 mac[16], const u8  auth_key[32],
                      const u8 *ad         , size_t ad_size,
                      const u8 *cipher_text, size_t text_size)
{
	u8 sizes[16];
	store64_le(sizes + 0, ad_size);
	store64_le(sizes + 8, text_size);
	crypto_poly1305_ctx poly_ctx;
	crypto_poly1305_init  (&poly_ctx, auth_key);
	crypto_poly1305_update(&poly_ctx, ad         , ad_size);
	crypto_poly1305_update(&poly_ctx, zero       , gap(ad_size, 16));
	crypto_poly1305_update(&poly_ctx, cipher_text, text_size);
	crypto_poly1305_update(&poly_ctx, zero       , gap(text_size, 16));
	crypto_poly1305_update(&poly_ctx, sizes      , 16);
	crypto_poly1305_final (&poly_ctx, mac);
}

void crypto_aead_init_x(crypto_aead_ctx *ctx,
                        u8 const key[32], const u8 nonce[24])
{
	crypto_chacha20_h(ctx->key, key, nonce);
	COPY(ctx->nonce, nonce + 16, 8);
	ctx->counter = 0;
}

void crypto_aead_init_djb(crypto_aead_ctx *ctx,
                          const u8 key[32], const u8 nonce[8])
{
	COPY(ctx->key  , key  , 32);
	COPY(ctx->nonce, nonce,  8);
	ctx->counter = 0;
}

void crypto_aead_init_ietf(crypto_aead_ctx *ctx,
                           const u8 key[32], const u8 nonce[12])
{
	COPY(ctx->key  , key      , 32);
	COPY(ctx->nonce, nonce + 4,  8);
	ctx->counter = (u64)load32_le(nonce) << 32;
}

void crypto_aead_write(crypto_aead_ctx *ctx, u8 *cipher_text, u8 mac[16],
                       const u8 *ad,         size_t ad_size,
                       const u8 *plain_text, size_t text_size)
{
	u8 auth_key[64];
	crypto_chacha20_djb(auth_key, 0, 64, ctx->key, ctx->nonce, ctx->counter);
	crypto_chacha20_djb(cipher_text, plain_text, text_size,
	                    ctx->key, ctx->nonce, ctx->counter + 1);
	lock_auth(mac, auth_key, ad, ad_size, cipher_text, text_size);
	COPY(ctx->key, auth_key + 32, 32);
	WIPE_BUFFER(auth_key);
}

int crypto_aead_read(crypto_aead_ctx *ctx, u8 *plain_text, const u8 mac[16],
                     const u8 *ad,          size_t ad_size,
                     const u8 *cipher_text, size_t text_size)
{
	u8 auth_key[64];
	u8 real_mac[16];
	crypto_chacha20_djb(auth_key, 0, 64, ctx->key, ctx->nonce, ctx->counter);
	lock_auth(real_mac, auth_key, ad, ad_size, cipher_text, text_size);
	int mismatch = crypto_verify16(mac, real_mac);
	if (!mismatch) {
		crypto_chacha20_djb(plain_text, cipher_text, text_size,
		                    ctx->key, ctx->nonce, ctx->counter + 1);
		COPY(ctx->key, auth_key + 32, 32);
	}
	WIPE_BUFFER(auth_key);
	WIPE_BUFFER(real_mac);
	return mismatch;
}

void crypto_aead_lock(u8 *cipher_text, u8 mac[16], const u8 key[32],
                      const u8  nonce[24], const u8 *ad, size_t ad_size,
                      const u8 *plain_text, size_t text_size)
{
	crypto_aead_ctx ctx;
	crypto_aead_init_x(&ctx, key, nonce);
	crypto_aead_write(&ctx, cipher_text, mac, ad, ad_size,
	                  plain_text, text_size);
	crypto_wipe(&ctx, sizeof(ctx));
}

int crypto_aead_unlock(u8 *plain_text, const u8  mac[16], const u8 key[32],
                       const u8 nonce[24], const u8 *ad, size_t ad_size,
                       const u8 *cipher_text, size_t text_size)
{
	crypto_aead_ctx ctx;
	crypto_aead_init_x(&ctx, key, nonce);
	int mismatch = crypto_aead_read(&ctx, plain_text, mac, ad, ad_size,
	                                cipher_text, text_size);
	crypto_wipe(&ctx, sizeof(ctx));
	return mismatch;
}


#undef FOR_T
#undef FOR
#undef COPY
#undef ZERO
#undef WIPE_CTX
#undef WIPE_BUFFER
#undef MIN
#undef MAX
#undef QUARTERROUND
#undef BLAKE2_G
#undef BLAKE2_ROUND
#undef LSB
#undef G
#undef ROUND
#undef FE_CARRY
#undef P_W_WIDTH
#undef B_W_WIDTH
#undef P_W_SIZE
#undef zero
#undef gap
#undef load24_le
#undef load32_le
#undef load64_le
#undef store32_le
#undef store64_le
#undef load32_le_buf
#undef load64_le_buf
#undef store32_le_buf
#undef store64_le_buf
#undef rotr64
#undef rotl32
#undef neq0
#undef x16
#undef x32
#undef x64
#undef chacha20_rounds
#undef chacha20_constant
#undef poly_blocks
#undef iv
#undef blake2b_compress
#undef blake_update_32
#undef blake_update_32_buf
#undef copy_block
#undef xor_block
#undef extended_hash
#undef g_rounds
#undef fe_one
#undef sqrtm1
#undef d
#undef D2
#undef lop_x
#undef lop_y
#undef ufactor
#undef A2
#undef fe_0
#undef fe_1
#undef fe_copy
#undef fe_neg
#undef fe_add
#undef fe_sub
#undef fe_cswap
#undef fe_ccopy
#undef fe_frombytes_mask
#undef fe_frombytes
#undef fe_tobytes
#undef fe_mul_small
#undef fe_mul
#undef fe_sq
#undef fe_isodd
#undef fe_isequal
#undef invsqrt
#undef fe_invert
#undef scalar_bit
#undef scalarmult
#undef L
#undef multiply
#undef is_above_l
#undef remove_l
#undef mod_l
#undef ge_zero
#undef ge_tobytes
#undef ge_frombytes_neg_vartime
#undef ge_cache
#undef ge_add
#undef ge_sub
#undef ge_madd
#undef ge_msub
#undef ge_double
#undef b_window
#undef slide_init
#undef slide_step
#undef b_comb_low
#undef b_comb_high
#undef lookup_add
#undef ge_scalarmult_base
#undef hash_reduce
#undef add_xl
#undef select_lop
#undef A
#undef redc
#undef lock_auth
#define align sbm2_align
#define load64_be sbm2_load64_be
#define store64_be sbm2_store64_be
#define load64_be_buf sbm2_load64_be_buf
#define rot sbm2_rot
#define ch sbm2_ch
#define maj sbm2_maj
#define big_sigma0 sbm2_big_sigma0
#define big_sigma1 sbm2_big_sigma1
#define lit_sigma0 sbm2_lit_sigma0
#define lit_sigma1 sbm2_lit_sigma1
#define K sbm2_K
#define sha512_compress sbm2_sha512_compress
#define sha512_set_input sbm2_sha512_set_input
#define sha512_incr sbm2_sha512_incr
#define hash_reduce sbm2_hash_reduce
#define ed25519_dom_sign sbm2_ed25519_dom_sign
#define domain sbm2_domain


#define FOR(i, min, max)     for (size_t i = min; i < max; i++)
#define COPY(dst, src, size) FOR(_i_, 0, size) (dst)[_i_] = (src)[_i_]
#define ZERO(buf, size)      FOR(_i_, 0, size) (buf)[_i_] = 0
#define WIPE_CTX(ctx)        crypto_wipe(ctx   , sizeof(*(ctx)))
#define WIPE_BUFFER(buffer)  crypto_wipe(buffer, sizeof(buffer))
#define MIN(a, b)            ((a) <= (b) ? (a) : (b))
typedef uint8_t u8;
typedef uint64_t u64;

static size_t align(size_t x, size_t pow_2)
{
	return (~x + 1) & (pow_2 - 1);
}

static u64 load64_be(const u8 s[8])
{
	return((u64)s[0] << 56)
		| ((u64)s[1] << 48)
		| ((u64)s[2] << 40)
		| ((u64)s[3] << 32)
		| ((u64)s[4] << 24)
		| ((u64)s[5] << 16)
		| ((u64)s[6] <<  8)
		|  (u64)s[7];
}

static void store64_be(u8 out[8], u64 in)
{
	out[0] = (in >> 56) & 0xff;
	out[1] = (in >> 48) & 0xff;
	out[2] = (in >> 40) & 0xff;
	out[3] = (in >> 32) & 0xff;
	out[4] = (in >> 24) & 0xff;
	out[5] = (in >> 16) & 0xff;
	out[6] = (in >>  8) & 0xff;
	out[7] =  in        & 0xff;
}

static void load64_be_buf (u64 *dst, const u8 *src, size_t size) {
	FOR(i, 0, size) { dst[i] = load64_be(src + i*8); }
}

static u64 rot(u64 x, int c       ) { return (x >> c) | (x << (64 - c));   }
static u64 ch (u64 x, u64 y, u64 z) { return (x & y) ^ (~x & z);           }
static u64 maj(u64 x, u64 y, u64 z) { return (x & y) ^ ( x & z) ^ (y & z); }
static u64 big_sigma0(u64 x) { return rot(x, 28) ^ rot(x, 34) ^ rot(x, 39); }
static u64 big_sigma1(u64 x) { return rot(x, 14) ^ rot(x, 18) ^ rot(x, 41); }
static u64 lit_sigma0(u64 x) { return rot(x,  1) ^ rot(x,  8) ^ (x >> 7);   }
static u64 lit_sigma1(u64 x) { return rot(x, 19) ^ rot(x, 61) ^ (x >> 6);   }

static const u64 K[80] = {
	0x428a2f98d728ae22,0x7137449123ef65cd,0xb5c0fbcfec4d3b2f,0xe9b5dba58189dbbc,
	0x3956c25bf348b538,0x59f111f1b605d019,0x923f82a4af194f9b,0xab1c5ed5da6d8118,
	0xd807aa98a3030242,0x12835b0145706fbe,0x243185be4ee4b28c,0x550c7dc3d5ffb4e2,
	0x72be5d74f27b896f,0x80deb1fe3b1696b1,0x9bdc06a725c71235,0xc19bf174cf692694,
	0xe49b69c19ef14ad2,0xefbe4786384f25e3,0x0fc19dc68b8cd5b5,0x240ca1cc77ac9c65,
	0x2de92c6f592b0275,0x4a7484aa6ea6e483,0x5cb0a9dcbd41fbd4,0x76f988da831153b5,
	0x983e5152ee66dfab,0xa831c66d2db43210,0xb00327c898fb213f,0xbf597fc7beef0ee4,
	0xc6e00bf33da88fc2,0xd5a79147930aa725,0x06ca6351e003826f,0x142929670a0e6e70,
	0x27b70a8546d22ffc,0x2e1b21385c26c926,0x4d2c6dfc5ac42aed,0x53380d139d95b3df,
	0x650a73548baf63de,0x766a0abb3c77b2a8,0x81c2c92e47edaee6,0x92722c851482353b,
	0xa2bfe8a14cf10364,0xa81a664bbc423001,0xc24b8b70d0f89791,0xc76c51a30654be30,
	0xd192e819d6ef5218,0xd69906245565a910,0xf40e35855771202a,0x106aa07032bbd1b8,
	0x19a4c116b8d2d0c8,0x1e376c085141ab53,0x2748774cdf8eeb99,0x34b0bcb5e19b48a8,
	0x391c0cb3c5c95a63,0x4ed8aa4ae3418acb,0x5b9cca4f7763e373,0x682e6ff3d6b2b8a3,
	0x748f82ee5defb2fc,0x78a5636f43172f60,0x84c87814a1f0ab72,0x8cc702081a6439ec,
	0x90befffa23631e28,0xa4506cebde82bde9,0xbef9a3f7b2c67915,0xc67178f2e372532b,
	0xca273eceea26619c,0xd186b8c721c0c207,0xeada7dd6cde0eb1e,0xf57d4f7fee6ed178,
	0x06f067aa72176fba,0x0a637dc5a2c898a6,0x113f9804bef90dae,0x1b710b35131c471b,
	0x28db77f523047d84,0x32caab7b40c72493,0x3c9ebe0a15c9bebc,0x431d67c49c100d4c,
	0x4cc5d4becb3e42b6,0x597f299cfc657e2a,0x5fcb6fab3ad6faec,0x6c44198c4a475817
};

static void sha512_compress(crypto_sha512_ctx *ctx)
{
	u64 a = ctx->hash[0];    u64 b = ctx->hash[1];
	u64 c = ctx->hash[2];    u64 d = ctx->hash[3];
	u64 e = ctx->hash[4];    u64 f = ctx->hash[5];
	u64 g = ctx->hash[6];    u64 h = ctx->hash[7];

	FOR (j, 0, 16) {
		u64 in = K[j] + ctx->input[j];
		u64 t1 = big_sigma1(e) + ch (e, f, g) + h + in;
		u64 t2 = big_sigma0(a) + maj(a, b, c);
		h = g;  g = f;  f = e;  e = d  + t1;
		d = c;  c = b;  b = a;  a = t1 + t2;
	}
	size_t i16 = 0;
	FOR(i, 1, 5) {
		i16 += 16;
		FOR (j, 0, 16) {
			ctx->input[j] += lit_sigma1(ctx->input[(j- 2) & 15]);
			ctx->input[j] += lit_sigma0(ctx->input[(j-15) & 15]);
			ctx->input[j] +=            ctx->input[(j- 7) & 15];
			u64 in = K[i16 + j] + ctx->input[j];
			u64 t1 = big_sigma1(e) + ch (e, f, g) + h + in;
			u64 t2 = big_sigma0(a) + maj(a, b, c);
			h = g;  g = f;  f = e;  e = d  + t1;
			d = c;  c = b;  b = a;  a = t1 + t2;
		}
	}

	ctx->hash[0] += a;    ctx->hash[1] += b;
	ctx->hash[2] += c;    ctx->hash[3] += d;
	ctx->hash[4] += e;    ctx->hash[5] += f;
	ctx->hash[6] += g;    ctx->hash[7] += h;
}

static void sha512_set_input(crypto_sha512_ctx *ctx, u8 input)
{
	size_t word = ctx->input_idx >> 3;
	size_t byte = ctx->input_idx &  7;
	ctx->input[word] |= (u64)input << (8 * (7 - byte));
}

static void sha512_incr(u64 x[2], u64 y)
{
	x[1] += y;
	if (x[1] < y) {
		x[0]++;
	}
}

void crypto_sha512_init(crypto_sha512_ctx *ctx)
{
	ctx->hash[0] = 0x6a09e667f3bcc908;
	ctx->hash[1] = 0xbb67ae8584caa73b;
	ctx->hash[2] = 0x3c6ef372fe94f82b;
	ctx->hash[3] = 0xa54ff53a5f1d36f1;
	ctx->hash[4] = 0x510e527fade682d1;
	ctx->hash[5] = 0x9b05688c2b3e6c1f;
	ctx->hash[6] = 0x1f83d9abfb41bd6b;
	ctx->hash[7] = 0x5be0cd19137e2179;
	ctx->input_size[0] = 0;
	ctx->input_size[1] = 0;
	ctx->input_idx = 0;
	ZERO(ctx->input, 16);
}

void crypto_sha512_update(crypto_sha512_ctx *ctx,
                          const u8 *message, size_t message_size)
{

	if (message_size == 0) {
		return;
	}

	if ((ctx->input_idx & 7) != 0) {
		size_t nb_bytes = MIN(align(ctx->input_idx, 8), message_size);
		FOR (i, 0, nb_bytes) {
			sha512_set_input(ctx, message[i]);
			ctx->input_idx++;
		}
		message      += nb_bytes;
		message_size -= nb_bytes;
	}

	if ((ctx->input_idx & 127) != 0) {
		size_t nb_words = MIN(align(ctx->input_idx, 128), message_size) >> 3;
		load64_be_buf(ctx->input + (ctx->input_idx >> 3), message, nb_words);
		ctx->input_idx += nb_words << 3;
		message        += nb_words << 3;
		message_size   -= nb_words << 3;
	}

	if (ctx->input_idx == 128) {
		sha512_incr(ctx->input_size, 1024);
		sha512_compress(ctx);
		ctx->input_idx = 0;
		ZERO(ctx->input, 16);
	}

	FOR (i, 0, message_size >> 7) {
		load64_be_buf(ctx->input, message, 16);
		sha512_incr(ctx->input_size, 1024);
		sha512_compress(ctx);
		ctx->input_idx = 0;
		ZERO(ctx->input, 16);
		message += 128;
	}
	message_size &= 127;

	if (message_size != 0) {

		size_t nb_words = message_size >> 3;
		load64_be_buf(ctx->input, message, nb_words);
		ctx->input_idx += nb_words << 3;
		message        += nb_words << 3;
		message_size   -= nb_words << 3;

		FOR (i, 0, message_size) {
			sha512_set_input(ctx, message[i]);
			ctx->input_idx++;
		}
	}
}

void crypto_sha512_final(crypto_sha512_ctx *ctx, u8 hash[64])
{

	if (ctx->input_idx == 0) {
		ZERO(ctx->input, 16);
	}
	sha512_set_input(ctx, 128);

	sha512_incr(ctx->input_size, ctx->input_idx * 8);

	if (ctx->input_idx > 111) {
		sha512_compress(ctx);
		ZERO(ctx->input, 14);
	}

	ctx->input[14] = ctx->input_size[0];
	ctx->input[15] = ctx->input_size[1];
	sha512_compress(ctx);

	FOR (i, 0, 8) {
		store64_be(hash + i*8, ctx->hash[i]);
	}

	WIPE_CTX(ctx);
}

void crypto_sha512(u8 hash[64], const u8 *message, size_t message_size)
{
	crypto_sha512_ctx ctx;
	crypto_sha512_init  (&ctx);
	crypto_sha512_update(&ctx, message, message_size);
	crypto_sha512_final (&ctx, hash);
}

void crypto_sha512_hmac_init(crypto_sha512_hmac_ctx *ctx,
                             const u8 *key, size_t key_size)
{

	if (key_size > 128) {
		crypto_sha512(ctx->key, key, key_size);
		key      = ctx->key;
		key_size = 64;
	}

	FOR (i, 0, key_size)   { ctx->key[i] = key[i] ^ 0x36; }
	FOR (i, key_size, 128) { ctx->key[i] =          0x36; }

	crypto_sha512_init  (&ctx->ctx);
	crypto_sha512_update(&ctx->ctx, ctx->key, 128);
}

void crypto_sha512_hmac_update(crypto_sha512_hmac_ctx *ctx,
                               const u8 *message, size_t message_size)
{
	crypto_sha512_update(&ctx->ctx, message, message_size);
}

void crypto_sha512_hmac_final(crypto_sha512_hmac_ctx *ctx, u8 hmac[64])
{

	crypto_sha512_final(&ctx->ctx, hmac);

	FOR (i, 0, 128) {
		ctx->key[i] ^= 0x36 ^ 0x5c;
	}

	crypto_sha512_init  (&ctx->ctx);
	crypto_sha512_update(&ctx->ctx, ctx->key , 128);
	crypto_sha512_update(&ctx->ctx, hmac, 64);
	crypto_sha512_final (&ctx->ctx, hmac);
	WIPE_CTX(ctx);
}

void crypto_sha512_hmac(u8 hmac[64], const u8 *key, size_t key_size,
                        const u8 *message, size_t message_size)
{
	crypto_sha512_hmac_ctx ctx;
	crypto_sha512_hmac_init  (&ctx, key, key_size);
	crypto_sha512_hmac_update(&ctx, message, message_size);
	crypto_sha512_hmac_final (&ctx, hmac);
}

void crypto_sha512_hkdf_expand(u8       *okm,  size_t okm_size,
                               const u8 *prk,  size_t prk_size,
                               const u8 *info, size_t info_size)
{
	int not_first = 0;
	u8 ctr = 1;
	u8 blk[64];

	while (okm_size > 0) {
		size_t out_size = MIN(okm_size, sizeof(blk));

		crypto_sha512_hmac_ctx ctx;
		crypto_sha512_hmac_init(&ctx, prk , prk_size);
		if (not_first) {

			crypto_sha512_hmac_update(&ctx, blk , sizeof(blk));
		}
		crypto_sha512_hmac_update(&ctx, info, info_size);
		crypto_sha512_hmac_update(&ctx, &ctr, 1);
		crypto_sha512_hmac_final(&ctx, blk);

		COPY(okm, blk, out_size);

		not_first = 1;
		okm      += out_size;
		okm_size -= out_size;
		ctr++;
	}
}

void crypto_sha512_hkdf(u8       *okm , size_t okm_size,
                        const u8 *ikm , size_t ikm_size,
                        const u8 *salt, size_t salt_size,
                        const u8 *info, size_t info_size)
{

	u8 prk[64];
	crypto_sha512_hmac(prk, salt, salt_size, ikm, ikm_size);

	crypto_sha512_hkdf_expand(okm, okm_size, prk, sizeof(prk), info, info_size);
}

void crypto_ed25519_key_pair(u8 secret_key[64], u8 public_key[32], u8 seed[32])
{
	u8 a[64];
	COPY(a, seed, 32);
	crypto_wipe(seed, 32);
	COPY(secret_key, a, 32);
	crypto_sha512(a, a, 32);
	crypto_eddsa_trim_scalar(a, a);
	crypto_eddsa_scalarbase(public_key, a);
	COPY(secret_key + 32, public_key, 32);
	WIPE_BUFFER(a);
}

static void hash_reduce(u8 h[32],
                        const u8 *a, size_t a_size,
                        const u8 *b, size_t b_size,
                        const u8 *c, size_t c_size,
                        const u8 *d, size_t d_size)
{
	u8 hash[64];
	crypto_sha512_ctx ctx;
	crypto_sha512_init  (&ctx);
	crypto_sha512_update(&ctx, a, a_size);
	crypto_sha512_update(&ctx, b, b_size);
	crypto_sha512_update(&ctx, c, c_size);
	crypto_sha512_update(&ctx, d, d_size);
	crypto_sha512_final (&ctx, hash);
	crypto_eddsa_reduce(h, hash);
}

static void ed25519_dom_sign(u8 signature [64], const u8 secret_key[32],
                             const u8 *dom,     size_t dom_size,
                             const u8 *message, size_t message_size)
{
	u8 a[64];
	u8 r[32];
	u8 h[32];
	u8 R[32];
	const u8 *pk = secret_key + 32;

	crypto_sha512(a, secret_key, 32);
	crypto_eddsa_trim_scalar(a, a);
	hash_reduce(r, dom, dom_size, a + 32, 32, message, message_size, 0, 0);
	crypto_eddsa_scalarbase(R, r);
	hash_reduce(h, dom, dom_size, R, 32, pk, 32, message, message_size);
	COPY(signature, R, 32);
	crypto_eddsa_mul_add(signature + 32, h, a, r);

	WIPE_BUFFER(a);
	WIPE_BUFFER(r);
}

void crypto_ed25519_sign(u8 signature [64], const u8 secret_key[64],
                         const u8 *message, size_t message_size)
{
	ed25519_dom_sign(signature, secret_key, 0, 0, message, message_size);
}

int crypto_ed25519_check(const u8 signature[64], const u8 public_key[32],
                         const u8 *msg, size_t msg_size)
{
	u8 h_ram[32];
	hash_reduce(h_ram, signature, 32, public_key, 32, msg, msg_size, 0, 0);
	return crypto_eddsa_check_equation(signature, public_key, h_ram);
}

static const u8 domain[34] = "SigEd25519 no Ed25519 collisions\1";

void crypto_ed25519_ph_sign(uint8_t signature[64], const uint8_t secret_key[64],
                            const uint8_t message_hash[64])
{
	ed25519_dom_sign(signature, secret_key, domain, sizeof(domain),
	                 message_hash, 64);
}

int crypto_ed25519_ph_check(const uint8_t sig[64], const uint8_t pk[32],
                            const uint8_t msg_hash[64])
{
	u8 h_ram[32];
	hash_reduce(h_ram, domain, sizeof(domain), sig, 32, pk, 32, msg_hash, 64);
	return crypto_eddsa_check_equation(sig, pk, h_ram);
}


#undef FOR
#undef COPY
#undef ZERO
#undef WIPE_CTX
#undef WIPE_BUFFER
#undef MIN
#undef align
#undef load64_be
#undef store64_be
#undef load64_be_buf
#undef rot
#undef ch
#undef maj
#undef big_sigma0
#undef big_sigma1
#undef lit_sigma0
#undef lit_sigma1
#undef K
#undef sha512_compress
#undef sha512_set_input
#undef sha512_incr
#undef hash_reduce
#undef ed25519_dom_sign
#undef domain
#undef i8
#undef u8
#undef i16
#undef u32
#undef i32
#undef i64
#undef u64
#undef fe
#undef ge
#undef ge_cached
#undef ge_precomp
#undef blk
// End of Monocypher.
#define SBC_OK 0
#define SBC_DATA 1
#define SBC_OPERATION 2
#define SBC_NOTSUP 3

typedef unsigned char sbc_u8;

static int sbc_rand(void* out, size_t n) {
  int fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
  if (fd < 0) return 0;
  size_t got = 0;
  while (got < n) {
    ssize_t r = read(fd, (sbc_u8*)out + got, n - got);
    if (r <= 0) { close(fd); return 0; }
    got += (size_t)r;
  }
  close(fd);
  return 1;
}
static void sbc_prng_init(const br_prng_class** c, const void* params, const void* seed, size_t len) { (void)c; (void)params; (void)seed; (void)len; }
static void sbc_prng_generate(const br_prng_class** c, void* out, size_t len) {
  (void)c;
  if (!sbc_rand(out, len)) abort();
}
static void sbc_prng_update(const br_prng_class** c, const void* seed, size_t len) { (void)c; (void)seed; (void)len; }
static const br_prng_class sbc_prng_vtable = { sizeof(br_prng_class*), sbc_prng_init, sbc_prng_generate, sbc_prng_update };
static const br_prng_class* sbc_prng = &sbc_prng_vtable;

static const br_hash_class* sbc_hash(int bits) {
  switch (bits) {
    case 1: return &br_sha1_vtable;
    case 256: return &br_sha256_vtable;
    case 384: return &br_sha384_vtable;
    case 512: return &br_sha512_vtable;
  }
  return 0;
}
static const unsigned char* sbc_hash_oid(int bits) {
  switch (bits) {
    case 1: return BR_HASH_OID_SHA1;
    case 256: return BR_HASH_OID_SHA256;
    case 384: return BR_HASH_OID_SHA384;
    case 512: return BR_HASH_OID_SHA512;
  }
  return 0;
}
static size_t sbc_hlen(int bits) { return bits == 1 ? 20 : (size_t)bits / 8; }

static int sbc_digest(int bits, const sbc_u8* m, size_t ml, sbc_u8* out) {
  const br_hash_class* hc = sbc_hash(bits);
  if (!hc) return 0;
  br_hash_compat_context ctx;
  hc->init(&ctx.vtable);
  hc->update(&ctx.vtable, m, ml);
  hc->out(&ctx.vtable, out);
  return 1;
}

static long sbc_param(const sbc_u8* p, size_t pl, int idx) {
  long v = 0; int cur = 0; int any = 0;
  for (size_t i = 0; i <= pl; i++) {
    if (i == pl || p[i] == ',') {
      if (cur == idx) return any ? v : -1;
      cur++; v = 0; any = 0;
    } else if (p[i] >= '0' && p[i] <= '9') { v = v * 10 + (p[i] - '0'); any = 1; }
  }
  return -1;
}

static int sbc_ct_eq(const sbc_u8* a, const sbc_u8* b, size_t n) {
  sbc_u8 d = 0;
  for (size_t i = 0; i < n; i++) d |= (sbc_u8)(a[i] ^ b[i]);
  return d == 0;
}

typedef struct { sbc_u8* p; size_t n; size_t cap; int bad; } sbc_buf;
static void sbc_put(sbc_buf* b, const void* d, size_t n) {
  if (b->bad) return;
  if (b->n + n > b->cap) {
    size_t cap = b->cap ? b->cap : 256;
    while (cap < b->n + n) cap *= 2;
    sbc_u8* g = (sbc_u8*)realloc(b->p, cap);
    if (!g) { b->bad = 1; return; }
    b->p = g; b->cap = cap;
  }
  if (n) memcpy(b->p + b->n, d, n);
  b->n += n;
}
static void sbc_put1(sbc_buf* b, sbc_u8 v) { sbc_put(b, &v, 1); }

static void sbc_field(sbc_buf* b, const void* d, size_t n) {
  sbc_u8 h[4] = { (sbc_u8)(n >> 24), (sbc_u8)(n >> 16), (sbc_u8)(n >> 8), (sbc_u8)n };
  sbc_put(b, h, 4); sbc_put(b, d, n);
}

static int sbc_next(const sbc_u8** p, size_t* left, const sbc_u8** f, size_t* fl) {
  if (*left < 4) return 0;
  size_t n = ((size_t)(*p)[0] << 24) | ((size_t)(*p)[1] << 16) | ((size_t)(*p)[2] << 8) | (*p)[3];
  if (n > *left - 4) return 0;
  *f = *p + 4; *fl = n; *p += 4 + n; *left -= 4 + n;
  return 1;
}

static void sbc_strip(const sbc_u8** p, size_t* n) {
  while (*n > 1 && **p == 0) { (*p)++; (*n)--; }
}

static void sbc_der_len(sbc_buf* b, size_t n) {
  if (n < 128) { sbc_put1(b, (sbc_u8)n); }
  else if (n < 256) { sbc_put1(b, 0x81); sbc_put1(b, (sbc_u8)n); }
  else if (n < 65536) { sbc_put1(b, 0x82); sbc_put1(b, (sbc_u8)(n >> 8)); sbc_put1(b, (sbc_u8)n); }
  else { sbc_put1(b, 0x83); sbc_put1(b, (sbc_u8)(n >> 16)); sbc_put1(b, (sbc_u8)(n >> 8)); sbc_put1(b, (sbc_u8)n); }
}
static void sbc_der_tlv(sbc_buf* b, sbc_u8 tag, const void* d, size_t n) {
  sbc_put1(b, tag); sbc_der_len(b, n); sbc_put(b, d, n);
}

static void sbc_der_uint(sbc_buf* b, const sbc_u8* d, size_t n) {
  sbc_strip(&d, &n);
  sbc_put1(b, 0x02);
  int pad = (d[0] & 0x80) ? 1 : 0;
  sbc_der_len(b, n + (size_t)pad);
  if (pad) sbc_put1(b, 0);
  sbc_put(b, d, n);
}

static int sbc_der_read(const sbc_u8** p, size_t* left, sbc_u8* tag, const sbc_u8** c, size_t* cl) {
  if (*left < 2) return 0;
  *tag = (*p)[0];
  size_t n = (*p)[1], hl = 2;
  if (n & 0x80) {
    size_t k = n & 0x7f;
    if (k == 0 || k > 3 || *left < 2 + k) return 0;
    n = 0;
    for (size_t i = 0; i < k; i++) n = (n << 8) | (*p)[2 + i];
    hl = 2 + k;
  }
  if (n > *left - hl) return 0;
  *c = *p + hl; *cl = n; *p += hl + n; *left -= hl + n;
  return 1;
}

static const sbc_u8 sbc_oid_rsa[] = { 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01 };
static const sbc_u8 sbc_oid_ec[] = { 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01 };
static const sbc_u8 sbc_oid_p256[] = { 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07 };
static const sbc_u8 sbc_oid_p384[] = { 0x2b, 0x81, 0x04, 0x00, 0x22 };
static const sbc_u8 sbc_oid_p521[] = { 0x2b, 0x81, 0x04, 0x00, 0x23 };
static const sbc_u8 sbc_oid_ed25519[] = { 0x2b, 0x65, 0x70 };
static const sbc_u8 sbc_oid_x25519[] = { 0x2b, 0x65, 0x6e };

#define SBC_K_RSA 1
#define SBC_K_EC 2
#define SBC_K_ED25519 3
#define SBC_K_X25519 4

static int sbc_oid_eq(const sbc_u8* a, size_t al, const sbc_u8* b, size_t bl) { return al == bl && memcmp(a, b, al) == 0; }

static int sbc_curve_br(int c) { return c == 1 ? BR_EC_secp256r1 : c == 2 ? BR_EC_secp384r1 : c == 3 ? BR_EC_secp521r1 : 0; }
static int sbc_curve_from_br(int c) { return c == BR_EC_secp256r1 ? 1 : c == BR_EC_secp384r1 ? 2 : c == BR_EC_secp521r1 ? 3 : 0; }
static size_t sbc_curve_size(int c) { return c == 1 ? 32 : c == 2 ? 48 : c == 3 ? 66 : 0; }
static void sbc_curve_oid(int c, const sbc_u8** o, size_t* n) {
  if (c == 1) { *o = sbc_oid_p256; *n = sizeof sbc_oid_p256; }
  else if (c == 2) { *o = sbc_oid_p384; *n = sizeof sbc_oid_p384; }
  else { *o = sbc_oid_p521; *n = sizeof sbc_oid_p521; }
}

static int sbc_spki_parse(const sbc_u8* der, size_t len, int* kind, int* curve, const sbc_u8** key, size_t* keylen) {
  const sbc_u8 *p = der, *c, *alg, *q;
  size_t left = len, cl, algl, ql;
  sbc_u8 t;
  if (!sbc_der_read(&p, &left, &t, &c, &cl) || t != 0x30 || left != 0) return 0;
  p = c; left = cl;
  if (!sbc_der_read(&p, &left, &t, &alg, &algl) || t != 0x30) return 0;
  if (!sbc_der_read(&p, &left, &t, &q, &ql) || t != 0x03 || left != 0 || ql < 1 || q[0] != 0) return 0;
  *key = q + 1; *keylen = ql - 1;
  const sbc_u8 *ap = alg, *oid, *par;
  size_t al = algl, oidl, parl = 0;
  if (!sbc_der_read(&ap, &al, &t, &oid, &oidl) || t != 0x06) return 0;
  if (sbc_oid_eq(oid, oidl, sbc_oid_rsa, sizeof sbc_oid_rsa)) {
    if (al) { if (!sbc_der_read(&ap, &al, &t, &par, &parl) || t != 0x05 || parl != 0 || al != 0) return 0; }
    *kind = SBC_K_RSA; *curve = 0; return 1;
  }
  if (sbc_oid_eq(oid, oidl, sbc_oid_ec, sizeof sbc_oid_ec)) {
    if (!sbc_der_read(&ap, &al, &t, &par, &parl) || t != 0x06 || al != 0) return 0;
    int cv = 0;
    if (sbc_oid_eq(par, parl, sbc_oid_p256, sizeof sbc_oid_p256)) cv = 1;
    else if (sbc_oid_eq(par, parl, sbc_oid_p384, sizeof sbc_oid_p384)) cv = 2;
    else if (sbc_oid_eq(par, parl, sbc_oid_p521, sizeof sbc_oid_p521)) cv = 3;
    if (!cv || *keylen != 1 + 2 * sbc_curve_size(cv) || (*key)[0] != 4) return 0;
    *kind = SBC_K_EC; *curve = cv; return 1;
  }
  if (al == 0 && *keylen == 32) {
    if (sbc_oid_eq(oid, oidl, sbc_oid_ed25519, 3)) { *kind = SBC_K_ED25519; *curve = 0; return 1; }
    if (sbc_oid_eq(oid, oidl, sbc_oid_x25519, 3)) { *kind = SBC_K_X25519; *curve = 0; return 1; }
  }
  return 0;
}

static void sbc_spki_build(sbc_buf* out, const sbc_buf* alg, const sbc_u8* key, size_t keylen) {
  sbc_buf bits = {0}, body = {0};
  sbc_put1(&bits, 0); sbc_put(&bits, key, keylen);
  sbc_der_tlv(&body, 0x30, alg->p, alg->n);
  sbc_der_tlv(&body, 0x03, bits.p, bits.n);
  sbc_der_tlv(out, 0x30, body.p, body.n);
  free(bits.p); free(body.p);
  if (bits.bad || body.bad) out->bad = 1;
}
static void sbc_alg_rsa(sbc_buf* a) { sbc_der_tlv(a, 0x06, sbc_oid_rsa, sizeof sbc_oid_rsa); sbc_der_tlv(a, 0x05, 0, 0); }
static void sbc_alg_ec(sbc_buf* a, int curve) {
  const sbc_u8* o; size_t n;
  sbc_curve_oid(curve, &o, &n);
  sbc_der_tlv(a, 0x06, sbc_oid_ec, sizeof sbc_oid_ec);
  sbc_der_tlv(a, 0x06, o, n);
}

static int sbc_pkcs8_okp(const sbc_u8* der, size_t len, int* kind, const sbc_u8** seed) {
  const sbc_u8 *p = der, *c, *q;
  size_t left = len, cl, ql;
  sbc_u8 t;
  if (!sbc_der_read(&p, &left, &t, &c, &cl) || t != 0x30 || left != 0) return 0;
  p = c; left = cl;
  if (!sbc_der_read(&p, &left, &t, &q, &ql) || t != 0x02 || ql != 1 || q[0] != 0) return 0;
  if (!sbc_der_read(&p, &left, &t, &q, &ql) || t != 0x30) return 0;
  {
    const sbc_u8 *ap = q, *oid; size_t al = ql, oidl;
    if (!sbc_der_read(&ap, &al, &t, &oid, &oidl) || t != 0x06 || al != 0) return 0;
    if (sbc_oid_eq(oid, oidl, sbc_oid_ed25519, 3)) *kind = SBC_K_ED25519;
    else if (sbc_oid_eq(oid, oidl, sbc_oid_x25519, 3)) *kind = SBC_K_X25519;
    else return 0;
  }
  if (!sbc_der_read(&p, &left, &t, &q, &ql) || t != 0x04) return 0;
  {
    const sbc_u8 *ip = q, *s; size_t il = ql, sl;
    if (!sbc_der_read(&ip, &il, &t, &s, &sl) || t != 0x04 || sl != 32 || il != 0) return 0;
    *seed = s;
  }
  return 1;
}

static uint32_t sbc_bitlen(const sbc_u8* d, size_t n) {
  while (n > 0 && *d == 0) { d++; n--; }
  if (n == 0) return 0;
  uint32_t bits = (uint32_t)(n * 8);
  for (sbc_u8 top = d[0]; !(top & 0x80); top = (sbc_u8)(top << 1)) bits--;
  return bits;
}

typedef struct {
  const sbc_u8 *n, *e, *d, *p, *q, *dp, *dq, *qi;
  size_t nl, el, dl, pl, ql, dpl, dql, qil;
} sbc_rsa_fields;
static int sbc_rsa_parse_pkcs8(const sbc_u8* der, size_t len, sbc_rsa_fields* k) {
  const sbc_u8 *p = der, *c, *q;
  size_t left = len, cl, ql;
  sbc_u8 t;
  if (!sbc_der_read(&p, &left, &t, &c, &cl) || t != 0x30 || left != 0) return 0;
  p = c; left = cl;
  if (!sbc_der_read(&p, &left, &t, &q, &ql) || t != 0x02 || ql != 1 || q[0] != 0) return 0;
  if (!sbc_der_read(&p, &left, &t, &q, &ql) || t != 0x30) return 0;
  {
    const sbc_u8 *ap = q, *oid; size_t al = ql, oidl;
    if (!sbc_der_read(&ap, &al, &t, &oid, &oidl) || t != 0x06 || !sbc_oid_eq(oid, oidl, sbc_oid_rsa, sizeof sbc_oid_rsa)) return 0;
  }
  if (!sbc_der_read(&p, &left, &t, &q, &ql) || t != 0x04) return 0;
  {
    const sbc_u8 *sp = q; size_t sl = ql;
    if (!sbc_der_read(&sp, &sl, &t, &c, &cl) || t != 0x30 || sl != 0) return 0;
    sp = c; sl = cl;
    if (!sbc_der_read(&sp, &sl, &t, &q, &ql) || t != 0x02 || ql != 1 || q[0] != 0) return 0;
    const sbc_u8** f[8] = { &k->n, &k->e, &k->d, &k->p, &k->q, &k->dp, &k->dq, &k->qi };
    size_t* fl[8] = { &k->nl, &k->el, &k->dl, &k->pl, &k->ql, &k->dpl, &k->dql, &k->qil };
    for (int i = 0; i < 8; i++) {
      if (!sbc_der_read(&sp, &sl, &t, f[i], fl[i]) || t != 0x02 || *fl[i] == 0 || ((*f[i])[0] & 0x80)) return 0;
      sbc_strip(f[i], fl[i]);
    }
  }
  if (sbc_bitlen(k->n, k->nl) < 512 || sbc_bitlen(k->n, k->nl) > 4096) return 0;
  return 1;
}
static void sbc_rsa_bear_key(const sbc_rsa_fields* k, br_rsa_private_key* sk) {
  sk->n_bitlen = sbc_bitlen(k->n, k->nl);
  sk->p = (sbc_u8*)k->p; sk->plen = k->pl; sk->q = (sbc_u8*)k->q; sk->qlen = k->ql;
  sk->dp = (sbc_u8*)k->dp; sk->dplen = k->dpl; sk->dq = (sbc_u8*)k->dq; sk->dqlen = k->dql;
  sk->iq = (sbc_u8*)k->qi; sk->iqlen = k->qil;
}

static int sbc_decode(int pkcs8, const sbc_u8* der, size_t len, sbc_buf* out) {
  int kind = 0, curve = 0;
  if (!pkcs8) {
    const sbc_u8* key; size_t kl;
    if (!sbc_spki_parse(der, len, &kind, &curve, &key, &kl)) return SBC_DATA;
    sbc_put1(out, (sbc_u8)kind); sbc_put1(out, (sbc_u8)curve); sbc_put1(out, 0);
    if (kind == SBC_K_RSA) {
      const sbc_u8 *p = key, *c, *n, *e; size_t left = kl, cl, nl, el; sbc_u8 t;
      if (!sbc_der_read(&p, &left, &t, &c, &cl) || t != 0x30 || left != 0) return SBC_DATA;
      p = c; left = cl;
      if (!sbc_der_read(&p, &left, &t, &n, &nl) || t != 0x02 || !sbc_der_read(&p, &left, &t, &e, &el) || t != 0x02 || left != 0) return SBC_DATA;
      sbc_strip(&n, &nl); sbc_strip(&e, &el);
      if (nl == 0 || el == 0 || (n[0] & 0x80 && 0)) return SBC_DATA;
      sbc_field(out, n, nl); sbc_field(out, e, el);
    } else {
      sbc_field(out, key, kl);
    }
    return SBC_OK;
  }
  {
    const sbc_u8* seed;
    if (sbc_pkcs8_okp(der, len, &kind, &seed)) {
      sbc_u8 sk[64], pk[32], s[32];
      memcpy(s, seed, 32);
      if (kind == SBC_K_ED25519) crypto_ed25519_key_pair(sk, pk, s);
      else crypto_x25519_public_key(pk, seed);
      sbc_put1(out, (sbc_u8)kind); sbc_put1(out, 0); sbc_put1(out, 1);
      sbc_field(out, pk, 32); sbc_field(out, seed, 32);
      return SBC_OK;
    }
  }
  {
    sbc_rsa_fields k;
    if (sbc_rsa_parse_pkcs8(der, len, &k)) {
      sbc_put1(out, SBC_K_RSA); sbc_put1(out, 0); sbc_put1(out, 1);
      sbc_field(out, k.n, k.nl); sbc_field(out, k.e, k.el); sbc_field(out, k.d, k.dl);
      sbc_field(out, k.p, k.pl); sbc_field(out, k.q, k.ql);
      sbc_field(out, k.dp, k.dpl); sbc_field(out, k.dq, k.dql); sbc_field(out, k.qi, k.qil);
      return SBC_OK;
    }
  }
  {
    br_skey_decoder_context* dc = (br_skey_decoder_context*)malloc(sizeof *dc);
    if (!dc) return SBC_OPERATION;
    br_skey_decoder_init(dc);
    br_skey_decoder_push(dc, der, len);
    int ty = br_skey_decoder_key_type(dc);
    int rc = SBC_DATA;
    if (ty == BR_KEYTYPE_EC) {
      const br_ec_private_key* sk = br_skey_decoder_get_ec(dc);
      int cv = sbc_curve_from_br(sk->curve);
      if (cv) {
        sbc_u8 pub[133];
        br_ec_public_key pk;
        if (br_ec_compute_pub(br_ec_get_default(), &pk, pub, sk) != 0) {
          sbc_put1(out, SBC_K_EC); sbc_put1(out, (sbc_u8)cv); sbc_put1(out, 1);
          sbc_field(out, pk.q, pk.qlen);

          size_t fs = sbc_curve_size(cv);
          sbc_u8 d[66]; const sbc_u8* xs = sk->x; size_t xl = sk->xlen;
          while (xl > fs && *xs == 0) { xs++; xl--; }
          if (xl <= fs) {
            memset(d, 0, fs - xl); memcpy(d + fs - xl, xs, xl);
            sbc_field(out, d, fs);
            rc = SBC_OK;
          }
        }
      }
    }
    free(dc);
    return rc;
  }
}

static int sbc_encode(int pkcs8, int kind, int curve, const sbc_u8* f, size_t fl, sbc_buf* out) {
  const sbc_u8 *a, *b, *c, *d, *e, *g, *h, *i;
  size_t al, bl, cl, dl, el, gl, hl, il;
  const sbc_u8* p = f; size_t left = fl;
  if (kind == SBC_K_RSA) {
    if (!sbc_next(&p, &left, &a, &al) || !sbc_next(&p, &left, &b, &bl)) return SBC_DATA;
    sbc_strip(&a, &al); sbc_strip(&b, &bl);
    if (!pkcs8) {
      sbc_buf alg = {0}, key = {0}, seq = {0};
      sbc_alg_rsa(&alg);
      sbc_der_uint(&seq, a, al); sbc_der_uint(&seq, b, bl);
      sbc_der_tlv(&key, 0x30, seq.p, seq.n);
      sbc_spki_build(out, &alg, key.p, key.n);
      free(alg.p); free(key.p); free(seq.p);
      return SBC_OK;
    }
    if (!sbc_next(&p, &left, &c, &cl) || !sbc_next(&p, &left, &d, &dl) || !sbc_next(&p, &left, &e, &el) ||
        !sbc_next(&p, &left, &g, &gl) || !sbc_next(&p, &left, &h, &hl) || !sbc_next(&p, &left, &i, &il)) return SBC_DATA;
    br_rsa_private_key sk; br_rsa_public_key pk;
    sbc_strip(&d, &dl); sbc_strip(&e, &el); sbc_strip(&g, &gl); sbc_strip(&h, &hl); sbc_strip(&i, &il);

    uint32_t bits = (uint32_t)(al * 8);
    { sbc_u8 top = a[0]; while (!(top & 0x80)) { bits--; top = (sbc_u8)(top << 1); } }
    sk.n_bitlen = bits;
    sk.p = (sbc_u8*)d; sk.plen = dl; sk.q = (sbc_u8*)e; sk.qlen = el;
    sk.dp = (sbc_u8*)g; sk.dplen = gl; sk.dq = (sbc_u8*)h; sk.dqlen = hl; sk.iq = (sbc_u8*)i; sk.iqlen = il;
    pk.n = (sbc_u8*)a; pk.nlen = al; pk.e = (sbc_u8*)b; pk.elen = bl;
    size_t need = br_encode_rsa_pkcs8_der(0, &sk, &pk, c, cl);
    sbc_u8* dst = (sbc_u8*)malloc(need);
    if (!dst) return SBC_OPERATION;
    br_encode_rsa_pkcs8_der(dst, &sk, &pk, c, cl);
    sbc_put(out, dst, need);
    free(dst);
    return SBC_OK;
  }
  if (kind == SBC_K_EC) {
    size_t fs = sbc_curve_size(curve);
    if (!fs || !sbc_next(&p, &left, &a, &al)) return SBC_DATA;
    if (!pkcs8) {
      if (al != 1 + 2 * fs || a[0] != 4) return SBC_DATA;
      sbc_buf alg = {0};
      sbc_alg_ec(&alg, curve);
      sbc_spki_build(out, &alg, a, al);
      free(alg.p);
      return SBC_OK;
    }
    if (!sbc_next(&p, &left, &b, &bl) || bl != fs) return SBC_DATA;
    br_ec_private_key sk; br_ec_public_key pk;
    sk.curve = sbc_curve_br(curve); sk.x = (sbc_u8*)b; sk.xlen = bl;
    pk.curve = sk.curve; pk.q = (sbc_u8*)a; pk.qlen = al;
    size_t need = br_encode_ec_pkcs8_der(0, &sk, &pk);
    sbc_u8* dst = (sbc_u8*)malloc(need);
    if (!dst) return SBC_OPERATION;
    br_encode_ec_pkcs8_der(dst, &sk, &pk);
    sbc_put(out, dst, need);
    free(dst);
    return SBC_OK;
  }
  if (kind == SBC_K_ED25519 || kind == SBC_K_X25519) {
    const sbc_u8* oid = kind == SBC_K_ED25519 ? sbc_oid_ed25519 : sbc_oid_x25519;
    if (!sbc_next(&p, &left, &a, &al) || al != 32) return SBC_DATA;
    sbc_buf alg = {0};
    sbc_der_tlv(&alg, 0x06, oid, 3);
    if (!pkcs8) { sbc_spki_build(out, &alg, a, al); free(alg.p); return SBC_OK; }
    if (!sbc_next(&p, &left, &b, &bl) || bl != 32) { free(alg.p); return SBC_DATA; }
    sbc_buf inner = {0}, wrap = {0}, body = {0};
    sbc_der_tlv(&inner, 0x04, b, 32);
    sbc_der_tlv(&wrap, 0x04, inner.p, inner.n);
    sbc_put1(&body, 0x02); sbc_put1(&body, 1); sbc_put1(&body, 0);
    sbc_der_tlv(&body, 0x30, alg.p, alg.n);
    sbc_put(&body, wrap.p, wrap.n);
    sbc_der_tlv(out, 0x30, body.p, body.n);
    free(alg.p); free(inner.p); free(wrap.p); free(body.p);
    return SBC_OK;
  }
  return SBC_NOTSUP;
}

static void sbc_hmac(int bits, const sbc_u8* key, size_t kl, const sbc_u8* m, size_t ml, sbc_u8* out) {
  br_hmac_key_context kc; br_hmac_context hc;
  br_hmac_key_init(&kc, sbc_hash(bits), key, kl);
  br_hmac_init(&hc, &kc, 0);
  br_hmac_update(&hc, m, ml);
  br_hmac_out(&hc, out);
}

static int sbc_pbkdf2(int bits, const sbc_u8* pw, size_t pl, const sbc_u8* salt, size_t sl, uint32_t iters, sbc_u8* out, size_t len) {
  size_t hl = sbc_hlen(bits);
  br_hmac_key_context kc;
  br_hmac_key_init(&kc, sbc_hash(bits), pw, pl);
  sbc_u8 u[64], t[64];
  for (uint32_t blk = 1; len > 0; blk++) {
    br_hmac_context hc;
    sbc_u8 be[4] = { (sbc_u8)(blk >> 24), (sbc_u8)(blk >> 16), (sbc_u8)(blk >> 8), (sbc_u8)blk };
    br_hmac_init(&hc, &kc, 0); br_hmac_update(&hc, salt, sl); br_hmac_update(&hc, be, 4); br_hmac_out(&hc, u);
    memcpy(t, u, hl);
    for (uint32_t i = 1; i < iters; i++) {
      br_hmac_init(&hc, &kc, 0); br_hmac_update(&hc, u, hl); br_hmac_out(&hc, u);
      for (size_t j = 0; j < hl; j++) t[j] ^= u[j];
    }
    size_t n = len < hl ? len : hl;
    memcpy(out, t, n); out += n; len -= n;
  }
  return 1;
}

static int sbc_hkdf(int bits, const sbc_u8* ikm, size_t il, const sbc_u8* salt, size_t sl, const sbc_u8* info, size_t nl, sbc_u8* out, size_t len) {
  br_hkdf_context hc;
  br_hkdf_init(&hc, sbc_hash(bits), salt, sl);
  br_hkdf_inject(&hc, ikm, il);
  br_hkdf_flip(&hc);
  br_hkdf_produce(&hc, info, nl, out, len);
  return 1;
}

static int sbc_load_rsa_public(const sbc_u8* der, size_t len, br_rsa_public_key* pk) {
  int kind, curve; const sbc_u8* key; size_t kl;
  if (!sbc_spki_parse(der, len, &kind, &curve, &key, &kl) || kind != SBC_K_RSA) return 0;
  const sbc_u8 *p = key, *c, *n, *e; size_t left = kl, cl, nl, el; sbc_u8 t;
  if (!sbc_der_read(&p, &left, &t, &c, &cl) || t != 0x30) return 0;
  p = c; left = cl;
  if (!sbc_der_read(&p, &left, &t, &n, &nl) || t != 0x02 || !sbc_der_read(&p, &left, &t, &e, &el) || t != 0x02) return 0;
  sbc_strip(&n, &nl); sbc_strip(&e, &el);
  pk->n = (sbc_u8*)n; pk->nlen = nl; pk->e = (sbc_u8*)e; pk->elen = el;
  return 1;
}

static int sbc_rsa_pkcs1_sign(int bits, const sbc_u8* key, size_t kl, const sbc_u8* m, size_t ml, sbc_buf* out) {
  sbc_rsa_fields kf; br_rsa_private_key skv; const br_rsa_private_key* sk = &skv;
  if (!sbc_rsa_parse_pkcs8(key, kl, &kf)) return SBC_DATA;
  sbc_rsa_bear_key(&kf, &skv);
  sbc_u8 h[64], x[512];
  size_t xl = (sk->n_bitlen + 7) / 8;
  int rc = SBC_OPERATION;
  if (xl <= sizeof x && sbc_digest(bits, m, ml, h) &&
      br_rsa_pkcs1_sign_get_default()(sbc_hash_oid(bits), h, sbc_hlen(bits), sk, x)) {
    sbc_put(out, x, xl); rc = SBC_OK;
  }
  return rc;
}
static int sbc_rsa_pkcs1_verify(int bits, const sbc_u8* key, size_t kl, const sbc_u8* sig, size_t sl, const sbc_u8* m, size_t ml, int* ok) {
  br_rsa_public_key pk;
  *ok = 0;
  if (!sbc_load_rsa_public(key, kl, &pk)) return SBC_DATA;
  sbc_u8 h[64], x[512], got[64];
  if (sl != pk.nlen || sl > sizeof x) return SBC_OK;
  memcpy(x, sig, sl);
  if (!sbc_digest(bits, m, ml, h)) return SBC_NOTSUP;
  if (br_rsa_pkcs1_vrfy_get_default()(x, sl, sbc_hash_oid(bits), sbc_hlen(bits), &pk, got) && sbc_ct_eq(got, h, sbc_hlen(bits))) *ok = 1;
  return SBC_OK;
}

static void sbc_mgf1_xor(int bits, const sbc_u8* seed, size_t sl, sbc_u8* out, size_t len) {
  sbc_u8 h[64];
  size_t hl = sbc_hlen(bits);
  const br_hash_class* hc = sbc_hash(bits);
  for (uint32_t ctr = 0; len > 0; ctr++) {
    br_hash_compat_context ctx;
    sbc_u8 be[4] = { (sbc_u8)(ctr >> 24), (sbc_u8)(ctr >> 16), (sbc_u8)(ctr >> 8), (sbc_u8)ctr };
    hc->init(&ctx.vtable); hc->update(&ctx.vtable, seed, sl); hc->update(&ctx.vtable, be, 4); hc->out(&ctx.vtable, h);
    size_t n = len < hl ? len : hl;
    for (size_t i = 0; i < n; i++) out[i] ^= h[i];
    out += n; len -= n;
  }
}

static void sbc_pss_h(int bits, const sbc_u8* mh, const sbc_u8* salt, size_t saltlen, sbc_u8* out) {
  const br_hash_class* hc = sbc_hash(bits);
  br_hash_compat_context ctx;
  sbc_u8 zero[8] = {0};
  hc->init(&ctx.vtable); hc->update(&ctx.vtable, zero, 8); hc->update(&ctx.vtable, mh, sbc_hlen(bits)); hc->update(&ctx.vtable, salt, saltlen); hc->out(&ctx.vtable, out);
}

static int sbc_rsa_pss_sign(int bits, size_t saltlen, const sbc_u8* key, size_t kl, const sbc_u8* m, size_t ml, sbc_buf* out) {
  sbc_rsa_fields kf; br_rsa_private_key skv; const br_rsa_private_key* sk = &skv;
  if (!sbc_rsa_parse_pkcs8(key, kl, &kf)) return SBC_DATA;
  sbc_rsa_bear_key(&kf, &skv);
  int rc = SBC_OPERATION;
  size_t k = (sk->n_bitlen + 7) / 8, emBits = sk->n_bitlen - 1, emLen = (emBits + 7) / 8, hl = sbc_hlen(bits);
  sbc_u8 x[512], mh[64], salt[512], hh[64];
  if (k <= sizeof x && saltlen <= sizeof salt && emLen >= hl + saltlen + 2 && sbc_digest(bits, m, ml, mh) &&
      (saltlen == 0 || sbc_rand(salt, saltlen))) {
    memset(x, 0, sizeof x);
    sbc_u8* em = x + (k - emLen);
    size_t dbl = emLen - hl - 1;
    sbc_pss_h(bits, mh, salt, saltlen, hh);
    em[dbl - saltlen - 1] = 1;
    memcpy(em + dbl - saltlen, salt, saltlen);
    sbc_mgf1_xor(bits, hh, hl, em, dbl);
    em[0] &= (sbc_u8)(0xff >> (8 * emLen - emBits));
    memcpy(em + dbl, hh, hl);
    em[emLen - 1] = 0xbc;
    if (br_rsa_private_get_default()(x, sk)) { sbc_put(out, x, k); rc = SBC_OK; }
  }
  return rc;
}
static int sbc_rsa_pss_verify(int bits, size_t saltlen, const sbc_u8* key, size_t kl, const sbc_u8* sig, size_t sl, const sbc_u8* m, size_t ml, int* ok) {
  br_rsa_public_key pk;
  *ok = 0;
  if (!sbc_load_rsa_public(key, kl, &pk)) return SBC_DATA;
  size_t k = pk.nlen, hl = sbc_hlen(bits);
  sbc_u8 x[512], mh[64], hh[64], db[512];
  if (sl != k || k > sizeof x) return SBC_OK;

  uint32_t nbits = (uint32_t)(k * 8);
  { sbc_u8 top = pk.n[0]; while (top && !(top & 0x80)) { nbits--; top = (sbc_u8)(top << 1); } }
  size_t emBits = nbits - 1, emLen = (emBits + 7) / 8;
  memcpy(x, sig, sl);
  if (!br_rsa_public_get_default()(x, k, &pk)) return SBC_OK;
  if (!sbc_digest(bits, m, ml, mh)) return SBC_NOTSUP;
  if (emLen < hl + saltlen + 2) return SBC_OK;
  const sbc_u8* em = x + (k - emLen);
  if (k > emLen && x[0] != 0) return SBC_OK;
  if (em[emLen - 1] != 0xbc) return SBC_OK;
  size_t dbl = emLen - hl - 1;
  if (dbl > sizeof db) return SBC_OK;
  memcpy(db, em, dbl);
  if (db[0] & (sbc_u8)~(0xff >> (8 * emLen - emBits))) return SBC_OK;
  sbc_mgf1_xor(bits, em + dbl, hl, db, dbl);
  db[0] &= (sbc_u8)(0xff >> (8 * emLen - emBits));
  size_t ps = dbl - saltlen - 1;
  for (size_t i = 0; i < ps; i++) if (db[i] != 0) return SBC_OK;
  if (db[ps] != 1) return SBC_OK;
  sbc_pss_h(bits, mh, db + ps + 1, saltlen, hh);
  if (sbc_ct_eq(hh, em + dbl, hl)) *ok = 1;
  return SBC_OK;
}

static int sbc_rsa_keygen(unsigned modbits, uint32_t pubexp, sbc_buf* out) {
  if (modbits < 512 || modbits > 4096 || (pubexp != 3 && pubexp != 65537)) return SBC_NOTSUP;
  br_rsa_private_key sk; br_rsa_public_key pk;
  sbc_u8 kpriv[BR_RSA_KBUF_PRIV_SIZE(4096)], kpub[BR_RSA_KBUF_PUB_SIZE(4096)];
  br_rsa_keygen kg = br_rsa_keygen_get_default();
  if (!kg(&sbc_prng, &sk, kpriv, &pk, kpub, modbits, pubexp)) return SBC_OPERATION;
  size_t dl = br_rsa_compute_privexp_get_default()(0, &sk, pubexp);
  sbc_u8* d = (sbc_u8*)malloc(dl ? dl : 1);
  if (!d) return SBC_OPERATION;
  br_rsa_compute_privexp_get_default()(d, &sk, pubexp);
  size_t need = br_encode_rsa_pkcs8_der(0, &sk, &pk, d, dl);
  sbc_u8* dst = (sbc_u8*)malloc(need);
  if (dst) { br_encode_rsa_pkcs8_der(dst, &sk, &pk, d, dl); sbc_put(out, dst, need); }
  free(dst); free(d);
  memset(kpriv, 0, sizeof kpriv);
  return dst ? SBC_OK : SBC_OPERATION;
}

static int sbc_ec_load_private(const sbc_u8* der, size_t len, br_skey_decoder_context** dcp, const br_ec_private_key** sk) {
  br_skey_decoder_context* dc = (br_skey_decoder_context*)malloc(sizeof *dc);
  if (!dc) return SBC_OPERATION;
  br_skey_decoder_init(dc);
  br_skey_decoder_push(dc, der, len);
  *sk = br_skey_decoder_get_ec(dc);
  if (!*sk || !sbc_curve_from_br((*sk)->curve)) { free(dc); return SBC_DATA; }
  *dcp = dc;
  return SBC_OK;
}
static int sbc_ecdsa_sign(int bits, const sbc_u8* key, size_t kl, const sbc_u8* m, size_t ml, sbc_buf* out) {
  br_skey_decoder_context* dc; const br_ec_private_key* sk;
  int rc = sbc_ec_load_private(key, kl, &dc, &sk);
  if (rc != SBC_OK) return rc;
  sbc_u8 h[64], sig[132];
  rc = SBC_OPERATION;
  if (sbc_digest(bits, m, ml, h)) {
    size_t n = br_ecdsa_sign_raw_get_default()(br_ec_get_default(), sbc_hash(bits), h, sk, sig);
    if (n) { sbc_put(out, sig, n); rc = SBC_OK; }
  }
  free(dc);
  return rc;
}
static int sbc_ecdsa_verify(int bits, int curve, const sbc_u8* point, size_t pl, const sbc_u8* sig, size_t sl, const sbc_u8* m, size_t ml, int* ok) {
  *ok = 0;
  size_t fs = sbc_curve_size(curve);
  if (!fs || pl != 1 + 2 * fs || point[0] != 4) return SBC_DATA;
  sbc_u8 h[64];
  if (!sbc_digest(bits, m, ml, h)) return SBC_NOTSUP;
  if (sl != 2 * fs) return SBC_OK;
  br_ec_public_key pk;
  pk.curve = sbc_curve_br(curve); pk.q = (sbc_u8*)point; pk.qlen = pl;
  if (br_ecdsa_vrfy_raw_get_default()(br_ec_get_default(), h, sbc_hlen(bits), &pk, sig, sl)) *ok = 1;
  return SBC_OK;
}

static int sbc_ec_point_ok(int curve, const sbc_u8* point, size_t pl) {
  size_t fs = sbc_curve_size(curve);
  if (!fs || pl != 1 + 2 * fs || point[0] != 4) return 0;
  sbc_u8 q[133];
  memcpy(q, point, pl);
  sbc_u8 one[1] = { 1 };
  return br_ec_get_default()->mul(q, pl, one, 1, sbc_curve_br(curve)) != 0;
}
static int sbc_ec_keygen(int curve, sbc_buf* out) {
  br_ec_private_key sk; br_ec_public_key pk;
  sbc_u8 kb[BR_EC_KBUF_PRIV_MAX_SIZE], pb[BR_EC_KBUF_PUB_MAX_SIZE];
  const br_ec_impl* impl = br_ec_get_default();
  if (!br_ec_keygen(&sbc_prng, impl, &sk, kb, sbc_curve_br(curve))) return SBC_OPERATION;
  if (!br_ec_compute_pub(impl, &pk, pb, &sk)) return SBC_OPERATION;
  size_t need = br_encode_ec_pkcs8_der(0, &sk, &pk);
  sbc_u8* dst = (sbc_u8*)malloc(need);
  if (!dst) return SBC_OPERATION;
  br_encode_ec_pkcs8_der(dst, &sk, &pk);
  sbc_put(out, dst, need);
  free(dst);
  memset(kb, 0, sizeof kb);
  return SBC_OK;
}

static int sbc_aes_key_ok(size_t kl) { return kl == 16 || kl == 24 || kl == 32; }

static void sbc_aes_block(int enc, const sbc_u8* key, size_t kl, const sbc_u8* in, sbc_u8* out) {
  sbc_u8 iv[16] = {0};
  memcpy(out, in, 16);
  if (enc) { br_aes_ct_cbcenc_keys c; br_aes_ct_cbcenc_init(&c, key, kl); br_aes_ct_cbcenc_run(&c, iv, out, 16); }
  else { br_aes_ct_cbcdec_keys c; br_aes_ct_cbcdec_init(&c, key, kl); br_aes_ct_cbcdec_run(&c, iv, out, 16); }
}

static int sbc_gcm(int enc, size_t tagbits, const sbc_u8* key, size_t kl, const sbc_u8* iv, size_t ivl,
                   const sbc_u8* in, size_t il, const sbc_u8* aad, size_t al, sbc_buf* out) {
  size_t tl = tagbits / 8;
  if (!sbc_aes_key_ok(kl) || ivl == 0 || tagbits < 32 || tagbits > 128 || tagbits % 8) return SBC_OPERATION;
  size_t dl = il;
  if (!enc) { if (il < tl) return SBC_OPERATION; dl = il - tl; }
  sbc_u8* buf = (sbc_u8*)malloc(dl ? dl : 1);
  if (!buf) return SBC_OPERATION;
  memcpy(buf, in, dl);
  br_aes_ct_ctr_keys bc; br_gcm_context gc;
  br_aes_ct_ctr_init(&bc, key, kl);
  br_gcm_init(&gc, &bc.vtable, br_ghash_ctmul);
  br_gcm_reset(&gc, iv, ivl);
  br_gcm_aad_inject(&gc, aad, al);
  br_gcm_flip(&gc);
  br_gcm_run(&gc, enc, buf, dl);
  int rc = SBC_OK;
  if (enc) {
    sbc_u8 tag[16];
    br_gcm_get_tag(&gc, tag);
    sbc_put(out, buf, dl); sbc_put(out, tag, tl);
  } else if (br_gcm_check_tag_trunc(&gc, in + dl, tl)) {
    sbc_put(out, buf, dl);
  } else rc = SBC_OPERATION;
  memset(buf, 0, dl);
  free(buf);
  return rc;
}

static int sbc_cbc(int enc, const sbc_u8* key, size_t kl, const sbc_u8* iv, size_t ivl, const sbc_u8* in, size_t il, sbc_buf* out) {
  if (!sbc_aes_key_ok(kl) || ivl != 16) return SBC_OPERATION;
  sbc_u8 v[16];
  memcpy(v, iv, 16);
  if (enc) {
    size_t pad = 16 - il % 16, total = il + pad;
    sbc_u8* buf = (sbc_u8*)malloc(total);
    if (!buf) return SBC_OPERATION;
    memcpy(buf, in, il); memset(buf + il, (int)pad, pad);
    br_aes_ct_cbcenc_keys c;
    br_aes_ct_cbcenc_init(&c, key, kl); br_aes_ct_cbcenc_run(&c, v, buf, total);
    sbc_put(out, buf, total); free(buf);
    return SBC_OK;
  }
  if (il == 0 || il % 16) return SBC_OPERATION;
  sbc_u8* buf = (sbc_u8*)malloc(il);
  if (!buf) return SBC_OPERATION;
  memcpy(buf, in, il);
  br_aes_ct_cbcdec_keys c;
  br_aes_ct_cbcdec_init(&c, key, kl); br_aes_ct_cbcdec_run(&c, v, buf, il);

  sbc_u8 pad = buf[il - 1];
  unsigned bad = (pad == 0) | (pad > 16);
  for (size_t i = 0; i < 16 && i < il; i++) bad |= (i < pad) & (buf[il - 1 - i] != pad);
  int rc = SBC_OPERATION;
  if (!bad) { sbc_put(out, buf, il - pad); rc = SBC_OK; }
  memset(buf, 0, il);
  free(buf);
  return rc;
}

static void sbc_ctr_inc(sbc_u8* ctr, unsigned bits) {
  unsigned carry = 1, left = bits;
  for (int i = 15; i >= 0 && left > 0; i--) {
    unsigned take = left >= 8 ? 8 : left;
    unsigned m = (1u << take) - 1;
    unsigned v = (ctr[i] & m) + carry;
    carry = v > m;
    ctr[i] = (sbc_u8)((ctr[i] & ~m) | (v & m));
    left -= take;
  }
}

static int sbc_ctr(const sbc_u8* key, size_t kl, const sbc_u8* ctr, size_t cl, unsigned bits, const sbc_u8* in, size_t il, sbc_buf* out) {
  if (!sbc_aes_key_ok(kl) || cl != 16 || bits < 1 || bits > 128) return SBC_OPERATION;
  size_t blocks = (il + 15) / 16;
  if (bits < 64 && blocks > ((size_t)1 << bits)) return SBC_OPERATION;
  sbc_u8 c[16], ks[16];
  memcpy(c, ctr, 16);
  br_aes_ct_cbcenc_keys ek;
  br_aes_ct_cbcenc_init(&ek, key, kl);
  for (size_t off = 0; off < il; off += 16) {
    sbc_u8 iv[16] = {0};
    memcpy(ks, c, 16);
    br_aes_ct_cbcenc_run(&ek, iv, ks, 16);
    size_t n = il - off < 16 ? il - off : 16;
    for (size_t j = 0; j < n; j++) sbc_put1(out, (sbc_u8)(in[off + j] ^ ks[j]));
    sbc_ctr_inc(c, bits);
  }
  return SBC_OK;
}

static int sbc_kw(int wrap, const sbc_u8* key, size_t kl, const sbc_u8* in, size_t il, sbc_buf* out) {
  if (!sbc_aes_key_ok(kl)) return SBC_OPERATION;
  size_t n;
  sbc_u8 a[8], b[16];
  if (wrap) {
    if (il < 16 || il % 8) return SBC_OPERATION;
    n = il / 8;
    sbc_u8* r = (sbc_u8*)malloc(il);
    if (!r) return SBC_OPERATION;
    memcpy(r, in, il);
    memset(a, 0xa6, 8);
    for (unsigned j = 0; j < 6; j++)
      for (size_t i = 0; i < n; i++) {
        memcpy(b, a, 8); memcpy(b + 8, r + 8 * i, 8);
        sbc_aes_block(1, key, kl, b, b);
        uint64_t t = (uint64_t)n * j + i + 1;
        memcpy(a, b, 8);
        for (int k = 0; k < 8; k++) a[7 - k] ^= (sbc_u8)(t >> (8 * k));
        memcpy(r + 8 * i, b + 8, 8);
      }
    sbc_put(out, a, 8); sbc_put(out, r, il);
    free(r);
    return SBC_OK;
  }
  if (il < 24 || il % 8) return SBC_OPERATION;
  n = il / 8 - 1;
  sbc_u8* r = (sbc_u8*)malloc(il);
  if (!r) return SBC_OPERATION;
  memcpy(a, in, 8); memcpy(r, in + 8, il - 8);
  for (int j = 5; j >= 0; j--)
    for (size_t i = n; i >= 1; i--) {
      uint64_t t = (uint64_t)n * (unsigned)j + i;
      memcpy(b, a, 8);
      for (int k = 0; k < 8; k++) b[7 - k] ^= (sbc_u8)(t >> (8 * k));
      memcpy(b + 8, r + 8 * (i - 1), 8);
      sbc_aes_block(0, key, kl, b, b);
      memcpy(a, b, 8); memcpy(r + 8 * (i - 1), b + 8, 8);
    }
  sbc_u8 iv[8]; memset(iv, 0xa6, 8);
  int rc = SBC_OPERATION;
  if (sbc_ct_eq(a, iv, 8)) { sbc_put(out, r, il - 8); rc = SBC_OK; }
  free(r);
  return rc;
}

static int sbc_ecdh(int curve, const sbc_u8* pkcs8, size_t kl, const sbc_u8* peer, size_t pl, sbc_buf* out) {
  br_skey_decoder_context* dc; const br_ec_private_key* sk;
  int rc = sbc_ec_load_private(pkcs8, kl, &dc, &sk);
  if (rc != SBC_OK) return rc;
  size_t fs = sbc_curve_size(curve);
  rc = SBC_OPERATION;
  if (sk->curve == sbc_curve_br(curve) && fs && pl == 1 + 2 * fs && peer[0] == 4) {
    sbc_u8 pt[133];
    memcpy(pt, peer, pl);
    if (br_ec_get_default()->mul(pt, pl, sk->x, sk->xlen, sk->curve)) {
      size_t xl; size_t xo = br_ec_get_default()->xoff(sk->curve, &xl);
      sbc_put(out, pt + xo, xl); rc = SBC_OK;
    }
  }
  free(dc);
  return rc;
}
static int sbc_x25519(const sbc_u8* seed, size_t sl, const sbc_u8* peer, size_t pl, sbc_buf* out) {
  if (sl != 32 || pl != 32) return SBC_OPERATION;
  sbc_u8 shared[32], zero[32] = {0};
  crypto_x25519(shared, seed, peer);

  if (sbc_ct_eq(shared, zero, 32)) return SBC_OPERATION;
  sbc_put(out, shared, 32);
  return SBC_OK;
}

static int sbc_oaep(int enc, int bits, const sbc_u8* key, size_t kl, const sbc_u8* label, size_t ll, const sbc_u8* in, size_t il, sbc_buf* out) {
  const br_hash_class* hc = sbc_hash(bits);
  if (!hc) return SBC_NOTSUP;
  if (enc) {
    br_rsa_public_key pk;
    if (!sbc_load_rsa_public(key, kl, &pk)) return SBC_DATA;
    sbc_u8 buf[512];
    if (pk.nlen > sizeof buf) return SBC_OPERATION;
    size_t n = br_rsa_oaep_encrypt_get_default()(&sbc_prng, hc, label, ll, &pk, buf, sizeof buf, in, il);
    if (!n) return SBC_OPERATION;
    sbc_put(out, buf, n);
    return SBC_OK;
  }
  sbc_rsa_fields kf; br_rsa_private_key sk;
  if (!sbc_rsa_parse_pkcs8(key, kl, &kf)) return SBC_DATA;
  sbc_rsa_bear_key(&kf, &sk);
  sbc_u8 buf[512];
  size_t k = (sk.n_bitlen + 7) / 8;
  if (il != k || k > sizeof buf) return SBC_OPERATION;
  memcpy(buf, in, il);
  size_t len = il;
  if (!br_rsa_oaep_decrypt_get_default()(hc, label, ll, &sk, buf, &len)) return SBC_OPERATION;
  sbc_put(out, buf, len);
  memset(buf, 0, sizeof buf);
  return SBC_OK;
}

#define SBC_OP_RSA_PKCS1_SIGN 1
#define SBC_OP_RSA_PKCS1_VERIFY 2
#define SBC_OP_RSA_PSS_SIGN 3
#define SBC_OP_RSA_PSS_VERIFY 4
#define SBC_OP_ECDSA_SIGN 5
#define SBC_OP_ECDSA_VERIFY 6
#define SBC_OP_ED_SIGN 7
#define SBC_OP_ED_VERIFY 8
#define SBC_OP_PBKDF2 9
#define SBC_OP_HKDF 10
#define SBC_OP_AES_GCM_ENC 11
#define SBC_OP_AES_GCM_DEC 12
#define SBC_OP_AES_CBC_ENC 13
#define SBC_OP_AES_CBC_DEC 14
#define SBC_OP_AES_CTR 15
#define SBC_OP_AES_KW_WRAP 16
#define SBC_OP_AES_KW_UNWRAP 17
#define SBC_OP_ECDH 18
#define SBC_OP_X25519 19
#define SBC_OP_DECODE_SPKI 20
#define SBC_OP_DECODE_PKCS8 21
#define SBC_OP_ENCODE_SPKI 22
#define SBC_OP_ENCODE_PKCS8 23
#define SBC_OP_OAEP_ENC 24
#define SBC_OP_OAEP_DEC 25
#define SBC_OP_RSA_KEYGEN 26
#define SBC_OP_EC_KEYGEN 27
#define SBC_OP_ED_KEYGEN 28
#define SBC_OP_ED_PUB 29
#define SBC_OP_EC_POINT_OK 30
#define SBC_OP_X25519_PUB 31

static int sbc_op(int op, const sbc_u8* a, size_t al, const sbc_u8* b, size_t bl, const sbc_u8* c, size_t cl,
                  const sbc_u8* d, size_t dl, sbc_u8** result, size_t* resultlen) {
  sbc_buf out = {0};
  int rc = SBC_NOTSUP, ok = 0;
  long p0 = sbc_param(a, al, 0), p1 = sbc_param(a, al, 1), p2 = sbc_param(a, al, 2);
  switch (op) {
    case SBC_OP_RSA_PKCS1_SIGN: rc = sbc_hash((int)p0) ? sbc_rsa_pkcs1_sign((int)p0, b, bl, c, cl, &out) : SBC_NOTSUP; break;
    case SBC_OP_RSA_PKCS1_VERIFY:
      rc = sbc_hash((int)p0) ? sbc_rsa_pkcs1_verify((int)p0, b, bl, c, cl, d, dl, &ok) : SBC_NOTSUP;
      if (rc == SBC_OK) sbc_put1(&out, (sbc_u8)ok);
      break;
    case SBC_OP_RSA_PSS_SIGN: rc = sbc_hash((int)p0) && p1 >= 0 ? sbc_rsa_pss_sign((int)p0, (size_t)p1, b, bl, c, cl, &out) : SBC_NOTSUP; break;
    case SBC_OP_RSA_PSS_VERIFY:
      rc = sbc_hash((int)p0) && p1 >= 0 ? sbc_rsa_pss_verify((int)p0, (size_t)p1, b, bl, c, cl, d, dl, &ok) : SBC_NOTSUP;
      if (rc == SBC_OK) sbc_put1(&out, (sbc_u8)ok);
      break;
    case SBC_OP_ECDSA_SIGN: rc = sbc_hash((int)p0) ? sbc_ecdsa_sign((int)p0, b, bl, c, cl, &out) : SBC_NOTSUP; break;
    case SBC_OP_ECDSA_VERIFY:
      rc = sbc_hash((int)p0) ? sbc_ecdsa_verify((int)p0, (int)p1, b, bl, c, cl, d, dl, &ok) : SBC_NOTSUP;
      if (rc == SBC_OK) sbc_put1(&out, (sbc_u8)ok);
      break;
    case SBC_OP_ED_SIGN: {
      if (bl != 32) { rc = SBC_DATA; break; }
      sbc_u8 sk[64], pk[32], seed[32], sig[64];
      memcpy(seed, b, 32);
      crypto_ed25519_key_pair(sk, pk, seed);
      crypto_ed25519_sign(sig, sk, c, cl);
      sbc_put(&out, sig, 64); rc = SBC_OK;
      break;
    }
    case SBC_OP_ED_VERIFY:
      if (bl != 32) { rc = SBC_DATA; break; }
      sbc_put1(&out, (sbc_u8)(cl == 64 && crypto_ed25519_check(c, b, d, dl) == 0));
      rc = SBC_OK;
      break;
    case SBC_OP_PBKDF2:
      if (!sbc_hash((int)p0) || p1 < 1 || p2 < 0 || p2 > 1048576) break;
      { sbc_u8* o = (sbc_u8*)malloc(p2 ? (size_t)p2 : 1);
        if (!o) { rc = SBC_OPERATION; break; }
        sbc_pbkdf2((int)p0, b, bl, c, cl, (uint32_t)p1, o, (size_t)p2);
        sbc_put(&out, o, (size_t)p2); free(o); rc = SBC_OK; }
      break;
    case SBC_OP_HKDF:
      if (!sbc_hash((int)p0) || p1 < 0 || p1 > 255 * (long)sbc_hlen((int)p0)) break;
      { sbc_u8* o = (sbc_u8*)malloc(p1 ? (size_t)p1 : 1);
        if (!o) { rc = SBC_OPERATION; break; }
        sbc_hkdf((int)p0, b, bl, c, cl, d, dl, o, (size_t)p1);
        sbc_put(&out, o, (size_t)p1); free(o); rc = SBC_OK; }
      break;
    case SBC_OP_AES_GCM_ENC:
    case SBC_OP_AES_GCM_DEC: {

      const sbc_u8 *dp = d, *data, *aad; size_t dleft = dl, datal, aadl;
      if (p0 < 0 || !sbc_next(&dp, &dleft, &data, &datal) || !sbc_next(&dp, &dleft, &aad, &aadl)) break;
      rc = sbc_gcm(op == SBC_OP_AES_GCM_ENC, (size_t)p0, b, bl, c, cl, data, datal, aad, aadl, &out);
      break;
    }
    case SBC_OP_AES_CBC_ENC: rc = sbc_cbc(1, b, bl, c, cl, d, dl, &out); break;
    case SBC_OP_AES_CBC_DEC: rc = sbc_cbc(0, b, bl, c, cl, d, dl, &out); break;
    case SBC_OP_AES_CTR: rc = p0 > 0 ? sbc_ctr(b, bl, c, cl, (unsigned)p0, d, dl, &out) : SBC_NOTSUP; break;
    case SBC_OP_AES_KW_WRAP: rc = sbc_kw(1, b, bl, d, dl, &out); break;
    case SBC_OP_AES_KW_UNWRAP: rc = sbc_kw(0, b, bl, d, dl, &out); break;
    case SBC_OP_ECDH: rc = sbc_ecdh((int)p0, b, bl, c, cl, &out); break;
    case SBC_OP_X25519: rc = sbc_x25519(b, bl, c, cl, &out); break;
    case SBC_OP_X25519_PUB: {
      if (bl != 32) { rc = SBC_DATA; break; }
      sbc_u8 pk[32];
      crypto_x25519_public_key(pk, b);
      sbc_put(&out, pk, 32); rc = SBC_OK;
      break;
    }
    case SBC_OP_OAEP_ENC: rc = sbc_oaep(1, (int)p0, b, bl, c, cl, d, dl, &out); break;
    case SBC_OP_OAEP_DEC: rc = sbc_oaep(0, (int)p0, b, bl, c, cl, d, dl, &out); break;
    case SBC_OP_DECODE_SPKI: rc = sbc_decode(0, b, bl, &out); break;
    case SBC_OP_DECODE_PKCS8: rc = sbc_decode(1, b, bl, &out); break;
    case SBC_OP_ENCODE_SPKI: rc = sbc_encode(0, (int)p0, (int)p1, b, bl, &out); break;
    case SBC_OP_ENCODE_PKCS8: rc = sbc_encode(1, (int)p0, (int)p1, b, bl, &out); break;
    case SBC_OP_RSA_KEYGEN: rc = p0 > 0 && p1 > 0 ? sbc_rsa_keygen((unsigned)p0, (uint32_t)p1, &out) : SBC_NOTSUP; break;
    case SBC_OP_EC_KEYGEN: rc = sbc_curve_br((int)p0) ? sbc_ec_keygen((int)p0, &out) : SBC_NOTSUP; break;
    case SBC_OP_ED_KEYGEN: {
      sbc_u8 seed[32];
      if (!sbc_rand(seed, 32)) { rc = SBC_OPERATION; break; }
      sbc_put(&out, seed, 32); memset(seed, 0, 32); rc = SBC_OK;
      break;
    }
    case SBC_OP_ED_PUB: {
      if (bl != 32) { rc = SBC_DATA; break; }
      sbc_u8 sk[64], pk[32], seed[32];
      memcpy(seed, b, 32);
      crypto_ed25519_key_pair(sk, pk, seed);
      sbc_put(&out, pk, 32); rc = SBC_OK;
      break;
    }
    case SBC_OP_EC_POINT_OK:
      sbc_put1(&out, (sbc_u8)sbc_ec_point_ok((int)p0, b, bl)); rc = SBC_OK;
      break;
  }
  if (out.bad) rc = SBC_OPERATION;
  if (rc != SBC_OK) { free(out.p); out.p = 0; out.n = 0; }
  *result = out.p; *resultlen = out.n;
  return rc;
}

`;
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block below, not by JS.
function __sbSubtleRaw(op, a, b, c, d) {
  let out = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __os; size_t __osl; char* __oso = 0;
    porf_native_fetch_read_value(op, &__os, &__osl, &__oso);
    char __ob[8]; size_t __ok = __osl < 7 ? __osl : 7;
    memcpy(__ob, __os, __ok); __ob[__ok] = 0;
    if (__oso) free(__oso);
    int __op = atoi(__ob);

    const char* __pa = ""; size_t __pal = 0; porf_native_fetch_read_raw_bytes(a, &__pa, &__pal);
    const char* __pb = ""; size_t __pbl = 0; porf_native_fetch_read_raw_bytes(b, &__pb, &__pbl);
    const char* __pc = ""; size_t __pcl = 0; porf_native_fetch_read_raw_bytes(c, &__pc, &__pcl);
    const char* __pd = ""; size_t __pdl = 0; porf_native_fetch_read_raw_bytes(d, &__pd, &__pdl);
    unsigned char* __res = 0; size_t __resl = 0;
    int __rc = sbc_op(__op, (const unsigned char*)__pa, __pal, (const unsigned char*)__pb, __pbl,
                      (const unsigned char*)__pc, __pcl, (const unsigned char*)__pd, __pdl, &__res, &__resl);
    unsigned char* __w = (unsigned char*)malloc(__resl + 1);
    if (__w) {
      __w[0] = (unsigned char)__rc;
      if (__resl) memcpy(__w + 1, __res, __resl);
      out = porf_box((f64)porf_native_fetch_alloc_bytestring((const char*)__w, __resl + 1), 195);
      free(__w);
    }
    free(__res);
  `;
  return out;
}
// SUBTLE:END
