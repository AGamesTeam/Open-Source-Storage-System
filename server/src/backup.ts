import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config } from "./config.ts";
import type { Storage } from "./storage.ts";

const BACKUP_FILE = /^osss-\d{4}-\d{2}-\d{2}T[\d-]+Z\.db$/;

/**
 * Backs up the database into dir, copies it to copyDir if given, then deletes the oldest
 * backups beyond keep in both. Returns the new file's path.
 */
export async function runBackup(storage: Storage, dir: string, keep: number, copyDir = ""): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `osss-${stamp}.db`);
  await storage.backupTo(path);
  prune(dir, keep);

  if (copyDir) {
    mkdirSync(copyDir, { recursive: true });
    copyFileSync(path, join(copyDir, basename(path)));
    prune(copyDir, keep);
  }
  return path;
}

function prune(dir: string, keep: number): void {
  if (keep === 0) return;
  const old = readdirSync(dir).filter((name) => BACKUP_FILE.test(name)).sort().slice(0, -keep);
  for (const name of old) rmSync(join(dir, name));
}

/** Starts automatic backups if they're turned on. Returns a function that stops them. */
export function scheduleBackups(storage: Storage, config: Config): () => void {
  if (config.backupIntervalHours === 0) return () => {};

  const timer = setInterval(async () => {
    try {
      const path = await runBackup(storage, config.backupDir, config.backupKeep, config.backupCopyDir);
      console.log(`[osss] Backup saved to ${path}${config.backupCopyDir ? ` and copied to ${config.backupCopyDir}` : ""}`);
    } catch (err) {
      console.error("[osss] Backup failed:", err);
    }
  }, config.backupIntervalHours * 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

/** Deletes history older than the configured age, every hour. Returns a function that stops it. */
export function scheduleHistoryPruning(storage: Storage, config: Config): () => void {
  if (config.historyDays === 0) return () => {};

  const prune = (): void => {
    try {
      const removed = storage.pruneHistory(config.historyDays * 24 * 60 * 60 * 1000);
      if (removed > 0) console.log(`[osss] Pruned ${removed} old history versions`);
    } catch (err) {
      console.error("[osss] History pruning failed:", err);
    }
  };
  prune();
  const timer = setInterval(prune, 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
