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

server.listen(config.port, config.host, () => {
  console.log(`[osss] Listening on http://${config.host}:${config.port}`);
  console.log(`[osss] Database: ${config.dbPath}`);
});

function shutdown(): void {
  console.log("[osss] Shutting down...");
  server.close(() => {
    storage.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
