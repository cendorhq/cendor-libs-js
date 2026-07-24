/**
 * `evict: 'compress'` with `@cendor/squeeze` UNAVAILABLE must degrade to truncation, not throw.
 *
 * `@cendor/squeeze` is a devDependency here, so the auto-discover import at `index.ts` normally
 * succeeds and the fallback branch is never exercised by the rest of the suite. We mock the module
 * to fail on import (the "not installed at the consumer" case) and assert the block is truncated with
 * the honest note instead of crashing assembly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Make the runtime `import('@cendor/squeeze')` inside getCompressor() reject.
vi.mock('@cendor/squeeze', () => {
  throw new Error('Cannot find module @cendor/squeeze (simulated: not installed)');
});

import { bus } from '@cendor/core';
import { Block, Context, useCompressor } from '../src/index.js';

beforeEach(() => {
  useCompressor(null); // no override / process default → force runtime auto-discovery (which we mock)
});
afterEach(() => {
  bus._reset();
  useCompressor(null);
});

describe('evict: compress falls back to truncate when squeeze is absent', () => {
  it('truncates instead of throwing, with an honest note', async () => {
    const ctx = new Context({ budgetTokens: 40, model: 'gpt-4o' });
    ctx.add(new Block('s', { priority: 10, role: 'system' }));
    ctx.add(new Block('z'.repeat(400), { priority: 1, role: 'user', evict: 'compress' }));

    await expect(ctx.assemble()).resolves.toBeDefined(); // does NOT reject

    const decision = ctx.report().decisions.find((d) => d.role === 'user')!;
    expect(decision.action).toBe('truncated');
    expect(decision.note).toContain('squeeze not installed');
    expect(decision.tokensAfter).toBeLessThan(decision.tokensBefore);
    expect(ctx.report().used).toBeLessThanOrEqual(
      ctx.report().budget - ctx.report().reservedOutput,
    );
  });
});
