import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

export interface Entry {
  value: unknown;
  version: number;
  updatedAt: number;
}

export interface WriteOptions {
  /** Expected current version. 0 means the key must not exist yet. */
  ifVersion?: number;
  /** The server making the write, checked against any session lock on the key. */
  lockOwner?: string;
}

export interface Lock {
  owner: string;
  expiresAt: number;
}

export class VersionConflictError extends Error {
  current: Entry | null;

  constructor(current: Entry | null) {
    super("The value was changed by someone else. Read it again and retry.");
    this.current = current;
  }
}

export class LockedError extends Error {
  lock: Lock;

  constructor(lock: Lock) {
    super("The key is locked by another server.");
    this.lock = lock;
  }
}

export class NotANumberError extends Error {
  constructor() {
    super("The stored value is not a number, so it can't be incremented.");
  }
}

export class HistoryNotFoundError extends Error {
  constructor() {
    super("That version isn't in this key's history. It may have been pruned.");
  }
}

/** One recorded write. Also used as the change feed: ids only ever go up. */
export interface Change {
  id: number;
  key: string;
  op: "set" | "remove";
  version: number;
  updatedAt: number;
  /** Lock owner of the server that made the write, if it sent one. */
  author: string | null;
}

export interface StorageOptions {
  /** How many versions of each key to keep in history. At least 1. */
  historyVersions?: number;
}

interface HistoryRow {
  id: number;
  key: string;
  op: "set" | "remove";
  version: number;
  value: string | null;
  author: string | null;
  updated_at: number;
}

interface EntryRow {
  value: string;
  version: number;
  updated_at: number;
}

interface LockRow {
  owner: string;
  expires_at: number;
}

/** Emits "change" with the store name after every write. */
export class Storage extends EventEmitter {
  #db: DatabaseSync;
  #historyVersions: number;

  constructor(path: string, options: StorageOptions = {}) {
    super();
    this.setMaxListeners(0); // one listener per waiting change-feed request
    this.#historyVersions = Math.max(1, options.historyVersions ?? 20);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS entries (
        store TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (store, key)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS locks (
        store TEXT NOT NULL,
        key TEXT NOT NULL,
        owner TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (store, key)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        store TEXT NOT NULL,
        key TEXT NOT NULL,
        op TEXT NOT NULL,
        version INTEGER NOT NULL,
        value TEXT,
        author TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS history_by_key ON history (store, key, id);
      CREATE INDEX IF NOT EXISTS history_by_store ON history (store, id);
      CREATE INDEX IF NOT EXISTS history_by_time ON history (updated_at);
    `);
  }

  get(store: string, key: string): Entry | null {
    const row = this.#db
      .prepare("SELECT value, version, updated_at FROM entries WHERE store = ? AND key = ?")
      .get(store, key) as EntryRow | undefined;
    if (!row) return null;
    return { value: JSON.parse(row.value), version: row.version, updatedAt: row.updated_at };
  }

  set(store: string, key: string, value: unknown, options: WriteOptions = {}): Entry {
    this.#assertUnlocked(store, key, options.lockOwner);
    const current = this.get(store, key);
    if (options.ifVersion !== undefined && options.ifVersion !== (current?.version ?? 0)) {
      throw new VersionConflictError(current);
    }
    return this.#write(store, key, value, (current?.version ?? 0) + 1, options.lockOwner);
  }

  remove(store: string, key: string, options: WriteOptions = {}): Entry | null {
    this.#assertUnlocked(store, key, options.lockOwner);
    const current = this.get(store, key);
    if (options.ifVersion !== undefined && options.ifVersion !== (current?.version ?? 0)) {
      throw new VersionConflictError(current);
    }
    if (current) {
      this.#db.prepare("DELETE FROM entries WHERE store = ? AND key = ?").run(store, key);
      this.#record(store, key, "remove", current.version, null, options.lockOwner, Date.now());
    }
    return current;
  }

  increment(store: string, key: string, delta: number, options: WriteOptions = {}): Entry {
    this.#assertUnlocked(store, key, options.lockOwner);
    const current = this.get(store, key);
    const base = current?.value ?? 0;
    if (typeof base !== "number") throw new NotANumberError();
    return this.#write(store, key, base + delta, (current?.version ?? 0) + 1, options.lockOwner);
  }

  /** Recent versions of a key, newest first, without their values. */
  history(store: string, key: string, limit: number): (Change & { size: number })[] {
    const rows = this.#db
      .prepare(
        `SELECT id, key, op, version, author, updated_at, length(value) AS size FROM history
         WHERE store = ? AND key = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(store, key, limit) as (Omit<HistoryRow, "value"> & { size: number | null })[];
    return rows.map((row) => ({ ...toChange(row), size: row.size ?? 0 }));
  }

  /** One version from a key's history, with its value. */
  historyEntry(store: string, key: string, id: number): (Change & { value: unknown }) | null {
    const row = this.#db
      .prepare("SELECT id, key, op, version, value, author, updated_at FROM history WHERE store = ? AND key = ? AND id = ?")
      .get(store, key, id) as HistoryRow | undefined;
    if (!row) return null;
    return { ...toChange(row), value: row.value === null ? null : JSON.parse(row.value) };
  }

  /** Writes an old version's value back as a new version. */
  restore(store: string, key: string, id: number, options: WriteOptions = {}): Entry {
    const old = this.historyEntry(store, key, id);
    if (!old || old.op !== "set") throw new HistoryNotFoundError();
    return this.set(store, key, old.value, options);
  }

  /** Writes to a store after the change with id `since`, oldest first, with their values. */
  changes(store: string, since: number, limit: number): (Change & { value: unknown })[] {
    const rows = this.#db
      .prepare(
        `SELECT id, key, op, version, value, author, updated_at FROM history
         WHERE store = ? AND id > ? ORDER BY id LIMIT ?`,
      )
      .all(store, since, limit) as unknown as HistoryRow[];
    return rows.map((row) => ({ ...toChange(row), value: row.value === null ? null : JSON.parse(row.value) }));
  }

  /** The newest and oldest change ids still kept, across all stores. 0 if there are none. */
  changeIds(): { latest: number; oldest: number } {
    const row = this.#db.prepare("SELECT MAX(id) AS latest, MIN(id) AS oldest FROM history").get() as {
      latest: number | null;
      oldest: number | null;
    };
    return { latest: row.latest ?? 0, oldest: row.oldest ?? 0 };
  }

  /** Deletes history older than maxAgeMs, but always keeps each key's newest version. Returns rows deleted. */
  pruneHistory(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    return Number(
      this.#db
        .prepare(
          `DELETE FROM history WHERE updated_at < ?
           AND id NOT IN (SELECT MAX(id) FROM history GROUP BY store, key)`,
        )
        .run(cutoff).changes,
    );
  }

  list(store: string, prefix: string, cursor: string, limit: number): { keys: string[]; nextCursor: string | null } {
    const rows = this.#db
      .prepare(
        "SELECT key FROM entries WHERE store = ? AND substr(key, 1, ?) = ? AND key > ? ORDER BY key LIMIT ?",
      )
      .all(store, prefix.length, prefix, cursor, limit + 1) as { key: string }[];
    const keys = rows.slice(0, limit).map((row) => row.key);
    return { keys, nextCursor: rows.length > limit ? keys[keys.length - 1] : null };
  }

  /** Keys whose value is a number, sorted by that number. Used for leaderboards. */
  sorted(
    store: string,
    options: { descending: boolean; limit: number; offset: number; min?: number; max?: number },
  ): { entries: { key: string; value: number }[]; nextCursor: string | null } {
    const filters = ["store = ?", "json_type(value) IN ('integer', 'real')"];
    const params: (string | number)[] = [store];
    if (options.min !== undefined) {
      filters.push("CAST(value AS REAL) >= ?");
      params.push(options.min);
    }
    if (options.max !== undefined) {
      filters.push("CAST(value AS REAL) <= ?");
      params.push(options.max);
    }
    const direction = options.descending ? "DESC" : "ASC";
    const rows = this.#db
      .prepare(
        `SELECT key, value FROM entries WHERE ${filters.join(" AND ")}
         ORDER BY CAST(value AS REAL) ${direction}, key LIMIT ? OFFSET ?`,
      )
      .all(...params, options.limit + 1, options.offset) as { key: string; value: string }[];
    const entries = rows.slice(0, options.limit).map((row) => ({ key: row.key, value: Number(row.value) }));
    const hasMore = rows.length > options.limit;
    return { entries, nextCursor: hasMore ? String(options.offset + options.limit) : null };
  }

  listStores(): { name: string; keys: number }[] {
    return this.#db
      .prepare("SELECT store AS name, COUNT(*) AS keys FROM entries GROUP BY store ORDER BY store")
      .all() as { name: string; keys: number }[];
  }

  getLock(store: string, key: string): Lock | null {
    return this.#activeLock(store, key);
  }

  /** Removes a lock no matter who holds it. For admins clearing a stuck lock. */
  forceUnlock(store: string, key: string): boolean {
    return this.#db.prepare("DELETE FROM locks WHERE store = ? AND key = ?").run(store, key).changes > 0;
  }

  *exportAll(): Generator<{ store: string; key: string } & Entry> {
    const rows = this.#db
      .prepare("SELECT store, key, value, version, updated_at FROM entries ORDER BY store, key")
      .iterate() as Iterable<EntryRow & { store: string; key: string }>;
    for (const row of rows) {
      yield { store: row.store, key: row.key, value: JSON.parse(row.value), version: row.version, updatedAt: row.updated_at };
    }
  }

  /** Writes a consistent copy of the database to path. Safe while the server is running. */
  async backupTo(path: string): Promise<void> {
    mkdirSync(dirname(path), { recursive: true });
    await backup(this.#db, path);
  }

  /** Takes or renews a session lock. Throws LockedError if another owner holds it. */
  lock(store: string, key: string, owner: string, ttlMs: number): Lock {
    const existing = this.#activeLock(store, key);
    if (existing && existing.owner !== owner) throw new LockedError(existing);
    const lock = { owner, expiresAt: Date.now() + ttlMs };
    this.#db
      .prepare(
        `INSERT INTO locks (store, key, owner, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (store, key) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at`,
      )
      .run(store, key, lock.owner, lock.expiresAt);
    return lock;
  }

  /** Releases a lock held by owner. Returns false if owner didn't hold it. */
  unlock(store: string, key: string, owner: string): boolean {
    const result = this.#db
      .prepare("DELETE FROM locks WHERE store = ? AND key = ? AND owner = ?")
      .run(store, key, owner);
    return result.changes > 0;
  }

  transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.#db.close();
  }

  #write(store: string, key: string, value: unknown, version: number, author: string | undefined): Entry {
    const entry = { value, version, updatedAt: Date.now() };
    const json = JSON.stringify(value);
    this.#db
      .prepare(
        `INSERT INTO entries (store, key, value, version, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (store, key) DO UPDATE SET
           value = excluded.value, version = excluded.version, updated_at = excluded.updated_at`,
      )
      .run(store, key, json, entry.version, entry.updatedAt);
    this.#record(store, key, "set", version, json, author, entry.updatedAt);
    return entry;
  }

  #record(
    store: string,
    key: string,
    op: "set" | "remove",
    version: number,
    json: string | null,
    author: string | undefined,
    updatedAt: number,
  ): void {
    this.#db
      .prepare("INSERT INTO history (store, key, op, version, value, author, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(store, key, op, version, json, author ?? null, updatedAt);
    // Keep only the newest versions of this key.
    this.#db
      .prepare(
        `DELETE FROM history WHERE store = ? AND key = ? AND id < (
           SELECT id FROM history WHERE store = ? AND key = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
      )
      .run(store, key, store, key, this.#historyVersions - 1);
    this.emit("change", store);
  }

  #activeLock(store: string, key: string): Lock | null {
    const row = this.#db
      .prepare("SELECT owner, expires_at FROM locks WHERE store = ? AND key = ?")
      .get(store, key) as LockRow | undefined;
    if (!row || row.expires_at <= Date.now()) return null;
    return { owner: row.owner, expiresAt: row.expires_at };
  }

  #assertUnlocked(store: string, key: string, owner: string | undefined): void {
    const lock = this.#activeLock(store, key);
    if (lock && lock.owner !== owner) throw new LockedError(lock);
  }
}

function toChange(row: Omit<HistoryRow, "value">): Change {
  return { id: row.id, key: row.key, op: row.op, version: row.version, updatedAt: row.updated_at, author: row.author };
}
