// compress() emits a metadata-only CompressionEvent on the bus (G21). Never any text.
// Mirror of tests/test_compression_event.py.
import { bus } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompressionEvent, compress } from '../src/index.js';

beforeEach(() => bus._reset());
afterEach(() => bus._reset());

describe('CompressionEvent (G21)', () => {
  it('is emitted with metadata only — no content', () => {
    const seen: unknown[] = [];
    bus.subscribe((e) => seen.push(e));
    const data = { user: { id: 42, name: 'Ada' }, scores: [1, 2, 3, 4, 5], nulls: null };
    const [, handle] = compress(data, { kind: 'json' });

    const events = seen.filter((e): e is CompressionEvent => e instanceof CompressionEvent);
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.handle_id).toBe(handle.id);
    expect(ev.kind).toBe('json');
    expect(ev.technique.length).toBeGreaterThan(0);
    expect(ev.tokens_before).toBeGreaterThanOrEqual(ev.tokens_after);
    expect(ev.ratio).toBeGreaterThanOrEqual(0);
    expect(ev.ratio).toBeLessThanOrEqual(1);
    expect(ev.store_kind).toBe('MemoryStore');
    // The event carries NO content — the original text never rides it.
    for (const v of Object.values(ev)) {
      if (typeof v === 'string') expect(v).not.toContain('Ada');
    }
  });
});
