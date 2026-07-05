import { beforeEach, describe, expect, it } from 'vitest';
import { Dec } from '../src/decimal.js';
import { UnknownModelError, prices } from '../src/index.js';
import { loadFixture } from './_fixtures.js';

interface PriceCase {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  cost: { amount: string; currency: string };
  costStr: string;
}
interface PriceFixture {
  snapshotDate: string;
  models: string[];
  cases: PriceCase[];
  unknownModel: { model: string; raises: boolean };
}

const fx = loadFixture<PriceFixture>('prices.json');

describe('prices — cross-language conformance (prices/1)', () => {
  beforeEach(() => prices._reset());

  it('bundled snapshot date matches Python', () => {
    expect(prices.snapshotDate()).toBe(fx.snapshotDate);
  });

  it('model list matches Python exactly', () => {
    expect(prices.models()).toEqual(fx.models);
  });

  it.each(fx.cases)(
    'estimate($model, $inputTokens/$outputTokens, cached=$cachedTokens, write=$cacheWriteTokens) == $costStr',
    (c) => {
      const cost = prices.estimate(c.model, c.inputTokens, {
        outputTokens: c.outputTokens,
        cachedTokens: c.cachedTokens,
        cacheWriteTokens: c.cacheWriteTokens,
      });
      expect(cost.currency).toBe(c.cost.currency);
      // Value equality (not byte-identical trailing zeros — see fixtures/README.md).
      expect(cost.amount.equals(new Dec(c.cost.amount))).toBe(true);
    },
  );

  it('unknown model throws UnknownModelError', () => {
    expect(() => prices.estimate(fx.unknownModel.model, 100, { outputTokens: 100 })).toThrow(
      UnknownModelError,
    );
  });

  it('llama3 zero rates cost nothing', () => {
    expect(prices.estimate('llama3', 1000, { outputTokens: 1000 }).amount.isZero()).toBe(true);
  });

  it('sources() lists the built-in live adapters', () => {
    expect(prices.sources()).toEqual(['azure', 'litellm', 'openrouter']);
  });

  it('cache_write defaults to 1.25x input when unpriced', () => {
    // gpt-4o has no cache_write rate: input 0.0000025 -> write 0.000003125.
    const c = prices.estimate('gpt-4o', 0, { cacheWriteTokens: 1_000_000 });
    expect(c.amount.equals(new Dec('3.125'))).toBe(true);
  });
});
