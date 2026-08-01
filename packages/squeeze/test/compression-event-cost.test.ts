// The CompressionEvent is computed ONLY when the bus has a subscriber. Filling it means token-
// counting the original AND the compressed text — measured at ~93% of a large compress() — so with
// nothing attached the counting must not run at all, and with one subscriber the event must still
// carry correct counts (exactly two tokens.count calls: original + compressed).
// Mirror of tests/test_compression_event.py::test_no_subscribers_means_no_token_counting / _correct_counts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const countSpy = vi.hoisted(() => ({ current: null as ReturnType<typeof vi.fn> | null }));

vi.mock('@cendor/core', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@cendor/core')>();
  const count = vi.fn(orig.tokens.count);
  countSpy.current = count;
  return { ...orig, tokens: { ...orig.tokens, count } };
});

import { bus, tokens } from '@cendor/core';
import { CompressionEvent, compress } from '../src/index.js';

beforeEach(() => {
  bus._reset();
  countSpy.current?.mockClear();
});
afterEach(() => bus._reset());

describe('CompressionEvent cost gate', () => {
  it('runs zero token counts when nothing is subscribed', () => {
    const data = { user: { id: 42, name: 'Ada' }, scores: [...Array(50).keys()] };
    const [small, handle] = compress(data, { kind: 'json' });
    expect(small.length).toBeGreaterThan(0);
    expect(handle.expand()).toBeTruthy(); // compression itself is unaffected
    expect(countSpy.current).not.toHaveBeenCalled();
  });

  it('still carries correct counts with one subscriber — exactly two count calls', () => {
    const seen: unknown[] = [];
    bus.subscribe((e) => seen.push(e));
    const data = { user: { id: 42, name: 'Ada' }, scores: [...Array(50).keys()] };
    const [small] = compress(data, { kind: 'json' });

    const events = seen.filter((e): e is CompressionEvent => e instanceof CompressionEvent);
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(countSpy.current).toHaveBeenCalledTimes(2); // original + compressed, nothing more
    expect(ev.tokens_before).toBe(tokens.count(countSpy.current?.mock.calls[0]?.[0], 'gpt-4o'));
    expect(ev.tokens_after).toBe(tokens.count(small, 'gpt-4o'));
    expect(ev.ratio).toBe(ev.tokens_before ? ev.tokens_after / ev.tokens_before : 1.0);
  });
});
