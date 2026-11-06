/* oxlint-disable anti-slop/no-runtime-typeof -- runtime code Porffor compiles into the binary: typeof is how a callback or a thenable is recognised there. */
// sproutd on Porffor alpha 21: the preamble build/a21/base.ts puts before the runtime prelude
// (inputs/shared-prelude.js, which is the same source as on alpha 19). It supplies what the alpha
// 19 toolchain's C patches gave the prelude and alpha 21's node runtime does not: the names of the
// alpha 19 native-fetch helpers the prelude's inline C calls (defined over alpha 21's layouts in
// src/a21/native-host-bridge.c), the async-context alias, the host-driven timers, and the
// unhandled-rejection report. The web classes (Headers, Request, Response, Blob, File, URL,
// TextEncoder, TextDecoder) follow it, generated from the alpha 19 sources by base.ts.
// oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes.
Porffor.c`
#include <stddef.h>
#include <stdint.h>
// sproutd alpha 21 compat (src/a21/native-host-bridge.c): the prelude's inline C was written against
// alpha 19's native-fetch helpers; the same names are kept over alpha 21's string and array layouts.
// (// comments only here: alpha 21's declaration splitter takes a block comment at a statement's start for the statement.)
u32 porf_native_fetch_alloc(u32 bytes, u32 type);
u32 porf_native_fetch_alloc_bytestring(const char* input, size_t len);
int porf_native_fetch_read_value(jsval value, const char** out_buf, size_t* out_len, char** out_owned);
int porf_native_fetch_read_raw_bytes(jsval value, const char** out_buf, size_t* out_len);
void porf_native_fetch_fire_timer(u32 id);
void porf_native_fetch_timer_clear(u32 id);
// alpha 21 carries the async context the alpha 19 toolchain patched in (a reaction records it at offset 40)
#define porf_async_ctx_bits porf_async_context
u32 porf_cpu_begin(void);
double porf_cpu_read_ms(u32 id);
void porf_cpu_end(u32 id);
// a JS parameter the compiler may have typed as a plain number or as a jsval, read as a number either way
static inline f64 sb_num_of_jsval(jsval v) { return v.val; }
static inline f64 sb_num_of_f64(f64 v) { return v; }
#define SB_NUM(x) _Generic((x), jsval: sb_num_of_jsval, default: sb_num_of_f64)(x)
// the host's clock (SproutHostV1.timer_start / timer_clear) and reply, through the bridge
void sb_timer_start(u32 id, i32 delay_ms, i32 repeat_ms);
void sb_timer_clear(u32 id);
void sb_response_complete_js(f64 pending, f64 status, jsval head, jsval body, f64 kind);
// the dispatch shim's functions, rooted for the bridge (build/a21/prelude-dispatch.js)
jsval sb_dispatch_fn = {0.0, 0};
jsval sb_fire_timer_fn = {0.0, 0};
jsval sb_drain_fn = {0.0, 0};
// the template warm-up (prelude-dispatch.js __sbTemplateWarm), run once before the fork template seals
jsval sb_warm_fn = {0.0, 0};
i32 sb_warm_failed = 0;
`;

// Timers: the host owns the clock, as on alpha 19 (the bridge asks SproutHostV1.timer_start and
// the host calls fire_timer back); the callbacks live in this table instead of alpha 19's C timer
// records. Ids are the u32 the prelude passes to its C when it parks a timer for the host.
const __sbTimers = new Map();
let __sbTimerSeq = 0;
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block, not by JS.
function __sbTimerStartNative(id, ms, repeatMs) {
  // oxlint-disable-next-line no-unused-expressions -- inline C.
  Porffor.c`sb_timer_start((u32)SB_NUM(id), (i32)SB_NUM(ms), (i32)SB_NUM(repeatMs));`;
}
// The request (toolchain per-request cpu) a timer was armed in, restored while its callback runs.
function __sbCpuCurrentNative() {
  let id = 0;
  // oxlint-disable-next-line no-unused-expressions -- inline C.
  Porffor.c`id = (f64)porf_cpu_current();`;
  return id;
}
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block, not by JS.
function __sbCpuSwitchNative(id) {
  // oxlint-disable-next-line no-unused-expressions -- inline C.
  Porffor.c`porf_cpu_switch((u32)SB_NUM(id));`;
}
// oxlint-disable-next-line no-unused-vars -- read inside the RawC block, not by JS.
function __sbTimerClearNative(id) {
  // oxlint-disable-next-line no-unused-expressions -- inline C.
  Porffor.c`sb_timer_clear((u32)SB_NUM(id));`;
}
function __sbTimerArm(callback, delay, args, repeat) {
  if (typeof callback !== "function") throw new TypeError('The "callback" argument must be of type function');
  let ms = Number(delay);
  if (!(ms >= 0)) ms = 0;
  if (ms > 2147483647) ms = 2147483647;
  ms = Math.trunc(ms);
  // A zero timerfd expiry disarms the timer on Linux (toolchain patchZeroDelayTimers): at least 1 ms.
  if (ms < 1) ms = 1;
  __sbTimerSeq = (__sbTimerSeq + 1) >>> 0;
  if (__sbTimerSeq === 0) __sbTimerSeq = 1;
  const id = __sbTimerSeq;
  __sbTimers.set(id, {
    callback,
    args,
    repeat: repeat ? ms : 0,
    context: __Porffor_promise_getContext(),
    cpu: __sbCpuCurrentNative(),
  });
  __sbTimerStartNative(id, ms, repeat ? ms : 0);
  return id;
}
function __sbTimerClear(timer) {
  const id = Number(timer);
  if (!__sbTimers.has(id)) return;
  __sbTimers.delete(id);
  __sbTimerClearNative(id);
}
// The bridge fires a timer by id (SproutModuleV1.fire_timer, and the prelude's own parked timers
// through porf_native_fetch_fire_timer): the callback runs in the async context it was armed in,
// then the promise jobs it queued. An exception in a timer callback is reported, not fatal.
globalThis.__sbFireTimer = function (id) {
  const timer = __sbTimers.get(id);
  if (timer === undefined) return;
  if (timer.repeat === 0) __sbTimers.delete(id);
  const outer = __Porffor_promise_getContext();
  __Porffor_promise_setContext(timer.context);
  __sbCpuSwitchNative(timer.cpu);
  try {
    timer.callback.apply(undefined, timer.args);
  } catch (error) {
    console.error("Uncaught (in timer)", error);
  }
  __Porffor_promise_setContext(outer);
  __sbCpuSwitchNative(0);
  __Porffor_promise_runJobs();
};
globalThis.__sbDrainJobs = function () {
  __Porffor_promise_runJobs();
};
globalThis.setTimeout = function (callback, delay = 0, ...args) {
  return __sbTimerArm(callback, delay, args, false);
};
globalThis.setInterval = function (callback, delay = 0, ...args) {
  return __sbTimerArm(callback, delay, args, true);
};
globalThis.clearTimeout = __sbTimerClear;
globalThis.clearInterval = __sbTimerClear;

// An unhandled rejection is reported through the prelude's hook (a log line and an
// "unhandledrejection" event on the global scope), never thrown out of the job queue into the
// host (toolchain patchUnhandledRejections on alpha 19; alpha 21 has the hook built in).
__Porffor_promise_setRejectionHook(function (reason, promise) {
  const hook = globalThis.__sbOnUnhandledRejection;
  if (typeof hook === "function") hook(reason, promise);
  else console.error("Uncaught (in promise)", reason);
});
