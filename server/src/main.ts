import { scheduleBackups } from "./backup.ts";
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

const storage = new Storage(config.dbPath);
const server = createApp(config, storage);
const stopBackups = scheduleBackups(storage, config);

server.listen(config.port, config.host, () => {
  console.log(`[osss] Listening on http://${config.host}:${config.port}`);
  console.log(`[osss] Dashboard: http://localhost:${config.port}/dashboard`);
  console.log(`[osss] Database: ${config.dbPath}`);
  console.log(`[osss] API keys loaded: ${config.keys.map((k) => `${k.name} (${k.access})`).join(", ")}`);
  if (config.backupIntervalHours > 0) {
    console.log(`[osss] Backing up every ${config.backupIntervalHours}h to ${config.backupDir}`);
  }
});

function shutdown(): void {
  console.log("[osss] Shutting down...");
  stopBackups();
  server.close(() => {
    storage.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
