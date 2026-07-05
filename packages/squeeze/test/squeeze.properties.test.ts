/**
 * Property tests — the TS mirror of `tests/test_squeeze_properties.py`. Compression is always exactly
 * reversible, for any input, and a `targetTokens` budget is never exceeded. No network.
 *
 * These run on the REAL js-tiktoken counter (no heuristic forcing), matching the Python property
 * suite: both invariants hold under any monotone counter, and the port's `compress`/truncate use the
 * same counter these assertions do.
 */
import { tokens } from '@cendor/core';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore, compress, useStore } from '../src/index.js';

const KINDS = ['json', 'logs', 'code', 'prose'] as const;

let previous: ReturnType<typeof useStore>;
beforeEach(() => {
  previous = useStore(new MemoryStore()); // fresh CCR per property so runs stay isolated
});
afterEach(() => {
  useStore(previous);
  tokens._reset();
});

describe('reversibility + budget properties', () => {
  it('compress(kind=auto) then expand round-trips for arbitrary text', () => {
    fc.assert(
      fc.property(fc.fullUnicodeString({ maxLength: 2000 }), (s) => {
        const [, handle] = compress(s, { kind: 'auto' });
        expect(handle.expand()).toBe(s);
      }),
    );
  });

  it('targetTokens is never exceeded for every kind', () => {
    fc.assert(
      fc.property(
        fc.fullUnicodeString({ minLength: 1, maxLength: 2000 }),
        fc.constantFrom(...KINDS),
        fc.integer({ min: 1, max: 200 }),
        (s, kind, target) => {
          const [small] = compress(s, { kind, targetTokens: target });
          expect(tokens.count(small, 'gpt-4o')).toBeLessThanOrEqual(target);
        },
      ),
    );
  });

  it('is reversible for every kind', () => {
    fc.assert(
      fc.property(
        fc.fullUnicodeString({ minLength: 1, maxLength: 2000 }),
        fc.constantFrom(...KINDS),
        (s, kind) => {
          const [, handle] = compress(s, { kind });
          expect(handle.expand()).toBe(s);
        },
      ),
    );
  });
});
