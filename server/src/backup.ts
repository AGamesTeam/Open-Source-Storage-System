import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Storage } from "./storage.ts";

const BACKUP_FILE = /^osss-\d{4}-\d{2}-\d{2}T[\d-]+Z\.db$/;

/** Backs up the database into dir, then deletes the oldest backups beyond keep. Returns the new file's path. */
export async function runBackup(storage: Storage, dir: string, keep: number): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `osss-${stamp}.db`);
  await storage.backupTo(path);

  if (keep > 0) {
    const old = readdirSync(dir).filter((name) => BACKUP_FILE.test(name)).sort().slice(0, -keep);
    for (const name of old) rmSync(join(dir, name));
  }
  return path;
}

/** Starts automatic backups if they're turned on. Returns a function that stops them. */
export function scheduleBackups(storage: Storage, config: Config): () => void {
  if (config.backupIntervalHours === 0) return () => {};

  const timer = setInterval(async () => {
    try {
      const path = await runBackup(storage, config.backupDir, config.backupKeep);
      console.log(`[osss] Backup saved to ${path}`);
    } catch (err) {
      console.error("[osss] Backup failed:", err);
    }
  }, config.backupIntervalHours * 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
