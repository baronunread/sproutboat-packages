import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * An async context for Porffor (design 02): one "current context" value that follows the
 * control flow of a request across awaits, promise reactions and timers, which is what
 * AsyncLocalStorage needs. The prelude (runtime) keeps a frame object in it.
 *
 * - `porf_async_ctx_bits` is the current context (a packed JS value, undefined at the root).
 * - A promise reaction (then, await, a coroutine resume, a native response callback) records the
 *   current context when it is created (a new field at offset 40, so a reaction is 48 bytes).
 * - Dequeuing a job makes its reaction's context current; an empty queue resets it to the root.
 * - A timer (setTimeout, setInterval, and what the host fires for async fetch and WebSocket
 *   events) records the context when it is armed and sets it when it fires.
 * - The collector marks the current context and each reaction's.
 *
 * Cost: one 8-byte store per reaction and one load per job; no cost when nothing sets a context.
 */
const MARKER = "sproutboat: async context";

/**
 * Per-request CPU (design 02): the thread CPU time each request has used, summed over the slices
 * in which it ran. The current request is a small id (slot and generation) that rides with the
 * async context: a reaction and a timer record it when they are created, and it becomes current
 * when they run. The clock is read only when the request changes, so a request that runs alone
 * costs two reads, not one per await.
 */
const CPU_DEFS = [
  "#define PORF_CPU_SLOTS 256",
  "static u32 porf_cpu_cur = 0;",
  "static double porf_cpu_last_ns = 0;",
  "static double porf_cpu_acc[PORF_CPU_SLOTS];",
  "static u16 porf_cpu_gen[PORF_CPU_SLOTS];",
  "static u8 porf_cpu_used[PORF_CPU_SLOTS];",
  "static u16 porf_cpu_next_gen = 0;",
  "static u32 porf_cpu_next_slot = 0;",
  "static inline double porf_cpu_now_ns(void) { struct timespec ts; clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts); return (double)ts.tv_sec * 1e9 + (double)ts.tv_nsec; }",
  "static inline int porf_cpu_live(u32 id) { const u32 i = id & 255u; return id != 0 && porf_cpu_used[i] && porf_cpu_gen[i] == (u16)(id >> 8); }",
  "static void porf_cpu_switch(u32 next) {",
  "  if (next == porf_cpu_cur) return;",
  "  const double t = porf_cpu_now_ns();",
  "  if (porf_cpu_live(porf_cpu_cur)) porf_cpu_acc[porf_cpu_cur & 255u] += t - porf_cpu_last_ns;",
  "  porf_cpu_last_ns = t;",
  "  porf_cpu_cur = next;",
  "}",
  "static u32 porf_cpu_begin(void) {",
  "  for (u32 k = 0; k < PORF_CPU_SLOTS; k++) {",
  "    const u32 i = (porf_cpu_next_slot + k) & 255u;",
  "    if (porf_cpu_used[i]) continue;",
  "    porf_cpu_next_slot = i + 1u;",
  "    if (++porf_cpu_next_gen == 0) porf_cpu_next_gen = 1;",
  "    porf_cpu_used[i] = 1; porf_cpu_gen[i] = porf_cpu_next_gen; porf_cpu_acc[i] = 0;",
  "    const u32 id = i | ((u32)porf_cpu_next_gen << 8);",
  "    porf_cpu_switch(id);",
  "    return id;",
  "  }",
  "  return 0;",
  "}",
  "static double porf_cpu_read_ms(u32 id) {",
  "  if (!porf_cpu_live(id)) return -1.0;",
  "  if (porf_cpu_cur == id) { const double t = porf_cpu_now_ns(); porf_cpu_acc[id & 255u] += t - porf_cpu_last_ns; porf_cpu_last_ns = t; }",
  "  return porf_cpu_acc[id & 255u] / 1e6;",
  "}",
  "static void porf_cpu_end(u32 id) {",
  "  if (!porf_cpu_live(id)) return;",
  "  if (porf_cpu_cur == id) porf_cpu_switch(0);",
  "  porf_cpu_used[id & 255u] = 0;",
  "}",
  "",
].join("\n");

/** [anchor, replacement] edits of compiler/render.js. Every anchor must occur exactly `count` times. */
const RENDER_EDITS: readonly { anchor: string; inject: string; count: number }[] = [
  {
    anchor: "#define PORF_REACTION_SIZE 40\n",
    inject:
      "#define PORF_REACTION_CTX 40\n#define PORF_REACTION_CPU 48\n#define PORF_REACTION_SIZE 56\n" +
      `/* ${MARKER} */\nstatic jsbits porf_async_ctx_bits = JV_UNDEFINED_BITS;\n` +
      CPU_DEFS +
      "static inline void porf_async_ctx_stamp(u32 reaction) { *(jsbits*)(MEM + reaction + PORF_REACTION_CTX) = porf_async_ctx_bits; *(u32*)(MEM + reaction + PORF_REACTION_CPU) = porf_cpu_cur; }\n",
    count: 1,
  },
  // The two reaction constructors in C.
  {
    anchor: "  *(u8*)(MEM + reaction + PORF_REACTION_FLAGS) = 0;\n",
    inject:
      "  *(u8*)(MEM + reaction + PORF_REACTION_FLAGS) = 0;\n  *(jsbits*)(MEM + reaction + PORF_REACTION_CTX) = porf_async_ctx_bits;\n  *(u32*)(MEM + reaction + PORF_REACTION_CPU) = porf_cpu_cur;\n",
    count: 2,
  },
  // Dequeue: the job's context becomes current; no job resets it.
  {
    anchor:
      "static u32 porf_promise_dequeue_job(void) {\n  if (porf_promise_job_len == 0) return 0;\n  const u32 reaction = porf_promise_job_queue[porf_promise_job_head];\n",
    inject:
      "static u32 porf_promise_dequeue_job(void) {\n  if (porf_promise_job_len == 0) { porf_async_ctx_bits = JV_UNDEFINED_BITS; porf_cpu_switch(0); return 0; }\n  const u32 reaction = porf_promise_job_queue[porf_promise_job_head];\n  porf_async_ctx_bits = *(jsbits*)(MEM + reaction + PORF_REACTION_CTX);\n  porf_cpu_switch(*(u32*)(MEM + reaction + PORF_REACTION_CPU));\n",
    count: 1,
  },
  // GC: reactions and the current context.
  {
    anchor: "  porf_gc_mark_jsbits(*(jsbits*)(MEM + raw + PORF_REACTION_VALUE));\n}\n",
    inject:
      "  porf_gc_mark_jsbits(*(jsbits*)(MEM + raw + PORF_REACTION_VALUE));\n  porf_gc_mark_jsbits(*(jsbits*)(MEM + raw + PORF_REACTION_CTX));\n}\n",
    count: 1,
  },
  {
    anchor: "  porf_gc_mark_promise_jobs();\n  porf_gc_mark_coro_roots();\n",
    inject:
      "  porf_gc_mark_promise_jobs();\n  porf_gc_mark_jsbits(porf_async_ctx_bits);\n  porf_gc_mark_coro_roots();\n",
    count: 1,
  },
  // Timers.
  {
    anchor: "  i32 callback_root;\n  i32 args_root;\n  i32 repeat;\n  i32 active;\n} porf_native_timer_record;",
    inject:
      "  i32 callback_root;\n  i32 args_root;\n  i32 repeat;\n  i32 active;\n  jsval ctx;\n  i32 ctx_root;\n  u32 cpu;\n} porf_native_timer_record;",
    count: 1,
  },
  {
    anchor:
      "  if (timer->args_root >= 0) porf_gc_native_root_remove(timer->args_root);\n  timer->callback_root = -1;\n",
    inject:
      "  if (timer->args_root >= 0) porf_gc_native_root_remove(timer->args_root);\n  if (timer->ctx_root >= 0) porf_gc_native_root_remove(timer->ctx_root);\n  timer->ctx_root = -1;\n  timer->ctx = JV_UNDEFINED;\n  timer->callback_root = -1;\n",
    count: 1,
  },
  {
    anchor: "      grown[i].args_root = -1;\n",
    inject:
      "      grown[i].args_root = -1;\n      grown[i].ctx = JV_UNDEFINED;\n      grown[i].ctx_root = -1;\n      grown[i].cpu = 0;\n",
    count: 1,
  },
  {
    anchor: "  timer->args_root = porf_gc_native_root_add(args.val, args.type);\n",
    inject:
      "  timer->args_root = porf_gc_native_root_add(args.val, args.type);\n  timer->ctx = porf_unpack(porf_async_ctx_bits);\n  timer->ctx_root = porf_gc_native_root_add(timer->ctx.val, timer->ctx.type);\n  timer->cpu = porf_cpu_cur;\n",
    count: 1,
  },
  {
    anchor:
      "  const i32 repeat = timer->repeat;\n  if (!repeat) porf_native_release_timer(timer);\n  (void)porf_call_dynamic_arr(callback, JV_UNDEFINED, JV_UNDEFINED, args);\n",
    inject:
      "  const i32 repeat = timer->repeat;\n  const jsval ctx = timer->ctx;\n  const u32 cpu = timer->cpu;\n  if (!repeat) porf_native_release_timer(timer);\n  porf_async_ctx_bits = porf_pack(ctx);\n  porf_cpu_switch(cpu);\n  (void)porf_call_dynamic_arr(callback, JV_UNDEFINED, JV_UNDEFINED, args);\n  porf_async_ctx_bits = JV_UNDEFINED_BITS;\n  porf_cpu_switch(0);\n",
    count: 1,
  },
];

/** compiler/builtins/promise.ts: the reaction the TypeScript builtins make (then, finally, thenables). */
const PROMISE_EDITS: readonly { anchor: string; inject: string }[] = [
  {
    anchor: "  const out: i32 = Porffor.malloc(40);\n  Porffor.IR.storeJv(out, 0, handler);\n",
    inject: "  const out: i32 = Porffor.malloc(56);\n  Porffor.IR.storeJv(out, 0, handler);\n",
  },
  {
    anchor: "  Porffor.c`porf_gc_barrier((u32)out, PORF_GC_KIND_PROMISE_REACTION);`;\n  return out;\n",
    inject:
      "  Porffor.c`porf_async_ctx_stamp((u32)out); /* " +
      MARKER +
      " */\nporf_gc_barrier((u32)out, PORF_GC_KIND_PROMISE_REACTION);`;\n  return out;\n",
  },
];

function occurrences(text: string, anchor: string): number {
  return text.split(anchor).length - 1;
}

/** Patch the async context in. Before precompileBuiltins. */
export async function patchAsyncContext(root: string): Promise<void> {
  const renderFile = resolve(root, "compiler/render.js");
  const promiseFile = resolve(root, "compiler/builtins/promise.ts");
  let render = await readFile(renderFile, "utf8");
  let promise = await readFile(promiseFile, "utf8");
  if (render.includes(MARKER)) return;
  for (const { anchor, inject, count } of RENDER_EDITS) {
    if (occurrences(render, anchor) !== count)
      throw new Error(
        `could not patch Porffor's async context: render.js anchor not found ${count} time(s): ${anchor.slice(0, 80)}`,
      );
    render = render.split(anchor).join(inject);
  }
  for (const { anchor, inject } of PROMISE_EDITS) {
    if (occurrences(promise, anchor) !== 1)
      throw new Error(`could not patch Porffor's async context: promise.ts anchor not found: ${anchor.slice(0, 80)}`);
    promise = promise.replace(anchor, inject);
  }
  await Promise.all([writeFile(renderFile, render), writeFile(promiseFile, promise)]);
}

/** Text holding every anchor, for tests that stand in for a Porffor checkout. */
export const ASYNC_CONTEXT_RENDER_ANCHORS = RENDER_EDITS.flatMap((e) => Array<string>(e.count).fill(e.anchor)).join("");
export const ASYNC_CONTEXT_PROMISE_ANCHORS = PROMISE_EDITS.map((e) => e.anchor).join("");
