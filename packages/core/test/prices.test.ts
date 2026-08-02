import { beforeEach, describe, expect, it } from 'vitest';
import { Dec } from '../src/decimal.js';
import { MissingRateError, UnknownModelError, prices } from '../src/index.js';
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
  /** `prices/1`, changed 2026-08-02: an absent rate is UNKNOWN, never zero. */
  missingOutputRate: { model: string; raises: boolean };
  /** ...but a zero a USER registered is a person stating a fact, and stays honoured. */
  registeredZeroIsHonoured: { model: string; amount: string };
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

  it('an absent output rate throws in BOTH languages (vector, not opinion)', () => {
    // The Python reference recorded `raises: true` for this exact shape. Pinning the BEHAVIOUR the
    // same way the costs are pinned is what stops one port pricing an unpriceable row at $0.00.
    expect(fx.missingOutputRate.raises).toBe(true);
    prices.register(fx.missingOutputRate.model, { input: '0.000005' });
    expect(() => prices.estimate(fx.missingOutputRate.model, 1000, { outputTokens: 500 })).toThrow(
      MissingRateError,
    );
  });

  it('a zero a USER registered is honoured, in both languages', () => {
    prices.register(fx.registeredZeroIsHonoured.model, { input: 0, output: 0 });
    const got = prices.estimate(fx.registeredZeroIsHonoured.model, 1000, { outputTokens: 500 });
    expect(got.amount.equals(new Dec(fx.registeredZeroIsHonoured.amount))).toBe(true);
  });

  it('a zero INPUT rate is not in the snapshot at all, but a zero OUTPUT rate is', () => {
    // The generated snapshot drops any model whose input rate would be 0 — `estimate()` would
    // otherwise report $0.00 as a FACT and a USD `budget(...)` cap would silently never bind on it.
    // `llama3` (0/0 in the old hand-fed table) is gone; embeddings, which genuinely have a zero
    // output rate, are not.
    expect(prices.models()).not.toContain('llama3');
    expect(() => prices.estimate('llama3', 1000)).toThrow(UnknownModelError);
    expect(
      prices
        .estimate('text-embedding-3-small', 1000, { outputTokens: 1000 })
        .amount.equals(new Dec('0.00002')),
    ).toBe(true);
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
      prices
        .estimate('gpt-5.1-2025-11-13', 1000, { outputTokens: 500 })
        .amount.equals(gpt51.amount),
    ).toBe(true);
    // Normalization never invents a price: decorated unknowns still throw.
    expect(() => prices.estimate('us.anthropic.claude-nonexistent-v1:0', 100)).toThrow(
      UnknownModelError,
    );
  });

  it('sources() lists the built-in live adapters', () => {
    expect(prices.sources()).toEqual([
      'aws',
      'azure',
      'litellm',
      'modelsdev',
      'openrouter',
      'vercel',
    ]);
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

describe('register() survives refresh; embedding rows priced (0.6.0)', () => {
  beforeEach(() => prices._reset());

  it('re-applies registrations after a successful refresh()', async () => {
    prices.register('my-fine-tune', { input: '0.000001', output: '0' });
    const payload = JSON.stringify({
      _updated: '2099-02-02',
      models: { 'gpt-4o': { input: 0.002, output: 0 } },
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(payload)) as typeof fetch;
    try {
      expect(await prices.refresh()).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
    // The refreshed table swapped in — but the registration is re-applied, not dropped.
    expect(prices.estimate('my-fine-tune', 1000).amount.equals(new Dec('0.001'))).toBe(true);
    expect(prices.estimate('gpt-4o', 1000).amount.equals(new Dec('2'))).toBe(true);
    prices._reset();
  });

  it('prices the bundled embedding rows (backs instrument() embeddings capture)', () => {
    // text-embedding-3-small: $0.02/1M -> 0.00000002/token; 1000 tokens = 0.00002.
    expect(prices.estimate('text-embedding-3-small', 1000).amount.equals(new Dec('0.00002'))).toBe(
      true,
    );
    expect(prices.estimate('text-embedding-3-large', 1000).amount.equals(new Dec('0.00013'))).toBe(
      true,
    );
    expect(prices.estimate('text-embedding-ada-002', 1000).amount.equals(new Dec('0.0001'))).toBe(
      true,
    );
  });
});

// ------------------------------------------------ unknown is not zero (prices/1, 2026-08-02)
//
// `prices/1` used to read an absent `output` as 0. Right for an embedding, wrong for a chat model
// whose rate never parsed — and the two are indistinguishable downstream, so `estimate()` reported a
// fabricated $0.00 as a FACT and a USD cap under-counted by the whole output side. Measured on the
// shipped 3.6.2: after `refresh({source:'litellm'})`, `estimate('gpt-image-1', 1e6, {outputTokens:
// 1e6})` returned $5.00 where OpenAI's own rates make it $45.00. Twin of cendor-libs' test_prices.py.
describe('prices — unknown is not zero', () => {
  const realFetch = globalThis.fetch;
  /** Install a table exactly as a pass-through `refresh(url)` would. */
  const table = async (models: string) => {
    globalThis.fetch = (async () =>
      new Response(`{"_updated": "2026-08-02", "models": ${models}}`)) as typeof fetch;
    try {
      expect(await prices.refresh('https://example.test/p.json')).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  beforeEach(() => prices._reset());

  it('a missing output rate is unknown, not free — and the error names the fix', async () => {
    await table('{"chatty": {"input": 0.000005}}');
    let err: unknown;
    try {
      prices.estimate('chatty', 1_000_000, { outputTokens: 1_000_000 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MissingRateError);
    const msg = (err as Error).message;
    expect(msg).toContain('no OUTPUT rate');
    expect(msg).toContain('registerModelPrice');
    expect(msg).toContain('output: 0 is honoured');
  });

  it('the refusal does not wait for an output-bearing call', async () => {
    // D2: refuse whenever the model is priced. A table that cannot price this model cannot price it.
    await table('{"chatty": {"input": 0.000005}}');
    expect(() => prices.estimate('chatty', 1_000_000)).toThrow(MissingRateError);
  });

  it('MissingRateError is catchable as UnknownModelError', async () => {
    // Every existing handler keeps working: instrument/otel/langchain/tokenguard catch and fall back.
    await table('{"chatty": {"input": 0.000005}}');
    expect(() => prices.estimate('chatty', 10)).toThrow(UnknownModelError);
    expect(new MissingRateError('m', 'output', 'x')).toBeInstanceOf(UnknownModelError);
  });

  it('an explicit zero output rate is honoured forever', async () => {
    // NEGATIVE CONTROL for the rule above: a STATED zero is a real embedding price, not a gap.
    await table('{"embedder": {"input": 0.00000002, "output": 0}}');
    expect(
      prices.estimate('embedder', 1000, { outputTokens: 1000 }).amount.equals(new Dec('0.00002')),
    ).toBe(true);
    prices._reset();
    expect(prices.estimate('text-embedding-3-small', 1000).amount.equals(new Dec('0.00002'))).toBe(
      true,
    );
  });

  it('a table zero input rate is refused, a registered one is honoured', async () => {
    // D5. A zero in a TABLE is a parser having lost a rate; a zero YOU registered is a person
    // stating a fact — and `register('llama3', {input: 0, output: 0})` is the documented way to
    // price a local model free.
    await table('{"llama3": {"input": 0, "output": 0}}');
    expect(() => prices.estimate('llama3', 1000, { outputTokens: 500 })).toThrow(/zero INPUT rate/);
    prices.register('llama3', { input: 0, output: 0 });
    expect(prices.estimate('llama3', 1000, { outputTokens: 500 }).amount.equals(new Dec(0))).toBe(
      true,
    );
  });

  it('a missing input key raises the typed error', async () => {
    await table('{"headless": {"output": 0.00001}}');
    expect(() => prices.estimate('headless', 1000)).toThrow(/no INPUT rate/);
  });

  it('registerModelPrice is the documented escape and it works', async () => {
    await table('{"gpt-image-1": {"input": 0.000005}}');
    expect(() => prices.estimate('gpt-image-1', 1_000_000)).toThrow(MissingRateError);
    // OpenAI's published rates: $5/1M text in, $40/1M image out.
    prices.registerModelPrice('gpt-image-1', { input: 5, output: 40, per: '1M' });
    expect(
      prices
        .estimate('gpt-image-1', 1_000_000, { outputTokens: 1_000_000 })
        .amount.equals(new Dec(45)),
    ).toBe(true);
  });

  it('registerDeployment refuses an unpriceable base', async () => {
    await table('{"half-priced": {"input": 0.000005}}');
    expect(() => prices.registerDeployment('prod-eastus', { like: 'half-priced' })).toThrow(
      MissingRateError,
    );
    expect(prices.models()).not.toContain('prod-eastus');
  });

  it('a pass-through table keeps every row and estimate refuses by name', async () => {
    // The other half of D4: a `refresh(url)` is a TABLE, not a mapper. We do not quietly discard
    // rows from a table the user chose.
    await table('{"chatty": {"input": 0.000005}}');
    expect(prices.models()).toContain('chatty');
    expect(() => prices.estimate('chatty', 1000, { outputTokens: 500 })).toThrow(MissingRateError);
  });

  it('every model the bundled snapshot lists can actually be priced', () => {
    // The invariant the whole rule exists to protect. If this fails, the generated snapshot
    // published a row no caller can use — which is what shipped in <= 3.6.1.
    const unpriceable: string[] = [];
    for (const mid of prices.models()) {
      try {
        prices.estimate(mid, 1000, { outputTokens: 1000 });
      } catch {
        unpriceable.push(mid);
      }
    }
    expect(unpriceable).toEqual([]);
  });
});
