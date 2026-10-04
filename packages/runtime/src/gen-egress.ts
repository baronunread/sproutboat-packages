// Regenerates the C range table in transport-embedded.js from egress.ts (#174).
import { readFileSync, writeFileSync } from "node:fs";
import { spliceEgressTable } from "./egress";

const path = new URL("./transport-embedded.js", import.meta.url);
writeFileSync(path, spliceEgressTable(readFileSync(path, "utf8")));
