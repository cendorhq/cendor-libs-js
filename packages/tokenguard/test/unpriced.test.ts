/**
 * Unpriced/unknown models must not let a USD budget silently no-op. Mirrors test_unpriced.py.
 * Python's `pytest.warns` / `simplefilter("error")` map to the TS warning channel: register a
 * listener via onUnpricedWarning() (deduped once-per-model, cleared by reset()).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as tokenguard from '../src/index.js';
import {
  BudgetExceeded,
  type UnpricedModelWarning,
  configure,
  onUnpricedWarning,
  report,
  unpricedCalls,
  withBudget,
} from '../src/index.js';
import { callN, makeClient } from './_helpers.js';

// A model id NOT in the bundled price table → core leaves cost=null (a USD blind spot).
const UNPRICED = 'mystery-model-2099';

function captureWarnings(): { warnings: UnpricedModelWarning[]; stop: () => void } {
  const warnings: UnpricedModelWarning[] = [];
  const stop = onUnpricedWarning((w) => warnings.push(w));
  return { warnings, stop };
}

describe('unpriced models', () => {
  beforeEach(() => tokenguard.reset());
  afterEach(() => tokenguard.reset());

  it('USD block on an unpriced model warns and proceeds by default', async () => {
    let n = 0;
    const client = makeClient({
      onCreate: () => {
        n += 1;
      },
    });
    const { warnings, stop } = captureWarnings();
    try {
      await withBudget({ usd: 0.01, onExceed: 'block' }, async () => {
        await callN(client, { n: 2, model: UNPRICED });
      });
    } finally {
      stop();
    }
    expect(warnings.some((w) => w.message.includes('mystery-model-2099'))).toBe(true);
    expect(n).toBe(2); // default on_unpriced="warn": calls proceed, cap can't bite
  });

  it('USD block on an unpriced model raises in strict mode', async () => {
    let n = 0;
    const client = makeClient({
      onCreate: () => {
        n += 1;
      },
    });
    configure({ onUnpriced: 'raise' });
    await expect(
      withBudget({ usd: 0.01, onExceed: 'block' }, async () => {
        await callN(client, { n: 1, model: UNPRICED });
      }),
    ).rejects.toThrow(/no price/);
    expect(n).toBe(0); // strict mode rejects the unpriced call pre-flight
  });

  it('USD raise on an unpriced model warns post-flight', async () => {
    const client = makeClient();
    const { warnings, stop } = captureWarnings();
    try {
      await withBudget({ usd: 0.01, onExceed: 'raise' }, async () => {
        await callN(client, { n: 1, model: UNPRICED });
      });
    } finally {
      stop();
    }
    expect(warnings.some((w) => w.message.includes("on_exceed='raise'"))).toBe(true);
  });

  it('report surfaces unpriced calls', async () => {
    const client = makeClient();
    const { warnings, stop } = captureWarnings();
    try {
      await withBudget({ usd: 100.0 }, async () => {
        await callN(client, { n: 3, model: UNPRICED });
      });
    } finally {
      stop();
    }
    expect(warnings.length).toBeGreaterThan(0);
    expect(unpricedCalls()).toBe(3);
    const row = report([]).rows[0]!;
    expect(row.calls).toBe(3);
    expect(row.unpriced_calls).toBe(3);
    expect(row.usd.amount.isZero()).toBe(true);
  });

  it('a priced model neither warns nor counts as unpriced', async () => {
    const client = makeClient();
    const { warnings, stop } = captureWarnings();
    try {
      await withBudget({ usd: 100.0, onExceed: 'block' }, async () => {
        await callN(client, { n: 2, model: 'gpt-4o' });
      });
    } finally {
      stop();
    }
    expect(warnings.length).toBe(0);
    expect(unpricedCalls()).toBe(0);
    expect(report([]).rows[0]!.unpriced_calls).toBe(0);
  });

  it('a token cap is still enforced for an unpriced model', async () => {
    const client = makeClient(); // 1500 tokens/call
    await expect(
      withBudget({ tokens: 2000, onExceed: 'raise' }, async () => {
        await callN(client, { n: 10, model: UNPRICED });
      }),
    ).rejects.toThrow(BudgetExceeded);
  });

  it('warns once per model, not once per call', async () => {
    const client = makeClient();
    const { warnings, stop } = captureWarnings();
    try {
      await withBudget({ usd: 100.0 }, async () => {
        await callN(client, { n: 5, model: UNPRICED });
      });
    } finally {
      stop();
    }
    expect(warnings.length).toBe(1);
  });

  it('configure rejects a bad on_unpriced', () => {
    expect(() => configure({ onUnpriced: 'explode' })).toThrow(/on_unpriced/);
  });
});
