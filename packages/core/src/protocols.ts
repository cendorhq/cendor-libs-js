/**
 * Structural interfaces shared across the stack — the TS mirror of `cendor.core.protocols`. These
 * are duck-typed shapes: a library satisfies an interface by shape, no imports or base classes.
 */

/** A restore handle for a reversible compression. `expand()` returns the original content. */
export interface Handle {
  expand(): unknown;
}

/** Shrinks content toward a token budget and returns a restorable {@link Handle}. */
export interface Compressor {
  compress(
    content: unknown,
    opts?: { targetTokens?: number | null; model?: string | null; kind?: string },
  ): [string, Handle];
}

/** A pluggable per-block shrink rule. Returns `[newContentOrNull, actionLabel]`. */
export interface EvictionStrategy {
  evict(content: string, remainingTokens: number, model: string): [string | null, string];
}

/**
 * A destination for records/entries (in-memory, JSONL, SQLite, OTel, ...). `write(entry)` is the
 * only required method; a sink **may** additionally implement `flush()` / `close()`, which callers
 * invoke through capability guards, never assumed present.
 */
export interface Sink {
  write(entry: unknown): void;
  flush?(): void | Promise<void>;
  close?(): void | Promise<void>;
}

/** A bus subscriber: a callable that receives normalized events. */
export type Subscriber = (event: unknown) => void;
