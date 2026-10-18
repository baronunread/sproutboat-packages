/** Private messages only: paths and identities are supplied by the broker. */
import { createD1Store, type D1Request } from "./d1";
declare var self: Worker;
let store: ReturnType<typeof createD1Store> | undefined;
self.onmessage = (
  event: MessageEvent<
    { op: "run"; executionMs: number; capability: string; request: D1Request } | { op: "release"; owner: string }
  >,
) => {
  const message = event.data;
  if (message.op === "release") {
    store?.release(message.owner);
    return;
  }
  try {
    store ??= createD1Store(message.executionMs, message.capability);
    postMessage({ ok: true, value: store.execute(message.request) });
  } catch (error) {
    postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
process.on("exit", () => store?.close());
