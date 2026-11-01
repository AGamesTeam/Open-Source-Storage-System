import { readFileSync } from "node:fs";

export type Access = "read" | "write" | "admin";

export interface ApiKey {
  name: string;
  key: string;
  access: Access;
  /** Stores this key may use, or null for all of them. */
  stores: string[] | null;
}

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  keys: ApiKey[];
  maxBodyBytes: number;
  backupDir: string;
  /** Hours between automatic backups. 0 turns them off. */
  backupIntervalHours: number;
  /** How many automatic backups to keep. 0 keeps all of them. */
  backupKeep: number;
  /** A second folder (ideally another drive) that every backup is also copied to, or "" for none. */
  backupCopyDir: string;
  /** How many versions of each key to keep in history. At least 1. */
  historyVersions: number;
  /** Days of history to keep. 0 keeps it until it's pushed out by newer versions. */
  historyDays: number;
}

const MIN_KEY_LENGTH = 32;
const ACCESS_LEVELS: Access[] = ["read", "write", "admin"];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const keys: ApiKey[] = (env.OSSS_API_KEYS ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0)
    .map((key, i) => ({ name: `env-key-${i + 1}`, key, access: "admin", stores: null }));

  if (env.OSSS_KEYS_FILE) keys.push(...readKeysFile(env.OSSS_KEYS_FILE));

  if (keys.length === 0) {
    throw new Error("No API keys are set. Run `npm run gen-key` and put the key in OSSS_API_KEYS in your .env file.");
  }
  for (const { name, key } of keys) {
    if (key.length < MIN_KEY_LENGTH) {
      throw new Error(`API key "${name}" must be at least ${MIN_KEY_LENGTH} characters. Run \`npm run gen-key\` to make one.`);
    }
  }

  return {
    host: env.OSSS_HOST || "0.0.0.0",
    port: readInt(env, "OSSS_PORT", 8787),
    dbPath: env.OSSS_DB_PATH || "data/osss.db",
    keys,
    maxBodyBytes: readInt(env, "OSSS_MAX_BODY_BYTES", 16 * 1024 * 1024),
    backupDir: env.OSSS_BACKUP_DIR || "backups",
    backupIntervalHours: readInt(env, "OSSS_BACKUP_INTERVAL_HOURS", 0),
    backupKeep: readInt(env, "OSSS_BACKUP_KEEP", 14),
    backupCopyDir: env.OSSS_BACKUP_COPY_DIR || "",
    historyVersions: Math.max(1, readInt(env, "OSSS_HISTORY_VERSIONS", 20)),
    historyDays: readInt(env, "OSSS_HISTORY_DAYS", 30),
  };
}

export function hasAccess(key: ApiKey, needed: Access, store?: string): boolean {
  if (ACCESS_LEVELS.indexOf(key.access) < ACCESS_LEVELS.indexOf(needed)) return false;
  return store === undefined || key.stores === null || key.stores.includes(store);
}

function readKeysFile(path: string): ApiKey[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Couldn't read OSSS_KEYS_FILE (${path}): ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("OSSS_KEYS_FILE must contain a JSON array of keys.");

  return parsed.map((entry, i): ApiKey => {
    const where = `OSSS_KEYS_FILE entry ${i + 1}`;
    if (typeof entry !== "object" || entry === null) throw new Error(`${where} must be an object.`);
    const { name, key, access = "write", stores = null } = entry as Record<string, unknown>;
    if (typeof key !== "string") throw new Error(`${where} needs a "key" string.`);
    if (!ACCESS_LEVELS.includes(access as Access)) {
      throw new Error(`${where} has "access" set to ${JSON.stringify(access)}. Use "read", "write" or "admin".`);
    }
    if (stores !== null && !(Array.isArray(stores) && stores.every((s) => typeof s === "string"))) {
      throw new Error(`${where} has "stores" set to something other than a list of store names.`);
    }
    return {
      name: typeof name === "string" && name !== "" ? name : `file-key-${i + 1}`,
      key,
      access: access as Access,
      stores: stores as string[] | null,
    };
  });
}

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a whole number, got "${raw}".`);
  }
  return value;
}
