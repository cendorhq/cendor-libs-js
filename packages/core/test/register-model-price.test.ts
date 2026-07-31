/**
 * `prices.registerModelPrice(model, { input, output })` — the per-1M convenience, on the LIBRARIES
 * door.
 *
 * THE GAP this closes: the helper existed only in `@cendor/sdk`, while Python has had
 * `prices.register_model_price` in `cendor-core` since 1.15.0. So a TypeScript app following the
 * libraries-door docs imported it from `@cendor/core` and got nothing — the one asymmetry left after
 * `registerDeployment` landed on both cores. `@cendor/sdk`'s export stays; this is the same helper in
 * the place a libs-only app can reach.
 *
 * The units are the whole point: published rate cards quote **USD per 1M tokens**, `register()` stores
 * **per-token**, and getting that wrong is a 1,000,000× cost error that no test would otherwise catch.
 */
import { describe, expect, it } from 'vitest';
import {
  UnknownModelError,
  _reset,
  estimate,
  models,
  registerDeployment,
  registerModelPrice,
} from '../src/prices.js';

function fresh(): void {
  _reset();
}

describe('@cendor/core — prices.registerModelPrice', () => {
  it('NEGATIVE CONTROL: the id is unpriced before registration', () => {
    fresh();
    expect(() => estimate('rate-card-model', 1000, { outputTokens: 500 })).toThrow(
      UnknownModelError,
    );
  });

  it('treats rates as USD per 1M tokens by default', () => {
    fresh();
    registerModelPrice('rate-card-model', { input: 2.5, output: 10.0 });
    // 1000 in @ $2.50/1M = $0.0025; 500 out @ $10.00/1M = $0.005. Exact, not float-ish.
    expect(estimate('rate-card-model', 1000, { outputTokens: 500 }).amount.toString()).toBe(
      '0.0075',
    );
    expect(models()).toContain('rate-card-model');
  });

  it('agrees with Python to the digit on the same rate card', () => {
    // The number cendor-core's `register_model_price("m", input=2.50, output=10.00)` produces for
    // 1200 in / 400 out. A cross-language drift here is a real defect, not a rounding taste.
    fresh();
    registerModelPrice('m', { input: 2.5, output: 10.0 });
    expect(estimate('m', 1200, { outputTokens: 400 }).amount.toString()).toBe('0.007');
  });

  it('converts 1K and token units', () => {
    fresh();
    registerModelPrice('per-1k', { input: 2.5, output: 10.0, per: '1K' });
    registerModelPrice('per-token', { input: '0.0000025', output: '0.00001', per: 'token' });
    const oneK = estimate('per-1k', 1000, { outputTokens: 500 }).amount;
    const perToken = estimate('per-token', 1000, { outputTokens: 500 }).amount;
    // per-1K is 1000× the per-1M rate; per-token here is the same rate as the 1M default.
    expect(oneK.toString()).toBe('7.5');
    expect(perToken.toString()).toBe('0.0075');
  });

  it('rejects an unknown unit rather than guessing one', () => {
    fresh();
    expect(() =>
      // @ts-expect-error — `per` is narrowed to '1M' | '1K' | 'token'; the runtime check covers
      // untyped JS callers, and this asserts the type still refuses the wrong string.
      registerModelPrice('bad-unit', { input: 1, per: '1B' }),
    ).toThrow(/per must be one of/);
    expect(models()).not.toContain('bad-unit');
  });

  it('carries cached and cache-write rates when given, and omits them when not', () => {
    fresh();
    const withCache = registerModelPrice('cached-model', {
      input: 2.5,
      output: 10.0,
      cached: 1.25,
      cacheWrite: 3.125,
    });
    expect(withCache.cached?.toString()).toBe('0.00000125');
    expect(withCache.cache_write?.toString()).toBe('0.000003125');
    const bare = registerModelPrice('bare-model', { input: 2.5, output: 10.0 });
    expect(bare.cached).toBeUndefined();
    expect(bare.cache_write).toBeUndefined();
  });

  it('defaults output to zero — a free-output model is priced, not unpriced', () => {
    fresh();
    const rates = registerModelPrice('input-only', { input: 2.5 });
    expect(rates.output.toString()).toBe('0');
    expect(estimate('input-only', 1000, { outputTokens: 500 }).amount.toString()).toBe('0.0025');
  });

  it('returns a copy — mutating it does not change the table', () => {
    fresh();
    const rates = registerModelPrice('copy-me', { input: 2.5, output: 10.0 });
    rates.input = rates.input.times(1000);
    expect(estimate('copy-me', 1000, { outputTokens: 500 }).amount.toString()).toBe('0.0075');
  });

  it('is the rate-card twin of registerDeployment, and both land in one table', () => {
    // The two ways to price a Foundry deployment name: copy a known model's rates, or type the card.
    fresh();
    registerDeployment('dep-like-gpt4o', { like: 'gpt-4o' });
    registerModelPrice('dep-by-hand', { input: 2.5, output: 10.0 });
    expect(models()).toContain('dep-like-gpt4o');
    expect(models()).toContain('dep-by-hand');
    expect(estimate('dep-by-hand', 1000, { outputTokens: 500 }).amount.greaterThan(0)).toBe(true);
  });
});
