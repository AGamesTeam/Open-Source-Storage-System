// Usage: npm run backup
// Saves a copy of the database to OSSS_BACKUP_DIR. Safe to run while the server is running.
import { runBackup } from "../src/backup.ts";
import { Storage } from "../src/storage.ts";

const dbPath = process.env.OSSS_DB_PATH || "data/osss.db";
const backupDir = process.env.OSSS_BACKUP_DIR || "backups";
const keep = Number(process.env.OSSS_BACKUP_KEEP || 14);

const storage = new Storage(dbPath);
try {
  console.log(`Backup saved to ${await runBackup(storage, backupDir, keep)}`);
} finally {
  storage.close();
}
