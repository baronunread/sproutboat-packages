import "./d1-sqlite";
import { randomBytes } from "node:crypto";
import type { D1Request } from "./d1";
import type { Frame } from "./broker";

type Job = {
  request: D1Request;
  resolve: (value: Frame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type Lane = { worker?: Worker; active?: Job; queue: Job[]; owners: string[] };
/** Bounded SQL threads per broker process, created only when D1 is used.
 * Database affinity preserves in-memory data and connection-local SQL state.
 * Queues rotate sessions; SQLite interrupts long statements through its progress hook.
 */
export class D1Pool {
  /** Fatal SQL-thread loss revokes the hosting broker, never replaying uncertain SQL. */
  onFailure?: (error: Error) => void;
  private lanes: Lane[] = [
    { queue: [], owners: [] },
    { queue: [], owners: [] },
  ];
  private closed = false;
  private sequence = 0;
  private capability = "";
  constructor(
    private readonly queueLimit = 128,
    private readonly ownerLimit = 16,
    private readonly queueTimeoutMs = 10_000,
    private readonly executionMs = Number(process.env.SPROUTBOAT_D1_EXECUTION_MS ?? 1000),
  ) {
    if (!Number.isSafeInteger(executionMs) || executionMs < 10 || executionMs > 30_000)
      throw new Error("invalid D1 execution budget (10..30000 ms)");
  }
  session() {
    const owner = String(++this.sequence);
    let closed = false;
    return {
      execute: (request: Omit<D1Request, "owner">): Promise<Frame> => {
        if (closed || this.closed) return Promise.reject(new Error("D1 session closed"));
        // Stable affinity also covers resources shared by multiple sessions.
        let hash = 2166136261;
        for (let i = 0; i < request.key.length; i++) hash = Math.imul(hash ^ request.key.charCodeAt(i), 16777619);
        const lane = this.lanes[(hash >>> 0) % this.lanes.length]!;
        if (request.path === ":memory:") request = { ...request, key: `${owner}:${request.key}` };
        const jobs = this.lanes.flatMap((l) => (l.active ? [...l.queue, l.active] : l.queue));
        if (jobs.length >= this.queueLimit || jobs.filter((j) => j.request.owner === owner).length >= this.ownerLimit)
          return Promise.reject(new Error("D1 capacity exceeded"));
        return new Promise((resolve, reject) => {
          const job: Job = {
            request: { ...request, owner },
            resolve,
            reject,
            timer: setTimeout(() => {
              const index = lane.queue.indexOf(job);
              if (index !== -1) {
                lane.queue.splice(index, 1);
                if (!lane.queue.some((j) => j.request.owner === owner))
                  lane.owners = lane.owners.filter((id) => id !== owner);
                reject(new Error("D1 queue deadline exceeded"));
              }
            }, this.queueTimeoutMs),
          };
          if (!lane.owners.includes(owner)) lane.owners.push(owner);
          lane.queue.push(job);
          this.pump(lane);
        });
      },
      close: () => {
        if (closed) return;
        closed = true;
        for (const lane of this.lanes) {
          for (const job of lane.queue.filter((j) => j.request.owner === owner)) {
            clearTimeout(job.timer);
            job.reject(new Error("D1 session closed"));
          }
          lane.queue = lane.queue.filter((j) => j.request.owner !== owner);
          lane.owners = lane.owners.filter((id) => id !== owner);
          // The active statement may already have committed. Never retry it.
          lane.worker?.postMessage({ op: "release", owner });
        }
      },
    };
  }
  private pump(lane: Lane) {
    if (lane.active || !lane.queue.length || this.closed) return;
    if (!lane.worker) {
      const worker = new Worker(new URL("./d1-worker.ts", import.meta.url).href, { smol: true });
      lane.worker = worker;
      worker.onmessage = (event: MessageEvent<{ ok: boolean; value: Frame; error: string }>) => {
        const job = lane.active;
        if (!job) return;
        clearTimeout(job.timer);
        lane.active = undefined;
        if (event.data.ok) job.resolve(event.data.value);
        else job.reject(new Error(event.data.error));
        this.pump(lane);
      };
      const failed = () => {
        if (lane.worker !== worker) return;
        lane.worker = undefined;
        const jobs = lane.active ? [lane.active, ...lane.queue] : lane.queue;
        lane.active = undefined;
        lane.queue = [];
        lane.owners = [];
        for (const job of jobs) {
          clearTimeout(job.timer);
          job.reject(new Error("D1 worker lost; SQL outcome unknown"));
        }
        // Fail closed: lost in-memory databases must never silently become empty.
        worker.terminate();
        this.close();
        this.onFailure?.(new Error("D1 worker lost; SQL outcome unknown"));
      };
      worker.addEventListener("error", failed);
      worker.addEventListener("close", failed);
    }
    const owner = lane.owners.shift()!;
    const index = lane.queue.findIndex((j) => j.request.owner === owner);
    const job = lane.queue.splice(index, 1)[0]!;
    if (lane.queue.some((j) => j.request.owner === owner)) lane.owners.push(owner);
    clearTimeout(job.timer);
    lane.active = job;
    // Native progress interrupts VM work. This watchdog also bounds operations
    // that do not poll progress (locks, native allocation, or stalled I/O).
    // Revoke the broker instead of claiming an uncertain mutation rolled back.
    job.timer = setTimeout(() => {
      if (lane.active !== job) return;
      this.close();
      this.onFailure?.(new Error("D1 execution watchdog expired; SQL outcome unknown"));
    }, this.executionMs + 1000);
    this.capability ||= randomBytes(32).toString("hex");
    lane.worker.postMessage({
      op: "run",
      executionMs: this.executionMs,
      capability: this.capability,
      request: job.request,
    });
  }
  close() {
    this.closed = true;
    for (const lane of this.lanes) {
      for (const job of lane.active ? [lane.active, ...lane.queue] : lane.queue) {
        clearTimeout(job.timer);
        job.reject(new Error("D1 pool closed; active SQL outcome unknown"));
      }
      lane.active = undefined;
      lane.queue = [];
      lane.owners = [];
      const worker = lane.worker;
      lane.worker = undefined;
      worker?.terminate();
    }
  }
}
