/**
 * tokenguard: the warn-once stale-price-table signal (live-pricing wave, D6). The twin of
 * `cendor-libs`' `packages/cendor-tokenguard/tests/test_stale_prices.py`.
 *
 * A USD cap enforced against stale rates is quietly wrong, and the direction depends on which way
 * prices moved: after a price CUT the estimate is high and the cap binds early (conservative);
 * after a price RISE it is low and the cap binds LATE — you overspend. That second case is why this
 * warning exists.
 */
import { Dec, prices } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as tokenguard from '../src/index.js';
import {
  type StalePriceTableWarning,
  configure,
  onStalePricesWarning,
  onUnpricedWarning,
  withBudget,
} from '../src/index.js';
import { callN, makeClient } from './_helpers.js';

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

/** Install a price table with a chosen `_updated`, exactly as a refresh() would. */
async function table(updated: string | null): Promise<void> {
  const payload: Record<string, unknown> = {
    models: { 'gpt-4o': { input: 0.0000025, output: 0.00001 } },
  };
  if (updated !== null) payload._updated = updated;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(payload))) as typeof fetch;
  try {
    const ok = await prices.refresh();
    if (!ok) throw new Error('fixture table did not install');
  } finally {
    globalThis.fetch = realFetch;
  }
}

function capture(): { warnings: StalePriceTableWarning[]; stop: () => void } {
  const warnings: StalePriceTableWarning[] = [];
  const stop = onStalePricesWarning((w) => warnings.push(w));
  return { warnings, stop };
}

describe('stale price table', () => {
  beforeEach(() => {
    tokenguard.reset();
    prices._reset();
  });
  afterEach(() => {
    tokenguard.reset();
    prices._reset();
  });

  it('warns ONCE per process, not per call', async () => {
    await table(daysAgo(400));
    const { warnings, stop } = capture();
    try {
      await withBudget({ usd: 100 }, async () => {
        await callN(makeClient(), { n: 5 });
      });
    } finally {
      stop();
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain(daysAgo(400));
    expect(warnings[0]?.message).toContain('binds LATE'); // names the failure, not just the age
    expect(warnings[0]?.message).toContain('prices.refresh()'); // and how to fix it
  });

  it('says nothing about a fresh table', async () => {
    await table(daysAgo(2));
    const { warnings, stop } = capture();
    try {
      await withBudget({ usd: 100 }, async () => {
        await callN(makeClient(), { n: 1 });
      });
    } finally {
      stop();
    }
    expect(warnings).toHaveLength(0);
  });

  it('never calls an UNDATABLE table stale', async () => {
    // litellm / openrouter / vercel publish no as-of date. Unmeasurable is not stale — inventing an
    // age would be exactly the dishonesty this wave removes. They surface through sourceName().
    await table(null);
    expect(prices.ageDays()).toBeNull();
    const { warnings, stop } = capture();
    try {
      await withBudget({ usd: 100 }, async () => {
        await callN(makeClient(), { n: 1 });
      });
    } finally {
      stop();
    }
    expect(warnings).toHaveLength(0);
  });

  it('says nothing for a tokens-only budget (it does not depend on a price)', async () => {
    await table(daysAgo(400));
    const { warnings, stop } = capture();
    try {
      await withBudget({ tokens: 1_000_000 }, async () => {
        await callN(makeClient(), { n: 1 });
      });
    } finally {
      stop();
    }
    expect(warnings).toHaveLength(0);
  });

  it('says nothing with no budget at all', async () => {
    await table(daysAgo(400));
    const { warnings, stop } = capture();
    try {
      await callN(makeClient(), { n: 1 });
    } finally {
      stop();
    }
    expect(warnings).toHaveLength(0);
  });

  it("onStalePrices: 'ignore' silences it", async () => {
    await table(daysAgo(400));
    configure({ onStalePrices: 'ignore' });
    const { warnings, stop } = capture();
    try {
      await withBudget({ usd: 100 }, async () => {
        await callN(makeClient(), { n: 1 });
      });
    } finally {
      stop();
    }
    expect(warnings).toHaveLength(0);
  });

  it('the threshold moves', async () => {
    await table(daysAgo(10));
    const { warnings, stop } = capture();
    try {
      await withBudget({ usd: 100 }, async () => {
        await callN(makeClient(), { n: 1 });
      });
      expect(warnings).toHaveLength(0);
      configure({ stalePricesAfterDays: 5 });
      await withBudget({ usd: 100 }, async () => {
        await callN(makeClient(), { n: 1 });
      });
      expect(warnings).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it('configure rejects a bad value', () => {
    expect(() => configure({ onStalePrices: 'raise' })).toThrow(/onStalePrices/);
    expect(() => configure({ stalePricesAfterDays: -1 })).toThrow(/stalePricesAfterDays/);
  });

  it('an unpriced call warns about the PRICE, not the age', async () => {
    // The two signals name different failures and must not double-fire on one call.
    await table(daysAgo(400));
    const stale = capture();
    const unpriced: string[] = [];
    const stopUnpriced = onUnpricedWarning((w) => unpriced.push(w.message));
    try {
      await withBudget({ usd: 100 }, async () => {
        await callN(makeClient(), { n: 1, model: 'mystery-model-2099' });
      });
    } finally {
      stale.stop();
      stopUnpriced();
    }
    expect(unpriced).toHaveLength(1);
    expect(stale.warnings).toHaveLength(0);
  });

  it('reset() re-arms the once-per-process latch', async () => {
    await table(daysAgo(400));
    const first = capture();
    try {
      await withBudget({ usd: 100 }, async () => {
        await callN(makeClient(), { n: 1 });
      });
      expect(first.warnings).toHaveLength(1);
    } finally {
      first.stop();
    }
    tokenguard.reset();
    await table(daysAgo(400));
    const second = capture();
    try {
      await withBudget({ usd: 100 }, async () => {
        await callN(makeClient(), { n: 1 });
      });
      expect(second.warnings).toHaveLength(1);
    } finally {
      second.stop();
    }
  });

  it('a listener may re-throw to escalate it to an error', async () => {
    await table(daysAgo(400));
    const stop = onStalePricesWarning((w) => {
      throw w;
    });
    try {
      await expect(
        withBudget({ usd: 100 }, async () => {
          await callN(makeClient(), { n: 1 });
        }),
      ).rejects.toThrow(/binds LATE/);
    } finally {
      stop();
    }
  });

  it('the estimate itself is unaffected — this is a signal, not a behaviour change', async () => {
    await table(daysAgo(400));
    const stop = onStalePricesWarning(() => {});
    try {
      await withBudget({ usd: 100 }, async () => {
        await callN(makeClient(), { n: 1 });
      });
    } finally {
      stop();
    }
    // 1000 in @ 2.5e-6 + 500 out @ 1e-5 = 0.0075
    expect(tokenguard.report().total().amount.equals(new Dec('0.0075'))).toBe(true);
  });
});
