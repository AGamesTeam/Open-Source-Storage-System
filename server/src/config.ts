export interface Config {
  host: string;
  port: number;
  dbPath: string;
  apiKeys: string[];
  maxBodyBytes: number;
}

const MIN_KEY_LENGTH = 32;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKeys = (env.OSSS_API_KEYS ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

  if (apiKeys.length === 0) {
    throw new Error("OSSS_API_KEYS is not set. Run `npm run gen-key` and put the key in your .env file.");
  }
  if (apiKeys.some((key) => key.length < MIN_KEY_LENGTH)) {
    throw new Error(`Every API key must be at least ${MIN_KEY_LENGTH} characters. Run \`npm run gen-key\` to make one.`);
  }

  return {
    host: env.OSSS_HOST || "0.0.0.0",
    port: readInt(env, "OSSS_PORT", 8787),
    dbPath: env.OSSS_DB_PATH || "data/osss.db",
    apiKeys,
    maxBodyBytes: readInt(env, "OSSS_MAX_BODY_BYTES", 16 * 1024 * 1024),
  };
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
