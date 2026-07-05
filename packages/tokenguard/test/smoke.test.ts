/** Public API presence + pre-flight estimate (no call, no network). Mirrors test_tokenguard_smoke.py. */
import { Dec, Money, UnknownModelError, tokens } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as tokenguard from '../src/index.js';
import { estimate } from '../src/index.js';

describe('tokenguard smoke', () => {
  beforeEach(() => tokenguard.reset());
  afterEach(() => tokenguard.reset());

  it('exposes the public API surface', () => {
    for (const name of [
      'budget',
      'track',
      'estimate',
      'report',
      'BudgetExceeded',
      'reset',
    ] as const) {
      expect(tokenguard[name]).toBeDefined();
    }
    expect(typeof tokenguard.budget).toBe('function');
    expect(typeof tokenguard.track).toBe('function');
    expect(typeof tokenguard.estimate).toBe('function');
    expect(typeof tokenguard.report).toBe('function');
    expect(typeof tokenguard.reset).toBe('function');
  });

  it('projects cost without calling', () => {
    const msgs = [{ role: 'user', content: 'hello world' }];
    const projected = estimate('gpt-4o', msgs, 100);
    expect(projected).toBeInstanceOf(Money);
    // Recomputed against real js-tiktoken: "hello world" is 9 input tokens for gpt-4o (the Python
    // test forces its ceil(len/4) heuristic → 10 tokens → 0.001025). Real: 9*0.0000025 + 100*0.00001.
    expect(tokens.count(msgs, 'gpt-4o')).toBe(9);
    expect(projected.amount.equals(new Dec('0.0010225'))).toBe(true);
  });

  it('throws for an unknown model (the KeyError-equivalent)', () => {
    expect(() => estimate('nope', [{ role: 'user', content: 'hi' }])).toThrow(UnknownModelError);
  });
});
