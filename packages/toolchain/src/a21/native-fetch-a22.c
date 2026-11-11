// The alpha 22 native-fetch bridge of a standalone binary (@sproutboat/toolchain/a21 standalone.ts).
//
// On alpha 19 Porffor's render.js emitted the C entry points the uWebSockets server shim drives
// (porf_native_fetch_*: call the handler, read the response, timers, collections) over its own heap.
// Alpha 20 removed that server. This file defines the same names over alpha 22's layouts, the way
// sproutd's worker bridge (src/a21/native-host-bridge.c) does for the fork server: the request goes to
// the dispatch shim (standalone-dispatch.js __sbDispatch) through a rooted function value and
// porf_call_dynamic, and the settled response comes back through sb_response_complete_js, at once or
// from the promise reaction that settles it later. Request and response cross the boundary as flat
// data (a name\0value\0 header blob, a body pointer and length), so the shim no longer reads the heap.
//
// Compiled by the CLI beside the compiler's units with their porf.h on the include path.
#include "porf.h"
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <signal.h>
#include <unistd.h>

// --- the shim's side (porf_server.cpp, compiled as C++ with these as extern "C") ---
void porf_native_fetch_timer_start(u32 id, i32 delay_ms, i32 repeat_ms);
void porf_native_fetch_timer_clear(u32 id);
void porf_native_fetch_response_complete_flat(void* pending, i32 status, const char* head, size_t head_len, const char* body, size_t body_len, i32 is_reject);

// --- the compiled program ---
extern void p__main__23main(void);
extern void sb_data_init(void);
extern jsval sb_dispatch_fn, sb_fire_timer_fn, sb_drain_fn;
// The port the wrapper baked (globalThis.__sbStandalonePort), read by the preamble's C.
__attribute__((weak)) double sb_standalone_port = 0;

// Every entry from the server anchors the conservative stack scan at its own frame (the collector
// scans from the current stack pointer up to porf_c_stack_top); nested entries keep the outer one.
#define SB_ENTER volatile int sb_anchor=0;void* sb_prev_top=porf_c_stack_top;if(!sb_prev_top)porf_c_stack_top=(void*)&sb_anchor;
#define SB_LEAVE porf_c_stack_top=sb_prev_top;

// The last request or reply. Timers are not activity: an app with a periodic timer (queues, alarms) must
// still get its quiet collection, as on alpha 19 (sproutd #32 gated on requests the same way).
static struct timespec last_activity;
static void activity(void) { clock_gettime(CLOCK_MONOTONIC, &last_activity); }
static long long quiet_ms(void) {
  struct timespec now; clock_gettime(CLOCK_MONOTONIC, &now);
  return ((now.tv_sec - last_activity.tv_sec) * 1000000000LL + now.tv_nsec - last_activity.tv_nsec) / 1000000LL;
}

// --- compat: the prelude's inline C over alpha 22's layouts (the alpha 19 render.js definitions, re-homed) ---
u32 porf_native_fetch_alloc(u32 bytes, u32 type) { return porf_alloc(bytes, type); }
u32 porf_native_fetch_alloc_bytestring(const char* input, size_t len) { return (u32)porf_jv_val(porf_bstr_of(input, (u32)len)); }
int porf_native_fetch_read_raw_bytes(jsval value, const char** out_buf, size_t* out_len) {
  if (value.type != 195) return -1;
  const u32 ptr = (u32)value.val;
  *out_buf = (const char*)(MEM + ptr + 4);
  *out_len = (size_t)*(u32*)(MEM + ptr);
  return 0;
}
int porf_native_fetch_read_value(jsval value, const char** out_buf, size_t* out_len, char** out_owned) {
  if (!out_buf || !out_len || !out_owned) return -1;
  *out_buf = NULL; *out_len = 0; *out_owned = NULL;
  if (value.type == 195) {
    // units are Latin-1 code points, not UTF-8 bytes: encode them (sproutboat #172)
    const u32 ptr = (u32)value.val;
    const size_t len = (size_t)*(u32*)(MEM + ptr);
    const unsigned char* units = (const unsigned char*)(MEM + ptr + 4);
    char* utf8 = (char*)malloc(len * 2 + 1);
    if (!utf8) return -1;
    size_t n = 0;
    for (size_t i = 0; i < len; i++) {
      unsigned char c = units[i];
      if (c < 0x80) utf8[n++] = (char)c;
      else { utf8[n++] = (char)(0xc0 | (c >> 6)); utf8[n++] = (char)(0x80 | (c & 0x3f)); }
    }
    *out_buf = utf8; *out_len = n; *out_owned = utf8;
    return 0;
  }
  if (value.type == 67) {
    const u32 ptr = (u32)value.val;
    const size_t len = (size_t)*(u32*)(MEM + ptr);
    const u16* chars = (const u16*)(MEM + ptr + 4);
    char* utf8 = (char*)malloc(len * 3 + 1);
    if (!utf8) return -1;
    size_t n = 0;
    for (size_t i = 0; i < len; i++) {
      u32 c = chars[i];
      if (c >= 0xd800 && c < 0xdc00 && i + 1 < len && (chars[i + 1] & 0xfc00) == 0xdc00) { c = 0x10000 + ((c - 0xd800) << 10) + (chars[i + 1] - 0xdc00); i++; }
      else if (c >= 0xd800 && c < 0xe000) c = 0xfffd;
      if (c < 0x80) utf8[n++] = (char)c;
      else if (c < 0x800) { utf8[n++] = (char)(0xc0 | (c >> 6)); utf8[n++] = (char)(0x80 | (c & 0x3f)); }
      else if (c < 0x10000) { utf8[n++] = (char)(0xe0 | (c >> 12)); utf8[n++] = (char)(0x80 | ((c >> 6) & 0x3f)); utf8[n++] = (char)(0x80 | (c & 0x3f)); }
      else { utf8[n++] = (char)(0xf0 | (c >> 18)); utf8[n++] = (char)(0x80 | ((c >> 12) & 0x3f)); utf8[n++] = (char)(0x80 | ((c >> 6) & 0x3f)); utf8[n++] = (char)(0x80 | (c & 0x3f)); }
    }
    *out_buf = utf8; *out_len = n; *out_owned = utf8;
    return 0;
  }
  if (value.type == 1) {
    char* text = (char*)malloc(32);
    if (!text) return -1;
    int n = snprintf(text, 32, "%.17g", value.val);
    *out_buf = text; *out_len = n > 0 ? (size_t)n : 0; *out_owned = text;
    return 0;
  }
  return -1;
}
// A Latin-1 narrowing (one byte per code unit) of a string or bytestring, malloc'd.
static char* narrow(jsval value, size_t* len) {
  const u32 ptr = (u32)value.val;
  const u32 n = *(u32*)(MEM + ptr);
  char* out = (char*)malloc(n + 1);
  if (!out) abort();
  if (value.type == 195) memcpy(out, MEM + ptr + 4, n);
  else for (u32 i = 0; i < n; i++) out[i] = (char)(((const u16*)(MEM + ptr + 4))[i] & 0xff);
  *len = n;
  return out;
}

// --- timers: the preamble's table asks the server's loop for its wakeups (sb_timer_start) ---
void sb_timer_start(u32 id, i32 delay, i32 repeat) { porf_native_fetch_timer_start(id, delay, repeat); }
void sb_timer_clear(u32 id) { porf_native_fetch_timer_clear(id); }
// The server's timer fires a timer by id (the prelude's parked timers come through the same name).
void porf_native_fetch_fire_timer(u32 id) {
  SB_ENTER
  jsbits argv[1] = { porf_pack(porf_box_num((f64)id)) };
  (void)porf_call_dynamic(sb_fire_timer_fn, JV_UNDEFINED, JV_UNDEFINED, 1, argv);
  SB_LEAVE
}
void porf_native_fetch_drain_microtasks(void) {
  SB_ENTER
  jsbits none[1] = { 0 };
  (void)porf_call_dynamic(sb_drain_fn, JV_UNDEFINED, JV_UNDEFINED, 0, none);
  SB_LEAVE
}

// --- the request: the shim\x27s flat parts go to the dispatch shim; the reply comes back below ---
// The headers arrive as one name\0value\0 blob and become the flat [name, value, ...] list the alpha 19
// Headers class keeps (Headers._entries), built here rather than split in JS. The array and its strings
// are reachable from this frame (the conservative scan runs from the stack pointer to the anchor), so a
// collection inside one of these allocations keeps them.
static jsval header_list(const char* head, size_t head_len) {
  i32 n = 0;
  for (size_t i = 0; i < head_len; i++) if (!head[i]) n++;
  const u32 a = porf_arr_new(n, n);
  size_t at = 0;
  for (i32 i = 0; i < n && at < head_len; i++) {
    const char* s = head + at;
    const size_t len = strnlen(s, head_len - at);
    porf_arr_set(a, (u32)i, porf_bstr_of(s, (u32)len));
    at += len + 1;
  }
  return (jsval){ (f64)a, 72 };
}
void porf_native_fetch_dispatch_flat(void* pending, const char* method, size_t method_len, const char* url, size_t url_len, const char* head, size_t head_len, const char* body, size_t body_len) {
  SB_ENTER
  jsval m = porf_bstr_of(method, (u32)method_len), u = porf_bstr_of(url, (u32)url_len), h = header_list(head, head_len), b = porf_bstr_of(body, (u32)body_len);
  jsbits argv[5] = { porf_pack(porf_box_num((f64)(uintptr_t)pending)), porf_pack(m), porf_pack(u), porf_pack(h), porf_pack(b) };
  (void)porf_call_dynamic(sb_dispatch_fn, JV_UNDEFINED, JV_UNDEFINED, 5, argv);
  activity();
  SB_LEAVE
}
// A string read for the reply: an ASCII bytestring where it lies (valid until the next allocation; the
// server copies before any), anything else UTF-8 encoded into a malloc the caller frees (alpha 19\x27s
// sb_read_value_fast, moved from the shim into the bridge).
static int read_fast(jsval v, const char** out, size_t* len, char** owned) {
  *owned = NULL;
  if (v.type == 195) {
    const u32 ptr = (u32)v.val;
    const size_t n = (size_t)*(u32*)(MEM + ptr);
    const unsigned char* units = (const unsigned char*)(MEM + ptr + 4);
    size_t i = 0;
    for (; i < n; i++) if (units[i] >= 0x80) break;
    if (i == n) { *out = (const char*)units; *len = n; return 0; }
  }
  return porf_native_fetch_read_value(v, out, len, owned);
}
static int name_is(const char* s, size_t n, const char* lit) { const size_t l = strlen(lit); return n == l && memcmp(s, lit, l) == 0; }
// The dispatch shim\x27s response parts (standalone-dispatch.js __sbComplete): status, the flat header
// list and a body that is a string (kind 0; Latin-1 bytes when the list carries x-sb-raw-body) or a
// Uint8Array (kind 2). The hop-by-hop names and the internal x-sb-raw-body never reach the wire. The
// server borrows the data until it returns.
void sb_response_complete_js(f64 pending, f64 status, jsval head, jsval body, f64 kind) {
  SB_ENTER
  const u32 list = (u32)head.val;
  const u32 n = head.type == 72 ? (u32)PORF_ARR_LEN(list) : 0;
  size_t cap = 256, blob_len = 0;
  char* blob = (char*)malloc(cap);
  if (!blob) abort();
  int raw = 0;
  for (u32 i = 0; i + 1 < n; i += 2) {
    const char* name; size_t name_len; char* name_owned;
    const char* value; size_t value_len; char* value_owned;
    if (read_fast(porf_arr_get(list, i), &name, &name_len, &name_owned) != 0) continue;
    if (name_is(name, name_len, "x-sb-raw-body")) { raw = 1; free(name_owned); continue; }
    if (name_is(name, name_len, "connection") || name_is(name, name_len, "transfer-encoding")) { free(name_owned); continue; }
    if (read_fast(porf_arr_get(list, i + 1), &value, &value_len, &value_owned) != 0) { free(name_owned); continue; }
    // A length the app declared goes to the server as a number (the server uses it for a HEAD answer, which has no body to
    // count, and drops it otherwise: it counts the body it sends).
    if (name_is(name, name_len, "content-length")) {
      int digits = value_len > 0 && value_len <= 15;
      for (size_t k = 0; k < value_len && digits; k++) if (value[k] < '0' || value[k] > '9') digits = 0;
      if (!digits) { free(name_owned); free(value_owned); continue; }
    }
    if (blob_len + name_len + value_len + 2 > cap) { while (blob_len + name_len + value_len + 2 > cap) cap *= 2; blob = (char*)realloc(blob, cap); if (!blob) abort(); }
    memcpy(blob + blob_len, name, name_len); blob_len += name_len; blob[blob_len++] = 0;
    memcpy(blob + blob_len, value, value_len); blob_len += value_len; blob[blob_len++] = 0;
    free(name_owned); free(value_owned);
  }
  size_t body_len = 0;
  char* owned = NULL; const char* body_data = NULL;
  const int k = (int)kind;
  if (k == 2) {
    // a Uint8Array (alpha 22 layout: [length, dataPtr, byteOffset, fixedLength]; dataPtr is the buffer
    // object + 4 + byteOffset, and the buffer object is [byteLength, flags, bytes]). A length-tracking view
    // stores -1 for its length: the bytes then run to the end of the buffer.
    const u32 view = (u32)body.val; const u32 data = *(u32*)(MEM + view + 4), offset = *(u32*)(MEM + view + 8);
    u32 length = *(u32*)(MEM + view);
    if (length == 0xffffffffu) length = *(u32*)(MEM + (data - 4 - offset)) - offset;
    body_data = (const char*)(MEM + data + 4); body_len = (size_t)length;
  } else if (raw) { owned = narrow(body, &body_len); body_data = owned; }
  else { if (read_fast(body, &body_data, &body_len, &owned) != 0) { body_data = ""; body_len = 0; } }
  porf_native_fetch_response_complete_flat((void*)(uintptr_t)pending, (i32)status, blob, blob_len, body_data, body_len, 0);
  free(owned); free(blob);
  activity();
  SB_LEAVE
}

// --- collections, paced by the shim (every N replies, a 50 ms idle tick, a 500 ms quiet timer) ---
void porf_native_fetch_collect_normal(void) { porf_gc_collect(1); }
static int gc_debug = -1;
static unsigned normal_collections;
void porf_native_fetch_collect_normal_from(void* stack_top) {
  void* prev = porf_c_stack_top;
  if (!prev) porf_c_stack_top = stack_top;
  porf_gc_collect(1);
  porf_c_stack_top = prev;
  if (gc_debug < 0) gc_debug = getenv("SB_GC_DEBUG") != NULL;
  if (gc_debug && (++normal_collections % 64u) == 1u) fprintf(stderr, "sb gc: collection %u: live %llu bytes, free pages %u, heap top %u\n", normal_collections, (unsigned long long)porf_gc_last_live_bytes, porf_gc_free_page_count, porf_heap_top);
}
#ifndef SB_QUIET_IDLE_MS
#define SB_QUIET_IDLE_MS 400
#endif
int porf_native_fetch_needs_quiet_collect(void) { return 1; }
// The full collection that gives free pages back (the toolchain's porf_gc_quiet), once the server has
// had no request, timer or reply for SB_QUIET_IDLE_MS: run between requests under steady load it made
// every request fault back the pages the previous tick returned (sproutd #32).
void porf_native_fetch_collect_quiet_from(void* stack_top) {
  if (gc_debug < 0) gc_debug = getenv("SB_GC_DEBUG") != NULL;
  const long long q = quiet_ms();
  if (q < SB_QUIET_IDLE_MS) { if (gc_debug) fprintf(stderr, "sb gc: quiet skipped (%lld ms since the last request)\n", q); return; }
  void* prev = porf_c_stack_top;
  if (!prev) porf_c_stack_top = stack_top;
  const u64 live0 = porf_gc_last_live_bytes, free0 = porf_gc_free_page_count;
  porf_gc_quiet();
  porf_c_stack_top = prev;
  if (gc_debug) fprintf(stderr, "sb gc: quiet collection (%lld ms since the last request): live %llu -> %llu bytes, free pages %llu -> %llu, heap top %u base %u\n", q, (unsigned long long)live0, (unsigned long long)porf_gc_last_live_bytes, (unsigned long long)free0, (unsigned long long)porf_gc_free_page_count, porf_heap_top, porf_heap_base);
}
int porf_native_fetch_should_collect(void) { return 0; }

// --- startup ---
f64 porf_native_fetch_get_port(void) {
  const char* env = getenv("PORT");
  if (env && *env) { long v = strtol(env, NULL, 10); if (v > 0 && v < 65536) return (f64)v; }
  return sb_standalone_port > 0 ? sb_standalone_port : 8080;
}
void porf_native_fetch_runtime_init(void) {
  signal(SIGPIPE, SIG_IGN);
  // sproutboat #165: unbuffered handler console output, routed to stderr
  dup2(2, 1);
  setvbuf(stdout, NULL, _IONBF, 0);
  static char* argv[] = { (char*)"/sproutboat/sprout", (char*)"/sproutboat/sprout.generated.js", NULL };
  porf_init(2, argv);
  sb_data_init();
  volatile int anchor = 0;
  porf_c_stack_top = (void*)&anchor;
  p__main__23main();
  porf_c_stack_top = NULL;
  if (sb_dispatch_fn.type == 0) { fprintf(stderr, "dispatch shim not registered\n"); exit(2); }
  activity();
}
