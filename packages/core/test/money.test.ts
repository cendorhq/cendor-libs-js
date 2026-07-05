import { describe, expect, it } from 'vitest';
import { Money, Usage } from '../src/index.js';
import { loadFixture } from './_fixtures.js';

interface MoneyFixture {
  money: Record<string, { amount: string; currency: string } | string | boolean>;
  currencyMismatchRaises: boolean;
  usage: { init: Record<string, number>; total: number }[];
}

const fx = loadFixture<MoneyFixture>('money.json');
const m = fx.money;

describe('Money — cross-language conformance (events/1)', () => {
  it('constructs from string, number, int with no float noise', () => {
    expect(new Money('0.0025').toString()).toBe('0.0025 USD');
    expect(new Money(0.1).toString()).toBe('0.1 USD');
    expect(new Money(5).amount.toString()).toBe('5');
  });

  it('arithmetic matches Python (add/sub/mul)', () => {
    const a = new Money('0.0025');
    const b = new Money('0.0010');
    expect(a.add(b).amount.toString()).toBe((m.add as { amount: string }).amount);
    expect(a.sub(b).amount.toString()).toBe((m.sub as { amount: string }).amount);
    expect(a.mul(3).amount.toString()).toBe((m.mul_int as { amount: string }).amount);
    expect(a.mul('2.5').amount.toString()).toBe((m.mul_decimal as { amount: string }).amount);
  });

  it('comparisons match Python', () => {
    const a = new Money('0.0025');
    const b = new Money('0.0010');
    expect(a.lt(b)).toBe(m.lt);
    expect(a.gt(b)).toBe(m.gt);
    expect(new Money('0.5').le(new Money('0.5'))).toBe(m.le_eq);
  });

  it('trailing-zero amounts are value-equal (2.5 == 2.50)', () => {
    expect(new Money('2.5').eq(new Money('2.50'))).toBe(m.eq_trailing_zeros);
  });

  it('zero and currency', () => {
    expect(Money.zero().amount.isZero()).toBe(true);
    expect(Money.zero('EUR').currency).toBe('EUR');
  });

  it('currency mismatch throws', () => {
    const doAdd = () => new Money('1', 'USD').add(new Money('1', 'EUR'));
    if (fx.currencyMismatchRaises) expect(doAdd).toThrow(/currency mismatch/);
  });

  it('str form matches Python', () => {
    expect(new Money('0.0025').toString()).toBe(m.str_form);
  });
});

describe('Usage — subset conventions', () => {
  it.each(fx.usage)('totalTokens for %o', (u) => {
    const usage = new Usage({
      inputTokens: u.init.input_tokens ?? 0,
      outputTokens: u.init.output_tokens ?? 0,
      cachedTokens: u.init.cached_tokens ?? 0,
      reasoningTokens: u.init.reasoning_tokens ?? 0,
      cacheWrite: u.init.cache_write ?? 0,
    });
    expect(usage.totalTokens).toBe(u.total);
  });

  it('cached ⊆ input and reasoning ⊆ output are NOT added into total', () => {
    const usage = new Usage({
      inputTokens: 1000,
      outputTokens: 500,
      cachedTokens: 200,
      reasoningTokens: 100,
      cacheWrite: 50,
    });
    expect(usage.totalTokens).toBe(1500);
  });
});
