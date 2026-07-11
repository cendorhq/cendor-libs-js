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

  it('lookup normalizes wire-level ids (Bedrock prefixes, -vN:0, date suffixes)', () => {
    const base = prices.estimate('claude-sonnet-4-6', 1000, { outputTokens: 500 });
    for (const wire of [
      'anthropic.claude-sonnet-4-6-v1:0',
      'us.anthropic.claude-sonnet-4-6-20260115-v1:0',
      'claude-sonnet-4-6-20260115',
    ]) {
      expect(prices.estimate(wire, 1000, { outputTokens: 500 }).amount.equals(base.amount)).toBe(
        true,
      );
    }
    const gpt51 = prices.estimate('gpt-5.1', 1000, { outputTokens: 500 });
    expect(
      prices.estimate('gpt-5.1-2025-11-13', 1000, { outputTokens: 500 }).amount.equals(
        gpt51.amount,
      ),
    ).toBe(true);
    // Normalization never invents a price: decorated unknowns still throw.
    expect(() => prices.estimate('us.anthropic.claude-nonexistent-v1:0', 100)).toThrow(
      UnknownModelError,
    );
  });

  it('sources() lists the built-in live adapters', () => {
    expect(prices.sources()).toEqual(['azure', 'litellm', 'openrouter']);
  });

  it('register() adds a model so estimate() and models() see it', () => {
    expect(() => prices.estimate('my-deploy', 1000)).toThrow(UnknownModelError);
    prices.register('my-deploy', { input: '0.0000025', output: '0.00001' });
    expect(prices.models()).toContain('my-deploy');
    const c = prices.estimate('my-deploy', 1000, { outputTokens: 500 });
    expect(c.amount.equals(new Dec('0.0075'))).toBe(true);
    prices._reset();
    expect(() => prices.estimate('my-deploy', 1000)).toThrow(UnknownModelError); // dropped on reset
  });

  it('cache_write defaults to 1.25x input when unpriced', () => {
    // gpt-4o has no cache_write rate: input 0.0000025 -> write 0.000003125.
    const c = prices.estimate('gpt-4o', 0, { cacheWriteTokens: 1_000_000 });
    expect(c.amount.equals(new Dec('3.125'))).toBe(true);
  });
});
