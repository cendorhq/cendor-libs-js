/**
 * Content-addressed store (CCR) backends for squeeze — the TS port of `cendor.squeeze.store`.
 *
 * The original of every compression is kept keyed by its hash so `handle.expand()` is exact.
 * `MemoryStore` (the default) keeps originals in-process; `SQLiteStore` persists them to a local
 * file so they survive the process and dedupe across runs. A backend is any object with
 * `get(key) -> string` and `put(key, value) -> void`; swap one in via `useStore(...)`.
 */
import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';

/** Thrown when a key is absent from a store (mirrors Python's `KeyError`). */
export class KeyError extends Error {
  constructor(key?: string) {
    super(key);
    this.name = 'KeyError';
  }
}

/** The minimal CCR backend contract: content-addressed `get`/`put`. */
export interface StoreBackend {
  get(key: string): string;
  put(key: string, value: string): void;
}

/**
 * In-process CCR store (the default). Fast, ephemeral, deduped by key.
 *
 * `maxItems` bounds the store with a least-recently-used (LRU) policy: reading a key (`get`) or
 * re-storing it (`put`) refreshes its recency, so a handle you keep expanding survives eviction and
 * only genuinely-cold originals are dropped. Expanding a handle whose original was evicted throws
 * `KeyError` — the documented trade-off of a capped store. `null` (default) means unbounded (no
 * eviction, so recency is not tracked).
 *
 * @example
 * ```ts
 * import { MemoryStore, useStore } from '@cendor/squeeze';
 * useStore(new MemoryStore(1000));   // bounded LRU: keep the 1000 most-recent originals
 * ```
 */
export class MemoryStore implements StoreBackend {
  private readonly data = new Map<string, string>();
  private readonly max: number | null;

  constructor(maxItems: number | null = null) {
    this.max = maxItems;
  }

  get(key: string): string {
    if (!this.data.has(key)) throw new KeyError(key);
    const value = this.data.get(key) as string;
    if (this.max !== null) {
      // LRU: mark as most-recently-used (delete + reinsert moves it to the tail).
      this.data.delete(key);
      this.data.set(key, value);
    }
    return value;
  }

  put(key: string, value: string): void {
    if (this.data.has(key)) {
      if (this.max !== null) {
        // re-put refreshes recency; content-addressed, so the value is identical anyway.
        const existing = this.data.get(key) as string;
        this.data.delete(key);
        this.data.set(key, existing);
      }
      return;
    }
    this.data.set(key, value);
    if (this.max !== null) {
      while (this.data.size > this.max) {
        // evict the least-recently-used (the front / oldest entry).
        const oldest = this.data.keys().next().value as string;
        this.data.delete(oldest);
      }
    }
  }

  has(key: string): boolean {
    return this.data.has(key);
  }

  get size(): number {
    return this.data.size;
  }
}

/**
 * Local SQLite CCR store: originals persist across processes, deduped by key (via `better-sqlite3`,
 * a synchronous, optional dependency — required only when this class is constructed).
 *
 * Writes are idempotent `INSERT OR IGNORE`s (content-addressed), so concurrent puts of the same
 * content are safe. `path` may be a file path or `":memory:"`.
 *
 * @example
 * ```ts
 * import { SQLiteStore, useStore } from '@cendor/squeeze';
 * useStore(new SQLiteStore('cache.db'));   // capital 'SQL' — SQLiteStore, not SqliteStore
 * ```
 */
export class SQLiteStore implements StoreBackend {
  private readonly db: BetterSqlite3.Database;

  constructor(path: string) {
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3') as typeof BetterSqlite3;
    this.db = new Database(path);
    this.db.exec('CREATE TABLE IF NOT EXISTS ccr (key TEXT PRIMARY KEY, value TEXT)');
  }

  get(key: string): string {
    const row = this.db.prepare('SELECT value FROM ccr WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    if (row === undefined) throw new KeyError(key);
    return row.value;
  }

  put(key: string, value: string): void {
    this.db.prepare('INSERT OR IGNORE INTO ccr (key, value) VALUES (?, ?)').run(key, value);
  }

  has(key: string): boolean {
    return this.db.prepare('SELECT 1 FROM ccr WHERE key = ?').get(key) !== undefined;
  }

  get size(): number {
    const row = this.db.prepare('SELECT count(*) AS c FROM ccr').get() as { c: number };
    return row.c;
  }

  close(): void {
    this.db.close();
  }
}
