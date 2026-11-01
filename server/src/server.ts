import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { hasAccess, type Access, type ApiKey, type Config } from "./config.ts";
import { LockedError, NotANumberError, VersionConflictError, type Entry, type Storage } from "./storage.ts";

const MAX_NAME_LENGTH = 512;
const MAX_LIST_LIMIT = 1000;
const MAX_BATCH_OPERATIONS = 100;
const MAX_LOCK_TTL_SECONDS = 24 * 60 * 60;

const DASHBOARD_HTML = readFileSync(new URL("../public/dashboard.html", import.meta.url));
const DASHBOARD_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Json = Record<string, unknown>;

export function createApp(config: Config, storage: Storage): Server {
  const keys = config.keys.map((key) => ({ key, hash: hash(key.key) }));

  function authenticate(req: IncomingMessage): ApiKey | null {
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Bearer ")) return null;
    const given = hash(header.slice("Bearer ".length));
    // Check every key so the response time doesn't reveal which one matched.
    let found: ApiKey | null = null;
    for (const { key, hash } of keys) {
      if (timingSafeEqual(given, hash)) found = key;
    }
    return found;
  }

  async function route(req: IncomingMessage, url: URL): Promise<[number, Json]> {
    const parts = url.pathname.split("/").filter((part) => part !== "");
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === "/health") return [200, { ok: true }];
    const apiKey = authenticate(req);
    if (!apiKey) throw new HttpError(401, "unauthorized", "Missing or invalid API key.");

    const need = (access: Access, store?: string): void => {
      if (!hasAccess(apiKey, access, store)) {
        const what = store === undefined ? "do this" : `${access} the store "${store}"`;
        throw new HttpError(403, "forbidden", `The API key "${apiKey.name}" isn't allowed to ${what}.`);
      }
    };
    const lockOwner = readLockOwner(req);

    if (parts[0] !== "v1") throw notFound();

    if (parts.length === 2 && parts[1] === "whoami" && method === "GET") {
      return [200, { name: apiKey.name, access: apiKey.access, stores: apiKey.stores }];
    }

    if (parts.length === 2 && parts[1] === "batch" && method === "POST") {
      const body = await readJson(req, config.maxBodyBytes);
      return [200, { results: runBatch(storage, body, lockOwner, need) }];
    }

    if (parts[1] !== "stores") throw notFound();

    if (parts.length === 2) {
      if (method !== "GET") throw methodNotAllowed();
      need("read");
      const stores = storage.listStores().filter((s) => hasAccess(apiKey, "read", s.name));
      return [200, { stores }];
    }

    const store = readPathName(parts[2], "store");

    if (parts.length === 4 && parts[3] === "sorted") {
      if (method !== "GET") throw methodNotAllowed();
      need("read", store);
      const order = url.searchParams.get("order") ?? "desc";
      if (order !== "asc" && order !== "desc") throw badRequest("`order` must be `asc` or `desc`.");
      return [
        200,
        storage.sorted(store, {
          descending: order === "desc",
          limit: readLimit(url),
          offset: readInt(url.searchParams.get("cursor"), 0, "cursor"),
          min: readOptionalNumber(url.searchParams.get("min"), "min"),
          max: readOptionalNumber(url.searchParams.get("max"), "max"),
        }),
      ];
    }

    if (parts.length < 4 || parts[3] !== "keys") throw notFound();

    if (parts.length === 4) {
      if (method !== "GET") throw methodNotAllowed();
      need("read", store);
      const prefix = url.searchParams.get("prefix") ?? "";
      const cursor = url.searchParams.get("cursor") ?? "";
      return [200, storage.list(store, prefix, cursor, readLimit(url))];
    }

    const key = readPathName(parts[4], "key");

    if (parts.length === 5) {
      switch (method) {
        case "GET": {
          need("read", store);
          const entry = storage.get(store, key);
          if (!entry) throw new HttpError(404, "not_found", "No value is stored for this key.");
          return [200, entryJson(entry)];
        }
        case "PUT": {
          need("write", store);
          const body = await readJson(req, config.maxBodyBytes);
          if (!("value" in body)) throw badRequest("Body must include `value`.");
          const entry = storage.set(store, key, body.value, { ifVersion: readVersion(body.ifVersion), lockOwner });
          return [200, metaJson(entry)];
        }
        case "DELETE": {
          need("write", store);
          const ifVersion = readVersion(url.searchParams.get("ifVersion") ?? undefined);
          const removed = storage.remove(store, key, { ifVersion, lockOwner });
          if (!removed) throw new HttpError(404, "not_found", "No value is stored for this key.");
          return [200, entryJson(removed)];
        }
        default:
          throw methodNotAllowed();
      }
    }

    if (parts.length === 6 && parts[5] === "increment") {
      if (method !== "POST") throw methodNotAllowed();
      need("write", store);
      const body = await readJson(req, config.maxBodyBytes);
      return [200, entryJson(storage.increment(store, key, readDelta(body.delta), { lockOwner }))];
    }

    if (parts.length === 6 && parts[5] === "lock") {
      if (method === "GET") {
        need("read", store);
        return [200, { lock: storage.getLock(store, key) }];
      }
      if (method === "DELETE" && url.searchParams.get("force") === "true") {
        need("admin", store);
        return [200, { released: storage.forceUnlock(store, key) }];
      }
      need("write", store);
      if (!lockOwner) throw badRequest("Locking needs an `OSSS-Lock-Owner` header.");
      if (method === "POST") {
        const body = await readJson(req, config.maxBodyBytes);
        return [200, { ...storage.lock(store, key, lockOwner, readTtl(body.ttlSeconds) * 1000) }];
      }
      if (method === "DELETE") return [200, { released: storage.unlock(store, key, lockOwner) }];
      throw methodNotAllowed();
    }

    throw notFound();
  }

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
      res.writeHead(200, DASHBOARD_HEADERS);
      res.end(DASHBOARD_HTML);
      return;
    }

    let status: number;
    let body: Json;
    try {
      [status, body] = await route(req, url);
    } catch (err) {
      [status, body] = errorResponse(err);
    }
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  });
}

function runBatch(
  storage: Storage,
  body: Json,
  lockOwner: string | undefined,
  need: (access: Access, store?: string) => void,
): Json[] {
  const operations = body.operations;
  if (!Array.isArray(operations)) throw badRequest("Body must include an `operations` array.");
  if (operations.length > MAX_BATCH_OPERATIONS) {
    throw badRequest(`A batch can have at most ${MAX_BATCH_OPERATIONS} operations.`);
  }

  return storage.transaction(() =>
    operations.map((op: Json): Json => {
      try {
        if (typeof op !== "object" || op === null) throw badRequest("Each operation must be an object.");
        const store = readName(op.store, "store");
        const key = readName(op.key, "key");
        need(op.op === "get" ? "read" : "write", store);
        switch (op.op) {
          case "get": {
            const entry = storage.get(store, key);
            return entry ? { ok: true, ...entryJson(entry) } : { ok: true, value: null, version: 0 };
          }
          case "set": {
            if (!("value" in op)) throw badRequest("A `set` operation must include `value`.");
            const entry = storage.set(store, key, op.value, { ifVersion: readVersion(op.ifVersion), lockOwner });
            return { ok: true, ...metaJson(entry) };
          }
          case "remove": {
            const removed = storage.remove(store, key, { ifVersion: readVersion(op.ifVersion), lockOwner });
            return removed ? { ok: true, ...entryJson(removed) } : { ok: true, value: null, version: 0 };
          }
          case "increment":
            return { ok: true, ...entryJson(storage.increment(store, key, readDelta(op.delta), { lockOwner })) };
          default:
            throw badRequest("`op` must be one of: get, set, remove, increment.");
        }
      } catch (err) {
        const [status, error] = errorResponse(err);
        return { ok: false, status, ...error };
      }
    }),
  );
}

function errorResponse(err: unknown): [number, Json] {
  if (err instanceof HttpError) return [err.status, { error: err.code, message: err.message }];
  if (err instanceof VersionConflictError) {
    return [409, { error: "version_conflict", message: err.message, current: err.current && entryJson(err.current) }];
  }
  if (err instanceof LockedError) {
    return [423, { error: "locked", message: err.message, owner: err.lock.owner, expiresAt: err.lock.expiresAt }];
  }
  if (err instanceof NotANumberError) return [409, { error: "not_a_number", message: err.message }];
  console.error(err);
  return [500, { error: "internal", message: "Something went wrong on the server." }];
}

function entryJson(entry: Entry): Json {
  return { value: entry.value, version: entry.version, updatedAt: entry.updatedAt };
}

function metaJson(entry: Entry): Json {
  return { version: entry.version, updatedAt: entry.updatedAt };
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<Json> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > maxBytes) throw tooLarge(maxBytes);

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw tooLarge(maxBytes);
    chunks.push(chunk);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw badRequest("Body must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw badRequest("Body must be a JSON object.");
  }
  return parsed as Json;
}

function readLockOwner(req: IncomingMessage): string | undefined {
  const header = req.headers["osss-lock-owner"];
  const owner = Array.isArray(header) ? header[0] : header;
  return owner ? owner.slice(0, MAX_NAME_LENGTH) : undefined;
}

function readPathName(raw: string, label: string): string {
  try {
    return readName(decodeURIComponent(raw), label);
  } catch (err) {
    if (err instanceof URIError) throw badRequest(`\`${label}\` is not correctly URL-encoded.`);
    throw err;
  }
}

function readName(name: unknown, label: string): string {
  if (typeof name !== "string") throw badRequest(`\`${label}\` must be a string.`);
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw badRequest(`\`${label}\` must be 1 to ${MAX_NAME_LENGTH} characters.`);
  }
  return name;
}

function readVersion(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const version = typeof raw === "string" ? Number(raw) : raw;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw badRequest("`ifVersion` must be a whole number, 0 or more.");
  }
  return version;
}

function readDelta(raw: unknown): number {
  if (raw === undefined) return 1;
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw badRequest("`delta` must be a number.");
  return raw;
}

function readTtl(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > MAX_LOCK_TTL_SECONDS) {
    throw badRequest(`\`ttlSeconds\` must be a number from 1 to ${MAX_LOCK_TTL_SECONDS}.`);
  }
  return raw;
}

function readLimit(url: URL): number {
  return Math.max(1, Math.min(readInt(url.searchParams.get("limit"), 100, "limit"), MAX_LIST_LIMIT));
}

function readInt(raw: string | null, fallback: number, label: string): number {
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw badRequest(`\`${label}\` must be a whole number.`);
  return value;
}

function readOptionalNumber(raw: string | null, label: string): number | undefined {
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw badRequest(`\`${label}\` must be a number.`);
  return value;
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function badRequest(message: string): HttpError {
  return new HttpError(400, "bad_request", message);
}

function notFound(): HttpError {
  return new HttpError(404, "not_found", "Unknown endpoint.");
}

function methodNotAllowed(): HttpError {
  return new HttpError(405, "method_not_allowed", "This endpoint doesn't support that method.");
}

function tooLarge(maxBytes: number): HttpError {
  return new HttpError(413, "too_large", `Request body is larger than the ${maxBytes}-byte limit.`);
}
