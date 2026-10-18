/** Trusted supervisor control travels over private stdio, never tenant TCP. */
import { isString } from "./json";
import { D1Pool } from "./d1-pool";
import { startBroker } from "./broker";

const sql = new D1Pool();
// Reuse supervisor worker-death recovery for an unrecoverable SQL thread.
// Keeping the process alive would leave sessions with permanently failed D1.
sql.onFailure = (error) => {
  console.error(`sproutboat broker: ${error.message}; revoking broker sessions`);
  process.exit(1);
};
const sessions = new Map<string, ReturnType<typeof startBroker>>();
const limit = Number(process.argv[2] ?? 64);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
  throw new Error("invalid session limit");
try {
  for await (const line of console) {
    let requestId = 0;
    try {
      // SAFETY: private stdin is owned by the trusted supervisor. Validate
      // fields before allowing it to create a session or open any files.
      const msg = JSON.parse(line) as {
        requestId: number;
        id: string;
        op: string;
        args?: string[];
      };
      requestId = msg.requestId;
      if (!Number.isSafeInteger(requestId) || !isString(msg.id) || msg.id.length > 256)
        throw new Error("invalid command");
      if (msg.op === "register") {
        if (sessions.has(msg.id)) throw new Error("session already registered");
        if (sessions.size >= limit) throw new Error("broker session limit reached");
        if (!Array.isArray(msg.args) || !msg.args.every(isString))
          throw new Error("invalid session arguments");
        sessions.set(msg.id, startBroker(msg.args, sql));
      } else if (msg.op === "remove") {
        sessions.get(msg.id)?.close();
        sessions.delete(msg.id);
      } else if (msg.op === "enable") {
        const session = sessions.get(msg.id);
        if (!session) throw new Error("unknown session");
        session.enableDispatch();
      } else throw new Error("unknown command");
      console.log(JSON.stringify({ requestId, ok: true }));
    } catch (error) {
      console.log(
        JSON.stringify({
          requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
} finally {
  for (const session of sessions.values()) session.close();
  sql.close();
}
