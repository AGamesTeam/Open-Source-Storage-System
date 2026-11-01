import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

interface EntryRow {
  value: string;
  version: number;
  updated_at: number;
}

interface LockRow {
  owner: string;
  expires_at: number;
}

export class Storage {
  #db: DatabaseSync;

  constructor(path: string) {
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
    return this.#write(store, key, value, (current?.version ?? 0) + 1);
  }

  remove(store: string, key: string, options: WriteOptions = {}): Entry | null {
    this.#assertUnlocked(store, key, options.lockOwner);
    const current = this.get(store, key);
    if (options.ifVersion !== undefined && options.ifVersion !== (current?.version ?? 0)) {
      throw new VersionConflictError(current);
    }
    this.#db.prepare("DELETE FROM entries WHERE store = ? AND key = ?").run(store, key);
    return current;
  }

  increment(store: string, key: string, delta: number, options: WriteOptions = {}): Entry {
    this.#assertUnlocked(store, key, options.lockOwner);
    const current = this.get(store, key);
    const base = current?.value ?? 0;
    if (typeof base !== "number") throw new NotANumberError();
    return this.#write(store, key, base + delta, (current?.version ?? 0) + 1);
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

  #write(store: string, key: string, value: unknown, version: number): Entry {
    const entry = { value, version, updatedAt: Date.now() };
    this.#db
      .prepare(
        `INSERT INTO entries (store, key, value, version, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (store, key) DO UPDATE SET
           value = excluded.value, version = excluded.version, updated_at = excluded.updated_at`,
      )
      .run(store, key, JSON.stringify(value), entry.version, entry.updatedAt);
    return entry;
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
