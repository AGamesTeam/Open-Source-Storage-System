import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import { LockedError, NotANumberError, VersionConflictError, type Entry, type Storage } from "./storage.ts";

const MAX_NAME_LENGTH = 512;
const MAX_LIST_LIMIT = 1000;
const MAX_BATCH_OPERATIONS = 100;
const MAX_LOCK_TTL_SECONDS = 24 * 60 * 60;

export class HttpError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;

  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

type Json = Record<string, unknown>;

export function createApp(config: Config, storage: Storage): Server {
  const keyHashes = config.apiKeys.map(hash);

  function isAuthorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Bearer ")) return false;
    const given = hash(header.slice("Bearer ".length));
    // Check every key so the response time doesn't reveal which one matched.
    let match = false;
    for (const expected of keyHashes) match = timingSafeEqual(given, expected) || match;
    return match;
  }

  async function route(req: IncomingMessage): Promise<[number, Json]> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter((part) => part !== "");
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === "/health") return [200, { ok: true }];
    if (!isAuthorized(req)) throw new HttpError(401, "unauthorized", "Missing or invalid API key.");

    const lockOwner = readLockOwner(req);

    if (parts[0] !== "v1") throw notFound();

    if (parts.length === 2 && parts[1] === "batch" && method === "POST") {
      const body = await readJson(req, config.maxBodyBytes);
      return [200, { results: runBatch(storage, body, lockOwner) }];
    }

    if (parts[1] !== "stores" || parts.length < 4 || parts[3] !== "keys") throw notFound();
    const store = readPathName(parts[2], "store");

    if (parts.length === 4) {
      if (method !== "GET") throw methodNotAllowed();
      const limit = Math.min(readInt(url.searchParams.get("limit"), 100, "limit"), MAX_LIST_LIMIT);
      const prefix = url.searchParams.get("prefix") ?? "";
      const cursor = url.searchParams.get("cursor") ?? "";
      return [200, storage.list(store, prefix, cursor, Math.max(limit, 1))];
    }

    const key = readPathName(parts[4], "key");

    if (parts.length === 5) {
      switch (method) {
        case "GET": {
          const entry = storage.get(store, key);
          if (!entry) throw new HttpError(404, "not_found", "No value is stored for this key.");
          return [200, entryJson(entry)];
        }
        case "PUT": {
          const body = await readJson(req, config.maxBodyBytes);
          if (!("value" in body)) throw badRequest("Body must include `value`.");
          const entry = storage.set(store, key, body.value, { ifVersion: readVersion(body.ifVersion), lockOwner });
          return [200, metaJson(entry)];
        }
        case "DELETE": {
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
      const body = await readJson(req, config.maxBodyBytes);
      return [200, entryJson(storage.increment(store, key, readDelta(body.delta), { lockOwner }))];
    }

    if (parts.length === 6 && parts[5] === "lock") {
      if (!lockOwner) throw badRequest("Locking needs an `OSSS-Lock-Owner` header.");
      if (method === "POST") {
        const body = await readJson(req, config.maxBodyBytes);
        const ttl = readTtl(body.ttlSeconds);
        return [200, { ...storage.lock(store, key, lockOwner, ttl * 1000) }];
      }
      if (method === "DELETE") return [200, { released: storage.unlock(store, key, lockOwner) }];
      throw methodNotAllowed();
    }

    throw notFound();
  }

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let status: number;
    let body: Json;
    try {
      [status, body] = await route(req);
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

function runBatch(storage: Storage, body: Json, lockOwner: string | undefined): Json[] {
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
  if (err instanceof HttpError) return [err.status, { error: err.code, message: err.message, ...err.extra }];
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

function readInt(raw: string | null, fallback: number, label: string): number {
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw badRequest(`\`${label}\` must be a whole number.`);
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
