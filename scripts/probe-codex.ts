import { probeCodex } from "../packages/executors/codex.ts";

// Deliberately prints only capability flags and version, never account identity.
console.log(JSON.stringify(await probeCodex(), null, 2));
