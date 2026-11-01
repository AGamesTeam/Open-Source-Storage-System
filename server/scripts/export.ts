// Usage: npm run export -- [output file]
// Writes every stored value as JSON Lines: one {"store", "key", "value", "version", "updatedAt"} object per line.
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { Storage } from "../src/storage.ts";

const dbPath = process.env.OSSS_DB_PATH || "data/osss.db";
const outPath = process.argv[2] || `osss-export-${new Date().toISOString().slice(0, 10)}.jsonl`;

const storage = new Storage(dbPath);
const out = createWriteStream(outPath);
let count = 0;
try {
  for (const entry of storage.exportAll()) {
    if (!out.write(JSON.stringify(entry) + "\n")) await once(out, "drain");
    count++;
  }
} finally {
  out.end();
  storage.close();
}
await once(out, "finish");
console.log(`Exported ${count} keys to ${outPath}`);
