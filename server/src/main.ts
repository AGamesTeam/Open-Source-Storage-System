import { scheduleBackups, scheduleHistoryPruning } from "./backup.ts";
import { loadConfig } from "./config.ts";
import { createApp } from "./server.ts";
import { Storage } from "./storage.ts";

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`[osss] ${(err as Error).message}`);
  process.exit(1);
}

const storage = new Storage(config.dbPath, { historyVersions: config.historyVersions });
const server = createApp(config, storage);
const stopBackups = scheduleBackups(storage, config);
const stopPruning = scheduleHistoryPruning(storage, config);

server.listen(config.port, config.host, () => {
  console.log(`[osss] Listening on http://${config.host}:${config.port}`);
  console.log(`[osss] Dashboard: /dashboard`);
  console.log(`[osss] Database: ${config.dbPath}`);
  console.log(`[osss] API keys loaded: ${config.keys.map((k) => `${k.name} (${k.access})`).join(", ")}`);
  console.log(
    `[osss] History: last ${config.historyVersions} versions per key` +
      (config.historyDays > 0 ? `, up to ${config.historyDays} days` : ""),
  );
  if (config.backupIntervalHours > 0) {
    const copy = config.backupCopyDir ? `, copied to ${config.backupCopyDir}` : "";
    console.log(`[osss] Backing up every ${config.backupIntervalHours}h to ${config.backupDir}${copy}`);
  }
});

function shutdown(): void {
  console.log("[osss] Shutting down...");
  stopBackups();
  stopPruning();
  server.close(() => {
    storage.close();
    process.exit(0);
  });
  // End waiting change-feed requests instead of holding shutdown open.
  server.closeAllConnections();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
