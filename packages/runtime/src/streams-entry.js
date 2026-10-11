// Generator input only. Native modules use the generated, import-free block.
import * as streams from "web-streams-polyfill";
for (const name of Object.keys(streams)) {
  if (globalThis[name] == null) globalThis[name] = streams[name];
}
