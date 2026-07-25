/**
 * Pluggable spend sinks for tokenguard (the `@cendor/tokenguard/sinks` subpath). A sink satisfies
 * `@cendor/core`'s `Sink` protocol (`write(entry)`; optional `flush()` / `close()`). tokenguard's
 * default is in-memory (`report()` aggregation); attach one of these to also persist each spend row.
 *
 * Each `write` receives `{ tags, usd, input_tokens, output_tokens, reasoning_tokens, model }` —
 * `usd` is the Decimal as a string (never a float), and `reasoning_tokens` is a subset of
 * `output_tokens`.
 */
import { createRequire } from 'node:module';
import type { Sink } from '@cendor/core';
import Database from 'better-sqlite3';

type DatabaseInstance = InstanceType<typeof Database>;

/** A spend row as delivered to a sink's `write`. */
export interface SpendEntry {
  tags: Record<string, unknown>;
  usd: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens?: number;
  model: string;
}

/** `JSON.stringify` with top-level keys sorted (parity with Python's `json.dumps(sort_keys=True)`). */
function stableJson(obj: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) sorted[key] = obj[key];
  return JSON.stringify(sorted);
}

/** A row read back from {@link SQLiteSink.rows}: `[tags, usd, input, output, reasoning, model]`. */
export type SQLiteRow = [string, string, number, number, number, string];

interface RawSQLiteRow {
  tags: string;
  usd: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  model: string;
}

/**
 * Persist each spend row to a local SQLite database via `better-sqlite3` (synchronous; no network).
 * `better-sqlite3` is a synchronous binding, so — unlike the Python `sqlite3` original — no
 * cross-thread lock is needed (JS is single-threaded). `usd` is stored as TEXT (the Decimal string);
 * `tags` as JSON with sorted keys.
 */
export class SQLiteSink {
  private readonly db: DatabaseInstance;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS spend (' +
        'tags TEXT, usd TEXT, input_tokens INTEGER, output_tokens INTEGER, ' +
        'reasoning_tokens INTEGER, model TEXT)',
    );
  }

  write(entry: SpendEntry): void {
    this.db
      .prepare(
        'INSERT INTO spend ' +
          '(tags, usd, input_tokens, output_tokens, reasoning_tokens, model) ' +
          'VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        stableJson(entry.tags ?? {}),
        String(entry.usd),
        Number(entry.input_tokens),
        Number(entry.output_tokens),
        Number(entry.reasoning_tokens ?? 0),
        String(entry.model),
      );
  }

  /** All rows: `[tags_json, usd, input_tokens, output_tokens, reasoning_tokens, model]`. */
  rows(): SQLiteRow[] {
    const raw = this.db
      .prepare(
        'SELECT tags, usd, input_tokens, output_tokens, reasoning_tokens, model ' +
          'FROM spend ORDER BY rowid',
      )
      .all() as RawSQLiteRow[];
    return raw.map((r) => [
      r.tags,
      r.usd,
      r.input_tokens,
      r.output_tokens,
      r.reasoning_tokens,
      r.model,
    ]);
  }

  close(): void {
    this.db.close();
  }
}

// --------------------------------------------------------------------------- QueueSink

/** Sentinel enqueued by {@link QueueSink.close} to tell the drain loop to stop. */
const SHUTDOWN = Symbol('cendor.tokenguard.queuesink.shutdown');

function optionalMethod(obj: unknown, name: string): (() => void | Promise<void>) | null {
  if (obj == null || typeof obj !== 'object') return null;
  const fn = (obj as Record<string, unknown>)[name];
  return typeof fn === 'function' ? (fn as () => void | Promise<void>).bind(obj) : null;
}

/** Options for {@link QueueSink}. */
export interface QueueSinkOptions {
  /** Bound the in-flight queue; when full, `write()` awaits room (back-pressure — never drops a
   * row). `null`/omitted is unbounded. */
  maxQueue?: number | null;
  /** Called once per row the drainer drops because the inner sink's `write` **threw** (disk full, DB
   * locked). Receives `(error, entry)`. Its own throws are swallowed so it can't kill the drainer.
   * See {@link QueueSink.droppedRows}. */
  onDropError?: (error: unknown, entry: unknown) => void;
}

/**
 * Wrap any `Sink` so its writes drain off the hot path. The bus fans out to subscribers inline, so a
 * durable sink otherwise adds its I/O latency to every model call. `QueueSink` decouples that:
 * `write()` enqueues and returns immediately (a single async drain loop writes into the inner sink
 * in FIFO order), and `flush()` / `close()` guarantee durability at shutdown.
 *
 * Node is single-threaded, so — unlike the Python daemon-thread original — this is an in-memory FIFO
 * plus an async drain loop. Observable semantics are preserved: FIFO order, no dropped rows under
 * bounded back-pressure (`write` returns a Promise when it must await room), `write`-after-`close`
 * throws, idempotent `close`, inner `flush`→`close` ordering at close, and a bad inner-write does
 * not kill the drainer. A row the inner sink's `write` **throws** on is dropped so the failure can't
 * kill the drainer — those drops are observable via {@link droppedRows} and the `onDropError` option.
 */
export class QueueSink {
  private readonly inner: Sink;
  private readonly maxQueue: number | null;
  private readonly onDropError: ((error: unknown, entry: unknown) => void) | null;
  private dropped = 0;
  private readonly items: unknown[] = [];
  private closed = false;
  private shutdownRequested = false;
  private idle = false;
  private wakeup: (() => void) | null = null;
  private readonly roomWaiters: Array<() => void> = [];
  private idleWaiters: Array<() => void> = [];
  private readonly worker: Promise<void>;

  constructor(inner: Sink, opts: QueueSinkOptions = {}) {
    this.inner = inner;
    this.maxQueue = opts.maxQueue && opts.maxQueue > 0 ? opts.maxQueue : null;
    this.onDropError = opts.onDropError ?? null;
    this.worker = this.run();
  }

  /** Number of rows dropped because the inner sink's `write` threw (never kills the drainer). `0` in
   * the healthy path; a rising count flags a failing durable sink. */
  droppedRows(): number {
    return this.dropped;
  }

  private wake(): void {
    if (this.wakeup) {
      const w = this.wakeup;
      this.wakeup = null;
      w();
    }
  }

  private resolveIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  private async run(): Promise<void> {
    for (;;) {
      while (this.items.length === 0) {
        this.idle = true;
        this.resolveIdle();
        if (this.shutdownRequested) return;
        await new Promise<void>((resolve) => {
          this.wakeup = resolve;
        });
        this.idle = false;
      }
      const item = this.items.shift();
      const rw = this.roomWaiters.shift(); // a slot freed → release one back-pressure waiter
      if (rw) rw();
      if (item === SHUTDOWN) return;
      try {
        await Promise.resolve(this.inner.write(item));
      } catch (error) {
        // a bad row must not kill the worker — count it, notify, and carry on
        this.dropped += 1;
        if (this.onDropError !== null) {
          try {
            this.onDropError(error, item);
          } catch {
            // a broken callback must not kill the worker either
          }
        }
      }
    }
  }

  /** Enqueue a record for the drain loop. Returns synchronously unless a bounded queue is full, in
   * which case it returns a Promise that resolves once room frees (back-pressure). */
  write(entry: unknown): void | Promise<void> {
    if (this.closed) throw new Error('QueueSink.write() after close()');
    if (this.maxQueue !== null && this.items.length >= this.maxQueue) {
      return new Promise<void>((resolve) => {
        this.roomWaiters.push(() => {
          this.items.push(entry);
          this.wake();
          resolve();
        });
      });
    }
    this.items.push(entry);
    this.wake();
  }

  /** Block until every queued record is written and the inner sink is flushed. */
  async flush(): Promise<void> {
    if (!(this.items.length === 0 && this.idle)) {
      await new Promise<void>((resolve) => {
        this.idleWaiters.push(resolve);
      });
    }
    const innerFlush = optionalMethod(this.inner, 'flush');
    if (innerFlush) await innerFlush();
  }

  /** Drain the queue, stop the drain loop, and flush + close the inner sink (idempotent). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.shutdownRequested = true;
    this.items.push(SHUTDOWN); // after all enqueued rows (FIFO) — the loop drains them, then exits
    this.wake();
    await this.worker;
    for (const name of ['flush', 'close']) {
      const fn = optionalMethod(this.inner, name);
      if (fn) await fn();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

// --------------------------------------------------------------------------- OTelSink

/**
 * Emit OpenTelemetry counters per spend row if `@opentelemetry/api` is installed, else a no-op.
 * Loading is attempted synchronously via `createRequire` to mirror Python's synchronous
 * `from opentelemetry import metrics`; when the package is absent, `write` is a no-op. The three
 * metric names are byte-identical to the Python original.
 */
export interface OTelSinkOptions {
  /**
   * Dimension the counters by the active `track(...)` tags (feature / user_id / …) as well as
   * `model`, so a metrics backend can break spend down by attribution. Tag *values* become metric
   * attributes, so keep them **low-cardinality** (`feature`, `env`, `tenant` — not a raw per-user
   * id) or your backend's time-series count can explode. Default `true`; set `false` for model-only.
   */
  tags?: boolean;
}

type Counter = { add: (value: number, attrs: Record<string, unknown>) => void };

/** Is this a no-op instrument/provider (the JS metrics API has no proxy — see `ensureCounters`)? */
function isNoop(x: unknown): boolean {
  const name = (x as { constructor?: { name?: string } })?.constructor?.name ?? '';
  return /noop/i.test(name);
}

export class OTelSink {
  /** Marks this class as the OTel spend emitter, so tokenguard's internal telemetry tap can stand
   * down when the user has already wired one themselves (no double-counted spend). */
  readonly _cendorOtelSpend = true;
  private tokensCounter: Counter | null = null;
  private costCounter: Counter | null = null;
  private reasoningCounter: Counter | null = null;
  /** True once the counters came from a REAL meter provider — stop re-checking. */
  private bound = false;
  /** True when `@opentelemetry/api` isn't installed at all — never retry the require. */
  private absent = false;
  private readonly emitTags: boolean;

  constructor(opts: OTelSinkOptions = {}) {
    this.emitTags = opts.tags ?? true;
    // NOTE: no meter acquisition here — see `ensureCounters`.
  }

  /**
   * Acquire the counters **lazily, per write, until a real provider answers**.
   *
   * The JS metrics API has no proxy provider (unlike traces, and unlike Python where both proxy):
   * `metrics.getMeterProvider()` returns a `NoopMeterProvider` until the app calls
   * `setGlobalMeterProvider`, and a counter obtained from it stays a `NoopCounterMetric` **forever**.
   * Acquiring in the constructor therefore made `new OTelSink()` a permanent, silent no-op whenever it
   * ran before the app's `NodeSDK.start()` — an undocumented ordering trap (measured: 0 datapoints,
   * ever). Acquiring here and caching only once a non-noop meter answers makes attach order
   * irrelevant, which is also what lets the spend tap be wired automatically.
   */
  private ensureCounters(): boolean {
    if (this.bound) return true;
    if (this.absent) return false;
    try {
      const req = createRequire(import.meta.url);
      const otel = req('@opentelemetry/api');
      const meter = otel.metrics.getMeter('cendor.tokenguard');
      const tokens = meter.createCounter('gen_ai.client.token.usage');
      this.tokensCounter = tokens;
      this.costCounter = meter.createCounter('gen_ai.client.cost.usd');
      this.reasoningCounter = meter.createCounter('gen_ai.client.reasoning.token.usage');
      // Cache only a real instrument; while it is a no-op, re-check on the next write (cheap: the
      // require is module-cached and getMeter/createCounter on a noop provider allocate nothing).
      this.bound = !isNoop(otel.metrics.getMeterProvider()) && !isNoop(tokens);
      return true;
    } catch {
      this.absent = true; // OpenTelemetry not installed — stay in no-op mode, byte-identical
      return false;
    }
  }

  write(entry: SpendEntry): void {
    if (!this.ensureCounters()) return; // OTel not installed — silently skip
    if (
      this.tokensCounter === null ||
      this.costCounter === null ||
      this.reasoningCounter === null
    ) {
      return;
    }
    const attrs: Record<string, unknown> = { model: entry.model ?? '' };
    if (this.emitTags) {
      // Attribution dimensions: flatten low-cardinality tag values so spend is sliceable by
      // feature/tenant in the backend. Non-primitive values are stringified.
      for (const [key, value] of Object.entries(entry.tags ?? {})) {
        attrs[key] =
          typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string'
            ? value
            : String(value);
      }
    }
    // reasoning is a subset of output — reported as its own counter, not added into the total.
    this.tokensCounter.add(Number(entry.input_tokens) + Number(entry.output_tokens), attrs);
    this.reasoningCounter.add(Number(entry.reasoning_tokens ?? 0), attrs);
    this.costCounter.add(Number(entry.usd), attrs);
  }
}
