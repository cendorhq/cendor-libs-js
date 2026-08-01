/**
 * The live-pricing wave (W2) — the TypeScript twin of `cendor-libs`'
 * `packages/cendor-core/tests/test_prices.py` W2 block. Every case is anchored to something
 * MEASURED on 2026-08-01 against the real endpoints; the comments name the measurement so a future
 * edit knows what it would be undoing. Raw traces: cendorhq
 * `plan/evidence-live-pricing-2026-08-01/`.
 *
 * Offline: every fetch is stubbed. Nothing here touches the network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Dec } from '../src/decimal.js';
import { PriceRefreshError, UnknownModelError, prices } from '../src/index.js';

const realFetch = globalThis.fetch;

/** Serve a body per URL substring, recording every URL fetched in order. */
function stub(bodies: Record<string, string>): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    for (const [needle, body] of Object.entries(bodies)) {
      if (url.includes(needle)) return new Response(body);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return seen;
}

beforeEach(() => prices._reset());
afterEach(() => {
  globalThis.fetch = realFetch;
  prices._reset();
});

// --------------------------------------------------------------------------------- the azure rewrite

describe('azure — the Foundry Models rewrite', () => {
  it('targets serviceName + a region, and the URL is urllib-safe', () => {
    const url = prices.azureUrl();
    expect(url).toContain('serviceName');
    expect(url).toContain('Foundry%20Models');
    expect(url).not.toContain('productName');
    expect(url).toContain('eastus2');
    expect(url).not.toContain(' '); // Python's urlopen refuses a raw space (the 2026-07-31 defect)
    expect(prices.azureUrl('westeurope')).toContain('westeurope');
  });

  it('is byte-identical to the Python twin (both percent-encode the apostrophes)', () => {
    // `encodeURIComponent` leaves `'` alone; Python's `quote` escapes it. Two mappers that cannot
    // be diffed is how the original Azure URL defect survived.
    expect(prices.azureUrl()).toBe(
      'https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview' +
        '&%24filter=serviceName%20eq%20%27Foundry%20Models%27%20and%20armRegionName%20eq%20%27eastus2%27',
    );
  });

  it('sends the region to the wire — it is mandatory, not cosmetic', async () => {
    // Measured: unregioned, the same query is >=25,000 rows and still paging after 28.5 s.
    const seen = stub({ 'prices.azure.com': '{"Items": []}' });
    await prices.refresh(undefined, { source: 'azure', region: 'swedencentral' });
    expect(seen[0]).toContain('swedencentral');
  });

  it('reads `opt` as OUTPUT', async () => {
    // 141 rows on 2026-08-01 spell output `opt`. The pre-fix parser looked only for `outp`/`output`,
    // so every GPT-5.x family had an input rate and NO output rate. GPT-5.1 is $1.25 in / $10 out.
    stub({
      'prices.azure.com': JSON.stringify({
        Items: [
          {
            skuName: 'GPT 5.1 inp Gl',
            retailPrice: 1.25,
            unitOfMeasure: '1M',
            productName: 'Azure OpenAI GPT5',
            type: 'Consumption',
          },
          {
            skuName: 'GPT 5.1 opt Gl',
            retailPrice: 10.0,
            unitOfMeasure: '1M',
            productName: 'Azure OpenAI GPT5',
            type: 'Consumption',
          },
        ],
      }),
    });
    expect(await prices.refresh(undefined, { source: 'azure' })).toBe(true);
    const c = prices.estimate('gpt-5.1', 1_000_000, { outputTokens: 1_000_000 });
    expect(c.amount.equals(new Dec('11.25'))).toBe(true);
  });

  it('never lets a batch, fine-tune or long-context meter become the base rate', async () => {
    stub({
      'prices.azure.com': JSON.stringify({
        Items: [
          {
            skuName: 'GPT 5.1 inp Gl',
            retailPrice: 1.25,
            unitOfMeasure: '1M',
            productName: 'Azure OpenAI GPT5',
            type: 'Consumption',
          },
          {
            skuName: 'GPT 5.1 Batch inp Gl',
            retailPrice: 0.625,
            unitOfMeasure: '1M',
            productName: 'Azure OpenAI GPT5',
            type: 'Consumption',
          },
          {
            skuName: 'GPT 5.1 inp Gl L',
            retailPrice: 0.5,
            unitOfMeasure: '1M',
            productName: 'Azure OpenAI GPT5',
            type: 'Consumption',
          },
          {
            skuName: '4.1 ft training Dz',
            retailPrice: 0.0275,
            unitOfMeasure: '1K',
            productName: 'Azure OpenAI',
            type: 'Consumption',
          },
        ],
      }),
    });
    await prices.refresh(undefined, { source: 'azure' });
    expect(prices.estimate('gpt-5.1', 1_000_000).amount.equals(new Dec('1.25'))).toBe(true);
  });

  it('reads unitOfMeasure per row (eastus2 mixes 905 `1K` with 479 `1M`)', async () => {
    stub({
      'prices.azure.com': JSON.stringify({
        Items: [
          {
            skuName: 'gpt-4o-0806-Inp-glbl',
            retailPrice: 0.0025,
            unitOfMeasure: '1K',
            productName: 'Azure OpenAI',
            type: 'Consumption',
          },
          {
            skuName: 'GPT 5 Inpt Glbl',
            retailPrice: 1.25,
            unitOfMeasure: '1M',
            productName: 'Azure OpenAI GPT5',
            type: 'Consumption',
          },
        ],
      }),
    });
    await prices.refresh(undefined, { source: 'azure' });
    expect(prices.estimate('gpt-4o', 1_000_000).amount.equals(new Dec('2.5'))).toBe(true);
    expect(prices.estimate('gpt-5', 1_000_000).amount.equals(new Dec('1.25'))).toBe(true);
  });

  it('applies a family root without mangling o1/o3', async () => {
    // A bare `4.3` under *Azure Grok Models* is grok-4.3; `V4 Pro` under *Azure Deepseek Models* is
    // deepseek-v4-pro. Applying the root unconditionally turned `o3` into `gpt-o3` — a regression.
    stub({
      'prices.azure.com': JSON.stringify({
        Items: [
          {
            skuName: 'o3 Inp glbl',
            retailPrice: 0.002,
            unitOfMeasure: '1K',
            productName: 'Azure OpenAI Reasoning',
            type: 'Consumption',
          },
          {
            skuName: '4.3 Inp Glbl',
            retailPrice: 0.00125,
            unitOfMeasure: '1K',
            productName: 'Azure Grok Models',
            type: 'Consumption',
          },
          {
            skuName: 'V4 Pro Inp glbl',
            retailPrice: 0.00174,
            unitOfMeasure: '1K',
            productName: 'Azure Deepseek Models',
            type: 'Consumption',
          },
          {
            skuName: 'GPT 5.2 pro inp Gl',
            retailPrice: 21.0,
            unitOfMeasure: '1M',
            productName: 'Azure OpenAI GPT5',
            type: 'Consumption',
          },
        ],
      }),
    });
    await prices.refresh(undefined, { source: 'azure' });
    const known = prices.models();
    expect(known).toContain('o3');
    expect(known).not.toContain('gpt-o3');
    expect(known).toContain('grok-4.3');
    expect(known).toContain('deepseek-v4-pro');
    expect(known).toContain('gpt-5.2-pro');
  });

  it('maps a cache-read meter', async () => {
    stub({
      'prices.azure.com': JSON.stringify({
        Items: [
          {
            skuName: 'GPT 5.1 inp Gl',
            retailPrice: 1.25,
            unitOfMeasure: '1M',
            productName: 'Azure OpenAI GPT5',
            type: 'Consumption',
          },
          {
            skuName: 'GPT 5.1 cd inp Gl',
            retailPrice: 0.125,
            unitOfMeasure: '1M',
            productName: 'Azure OpenAI GPT5',
            type: 'Consumption',
          },
        ],
      }),
    });
    await prices.refresh(undefined, { source: 'azure' });
    const c = prices.estimate('gpt-5.1', 1_000_000, { cachedTokens: 1_000_000 });
    expect(c.amount.equals(new Dec('0.125'))).toBe(true);
  });

  it('paginates (1,526 meters arrive over 2 pages)', async () => {
    const page1 = JSON.stringify({
      Items: [
        {
          skuName: 'gpt 4o Inp glbl',
          retailPrice: 0.0025,
          unitOfMeasure: '1K',
          productName: 'Azure OpenAI',
          type: 'Consumption',
        },
      ],
      NextPageLink: 'https://prices.azure.com/next-page',
    });
    const page2 = JSON.stringify({
      Items: [
        {
          skuName: 'gpt 4o Outp glbl',
          retailPrice: 0.01,
          unitOfMeasure: '1K',
          productName: 'Azure OpenAI',
          type: 'Consumption',
        },
      ],
    });
    const seen = stub({ 'next-page': page2, '%24filter': page1 });
    expect(await prices.refresh(undefined, { source: 'azure' })).toBe(true);
    expect(seen).toHaveLength(2);
    const c = prices.estimate('gpt-4o', 1000, { outputTokens: 500 });
    expect(c.amount.equals(new Dec('0.0075'))).toBe(true); // both pages mapped
  });

  it('NEGATIVE CONTROL: a wrong filter answers 200 with zero Items and changes nothing', async () => {
    stub({ 'prices.azure.com': '{"Items": []}' });
    expect(await prices.refresh(undefined, { source: 'azure' })).toBe(false);
    expect(prices.source()).toBe('bundled');
    expect(prices.estimate('gpt-4o', 1000).amount.equals(new Dec('0.0025'))).toBe(true);
  });
});

// ----------------------------------------------------------------------------------- the aws source

const AWS_INDEX = JSON.stringify({
  regions: { 'us-east-1': { currentVersionUrl: '/offers/v1.0/aws/X/2/us-east-1/index.json' } },
});
const awsFile = (
  products: Record<string, unknown>,
  terms: Record<string, unknown>,
  published = '2026-07-29T23:58:47Z',
) => JSON.stringify({ publicationDate: published, products, terms: { OnDemand: terms } });
const dim = (usd: string, unit = '1K tokens') => ({
  t: { priceDimensions: { d: { unit, pricePerUnit: { USD: usd } } } },
});

describe('aws — the Bedrock price files', () => {
  it('unions BOTH offer codes', async () => {
    // MEASURED, and the single most important AWS fact: `AmazonBedrock` alone carries only Claude
    // 2.0/2.1/3-Haiku/3-Sonnet/Instant. `Claude Sonnet 4` and `4.5` live ONLY in
    // `AmazonBedrockService`. A single-offer client silently misses every current Claude rate.
    const main = awsFile(
      {
        A: {
          attributes: {
            model: 'Claude 2.1',
            inferenceType: 'Input tokens',
            usagetype: 'USE1-Claude2.1-input-tokens',
          },
        },
      },
      { A: dim('0.008') },
    );
    const service = awsFile(
      {
        B: {
          attributes: {
            model: 'Claude Sonnet 4',
            inferenceType: 'Input tokens',
            usagetype: 'USE1-Claude4Sonnet-input-tokens-cross-region-global',
          },
        },
      },
      { B: dim('0.003') },
    );
    let fileCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('current/region_index.json')) return new Response(AWS_INDEX);
      fileCalls += 1;
      return new Response(fileCalls === 1 ? main : service);
    }) as typeof fetch;

    expect(await prices.refresh(undefined, { source: 'aws' })).toBe(true);
    expect(prices.sourceName()).toBe('aws');
    expect(prices.models()).toContain('claude-2-1');
    expect(prices.models()).toContain('claude-sonnet-4');
    expect(fileCalls).toBe(2); // both offer codes, every time
    expect(prices.snapshotDate()).toBe('2026-07-29'); // publicationDate, not today
  });

  it('never lets a batch usagetype become the base rate', async () => {
    // MEASURED: `Claude Sonnet 4` carries `inferenceType: "Input tokens"` on BOTH
    // `...-cross-region-global` ($3/MTok) and `...-cross-region-global-batch` ($1.50/MTok).
    // Cheapest-wins over `inferenceType` publishes the batch price as the standard one.
    const f = awsFile(
      {
        A: {
          attributes: {
            model: 'Claude Sonnet 4',
            inferenceType: 'Input tokens',
            usagetype: 'USE1-Claude4Sonnet-input-tokens-cross-region-global',
          },
        },
        B: {
          attributes: {
            model: 'Claude Sonnet 4',
            inferenceType: 'Input tokens',
            usagetype: 'USE1-Claude4Sonnet-input-tokens-cross-region-global-batch',
          },
        },
      },
      { A: dim('0.003'), B: dim('0.0015') },
    );
    stub({ 'current/region_index.json': AWS_INDEX, 'us-east-1/index.json': f });
    expect(await prices.refresh(undefined, { source: 'aws' })).toBe(true);
    expect(prices.estimate('claude-sonnet-4', 1_000_000).amount.equals(new Dec('3'))).toBe(true);
  });

  it('reads the usagetype when inferenceType is null (the cache rows)', async () => {
    const f = awsFile(
      {
        A: {
          attributes: {
            model: 'Claude Sonnet 4',
            inferenceType: 'Input tokens',
            usagetype: 'USE1-Claude4Sonnet-input-tokens-cross-region-global',
          },
        },
        C: {
          attributes: {
            model: 'Claude Sonnet 4',
            inferenceType: null,
            usagetype: 'USE1-Claude4Sonnet-cache-read-input-token-count-cross-region-global',
          },
        },
      },
      { A: dim('0.003'), C: dim('0.0003') },
    );
    stub({ 'current/region_index.json': AWS_INDEX, 'us-east-1/index.json': f });
    await prices.refresh(undefined, { source: 'aws' });
    const c = prices.estimate('claude-sonnet-4', 1000, { cachedTokens: 1000 });
    expect(c.amount.equals(new Dec('0.0003'))).toBe(true);
  });

  it('ignores non-token units (image / hour / TPM-Hour)', async () => {
    const f = awsFile(
      {
        A: {
          attributes: {
            model: 'Nova Canvas',
            inferenceType: 'T2I 1024 Standard',
            usagetype: 'USE1-NovaCanvas-input-tokens',
          },
        },
      },
      { A: dim('0.04', 'image') },
    );
    stub({ 'current/region_index.json': AWS_INDEX, 'us-east-1/index.json': f });
    expect(await prices.refresh(undefined, { source: 'aws' })).toBe(false);
    expect(prices.source()).toBe('bundled');
  });

  it('normalises display names and wire ids to the shape lookup produces', () => {
    expect(prices.awsModelKey('Claude Sonnet 4.5')).toBe('claude-sonnet-4-5');
    expect(prices.awsModelKey('Llama 3.3 70B')).toBe('llama-3-3-70b');
    expect(prices.awsModelKey('gpt-oss-120b')).toBe('gpt-oss-120b');
    expect(prices.awsModelKey('xai.grok-4.3')).toBe('grok-4.3');
    expect(prices.awsModelKey('google.gemma-4-31b')).toBe('gemma-4-31b');
  });

  it('sends the region to the wire', async () => {
    const idx = JSON.stringify({
      regions: { 'eu-west-1': { currentVersionUrl: 'https://p/eu.json' } },
    });
    const f = awsFile(
      {
        A: {
          attributes: {
            model: 'Claude Sonnet 4',
            inferenceType: 'Input tokens',
            usagetype: 'USE1-Claude4Sonnet-input-tokens',
          },
        },
      },
      { A: dim('0.003') },
    );
    const seen = stub({ region_index: idx, 'eu.json': f });
    expect(await prices.refresh(undefined, { source: 'aws', region: 'eu-west-1' })).toBe(true);
    expect(seen.some((u) => u.includes('eu.json'))).toBe(true);
  });
});

// ------------------------------------------------------------------------------ modelsdev / vercel

describe('modelsdev / vercel / litellm', () => {
  it('keeps a reseller from outranking the lab for the same id', async () => {
    // MEASURED: `gpt-5.1` appears under 11 models.dev providers between $1.07 and $1.25 per MTok,
    // and the providers with the most rows are all resellers (nano-gpt 617, kilo 346).
    stub({
      'models.dev': JSON.stringify({
        'nano-gpt': { models: { 'gpt-5.1': { cost: { input: 9, output: 9 } } } },
        opencode: { models: { 'gpt-5.1': { cost: { input: 1.07, output: 8.5 } } } },
        openai: {
          models: { 'gpt-5.1': { cost: { input: 1.25, output: 10 }, last_updated: '2026-07-20' } },
        },
      }),
    });
    expect(await prices.refresh(undefined, { source: 'modelsdev' })).toBe(true);
    expect(prices.sourceName()).toBe('modelsdev');
    expect(prices.estimate('gpt-5.1', 1_000_000).amount.equals(new Dec('1.25'))).toBe(true);
    expect(prices.snapshotDate()).toBe('2026-07-20'); // per-row last_updated, real provenance
  });

  it('ignores providers outside the allowlist entirely', async () => {
    stub({ 'models.dev': '{"nano-gpt": {"models": {"only-here": {"cost": {"input": 1}}}}}' });
    expect(await prices.refresh(undefined, { source: 'modelsdev' })).toBe(false);
    expect(prices.source()).toBe('bundled');
  });

  it('converts per-1M to per-token exactly', async () => {
    stub({
      'models.dev':
        '{"openai": {"models": {"gpt-4o": {"cost": {"input": 2.5, "output": 10, "cache_read": 1.25}}}}}',
    });
    await prices.refresh(undefined, { source: 'modelsdev' });
    const c = prices.estimate('gpt-4o', 1000, { outputTokens: 500, cachedTokens: 200 });
    expect(c.amount.equals(new Dec('0.00725'))).toBe(true);
  });

  it('vercel maps string rates and language models only, and stays undatable', async () => {
    stub({
      'ai-gateway.vercel.sh': JSON.stringify({
        data: [
          {
            id: 'openai/gpt-4o',
            type: 'language',
            pricing: { input: '0.0000025', output: '0.00001', input_cache_read: '0.00000125' },
          },
          { id: 'openai/dall-e-3', type: 'image', pricing: { input: '0.04' } },
        ],
      }),
    });
    expect(await prices.refresh(undefined, { source: 'vercel' })).toBe(true);
    expect(prices.sourceName()).toBe('vercel');
    expect(prices.models()).toContain('gpt-4o');
    expect(prices.models()).not.toContain('dall-e-3');
    expect(prices.snapshotDate()).toBeNull(); // never faked as today
  });

  it('litellm: a host-namespaced key never overwrites the bare one', async () => {
    // MEASURED, and it published a wrong number in the feed before it was caught:
    // `vertex_ai/claude-3-5-haiku` is VERTEX's $1/$5, not Anthropic's $0.80/$4.
    stub({
      'raw.githubusercontent.com': JSON.stringify({
        'claude-3-5-haiku': { input_cost_per_token: 0.0000008, output_cost_per_token: 0.000004 },
        'vertex_ai/claude-3-5-haiku': {
          input_cost_per_token: 0.000001,
          output_cost_per_token: 0.000005,
        },
        'heroku/claude-3-5-haiku': {
          input_cost_per_token: 0.000002,
          output_cost_per_token: 0.00001,
        },
      }),
    });
    await prices.refresh(undefined, { source: 'litellm' });
    expect(prices.estimate('claude-3-5-haiku', 1_000_000).amount.equals(new Dec('0.8'))).toBe(true);
  });

  it('litellm: a zero input rate is dropped, not published', async () => {
    // A $0 input rate makes estimate() report $0.00 as a FACT and a USD cap silently never bind.
    stub({
      'raw.githubusercontent.com': JSON.stringify({
        'free-model': { input_cost_per_token: 0, output_cost_per_token: 0 },
        'gpt-4o': { input_cost_per_token: 0.0000025, output_cost_per_token: 0.00001 },
      }),
    });
    await prices.refresh(undefined, { source: 'litellm' });
    expect(prices.models()).not.toContain('free-model');
    expect(() => prices.estimate('free-model', 1000)).toThrow(UnknownModelError);
  });
});

// ------------------------------------------------------------------------------- refresh(required)

describe('refresh({ required })', () => {
  it('throws instead of resolving false, and still reverts nothing', async () => {
    globalThis.fetch = (async () => {
      throw new Error('no network');
    }) as typeof fetch;
    expect(await prices.refresh()).toBe(false); // the default contract is unchanged
    await expect(prices.refresh(undefined, { required: true })).rejects.toThrow(PriceRefreshError);
    expect(prices.source()).toBe('bundled');
    expect(prices.estimate('gpt-4o', 1000).amount.equals(new Dec('0.0025'))).toBe(true);
  });

  it('throws on a 200 that maps to nothing (the Azure-wrong-filter shape)', async () => {
    stub({ 'prices.azure.com': '{"Items": []}' });
    await expect(prices.refresh(undefined, { source: 'azure', required: true })).rejects.toThrow(
      /no models/,
    );
  });

  it('throws on an unknown source name', async () => {
    await expect(prices.refresh(undefined, { source: 'nope', required: true })).rejects.toThrow(
      /unknown price source/,
    );
  });
});

describe('the default refresh() target', () => {
  it('is the cendor-prices feed', async () => {
    const seen = stub({
      'cendor-prices': '{"_updated": "2026-08-01", "models": {"x": {"input": 1}}}',
    });
    expect(await prices.refresh()).toBe(true);
    expect(seen[0]).toBe(prices.SNAPSHOT_URL);
    expect(prices.SNAPSHOT_URL).toContain('cendorhq/cendor-prices');
    expect(prices.sourceName()).toBe('feed');
  });

  it('lists all six built-in sources', () => {
    expect(prices.sources()).toEqual([
      'aws',
      'azure',
      'litellm',
      'modelsdev',
      'openrouter',
      'vercel',
    ]);
  });
});

// ------------------------------------------------------------------------------------------ explain

describe('explain()', () => {
  it('reports exact / normalized / registered / unpriced', () => {
    expect(prices.explain('gpt-4o').how).toBe('exact');
    const e = prices.explain('us.anthropic.claude-sonnet-4-6-20260115-v1:0');
    expect(e.how).toBe('normalized');
    expect(e.resolved).toBe('claude-sonnet-4-6');
    expect(prices.explain('no-such-model').how).toBe('unpriced');
    prices.registerModelPrice('my-deployment', { input: 2.5, output: 10 });
    const r = prices.explain('my-deployment');
    expect(r.how).toBe('registered');
    expect(r.registered).toBe(true);
    expect(r.notes.some((n) => n.includes('overrides every table'))).toBe(true);
  });

  it('surfaces per-row provenance from the feed, and no provenance string reaches a Decimal', async () => {
    stub({
      'cendor-prices': JSON.stringify({
        _updated: '2026-08-01',
        models: { 'gpt-4o': { input: 0.0000025, output: 0.00001 } },
        _provenance: { 'gpt-4o': { src: 'azure', asof: '2026-07-01' } },
      }),
    });
    await prices.refresh();
    const e = prices.explain('gpt-4o');
    expect(e.rowSource).toBe('azure');
    expect(e.rowAsof).toBe('2026-07-01');
    expect(e.sourceName).toBe('feed');
    expect(e.tableOrigin).toBe('refreshed');
    expect(e.summary()).toContain('azure as of 2026-07-01');
    expect(prices.estimate('gpt-4o', 1000).amount.equals(new Dec('0.0025'))).toBe(true);
  });

  it('flags a gateway resale source', async () => {
    stub({
      'ai-gateway.vercel.sh':
        '{"data": [{"id": "gpt-4o", "type": "language", "pricing": {"input": "0.000003"}}]}',
    });
    await prices.refresh(undefined, { source: 'vercel' });
    expect(prices.explain('gpt-4o').notes.some((n) => n.includes('RESALE'))).toBe(true);
  });

  it('flags an undatable table', async () => {
    stub({ 'raw.githubusercontent.com': '{"gpt-4o": {"input_cost_per_token": 0.0000025}}' });
    await prices.refresh(undefined, { source: 'litellm' });
    expect(prices.explain('gpt-4o').notes.some((n) => n.includes('no as-of date'))).toBe(true);
  });

  it('never throws on anything', () => {
    for (const weird of ['', '  ', 'a/b/c', 'us.anthropic.', 'gpt-4o-2026-01-01']) {
      expect(prices.explain(weird).model).toBe(weird);
    }
  });
});

// ---------------------------------------------------------------------------------- save() / load()

describe('save() / load() — explicit, opt-in persistence', () => {
  it('round-trips rates AND provenance', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'cendor-prices-'));
    try {
      stub({
        'cendor-prices': JSON.stringify({
          _updated: '2026-08-01',
          models: { 'gpt-4o': { input: 0.0000025, output: 0.00001 } },
          _provenance: { 'gpt-4o': { src: 'azure', asof: '2026-07-01' } },
        }),
      });
      await prices.refresh();
      const path = await prices.save(join(dir, 'nested', 'prices.json'));

      prices._reset();
      expect(prices.source()).toBe('bundled');
      expect(await prices.load(path)).toBe(true);
      expect(prices.source()).toBe('loaded');
      expect(prices.sourceName()).toBe('feed'); // the ORIGINAL source travels, not "a file"
      expect(prices.snapshotDate()).toBe('2026-08-01'); // ageDays() describes the data, not the read
      expect(prices.estimate('gpt-4o', 1000).amount.equals(new Dec('0.0025'))).toBe(true);
      const e = prices.explain('gpt-4o');
      expect([e.rowSource, e.rowAsof, e.tableOrigin]).toEqual(['azure', '2026-07-01', 'loaded']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes exact decimals as plain literals, not exponent form', async () => {
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'cendor-prices-'));
    try {
      stub({ 'cendor-prices': '{"models": {"m": {"input": 0.000000123456789012345}}}' });
      await prices.refresh();
      const path = await prices.save(join(dir, 'p.json'));
      expect(await readFile(path, 'utf8')).toContain('0.000000123456789012345');
      prices._reset();
      await prices.load(path);
      expect(prices.estimate('m', 1_000_000).amount.equals(new Dec('0.123456789012345'))).toBe(
        true,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('re-applies registrations on load, exactly as refresh does', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'cendor-prices-'));
    try {
      stub({ 'cendor-prices': '{"models": {"gpt-4o": {"input": 0.0000025}}}' });
      await prices.refresh();
      const path = await prices.save(join(dir, 'p.json'));
      prices._reset();
      prices.registerModelPrice('mine', { input: 2.5, output: 10 });
      expect(await prices.load(path)).toBe(true);
      expect(prices.estimate('mine', 1_000_000).amount.equals(new Dec('2.5'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a missing or junk file keeps the last-good table', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'cendor-prices-'));
    try {
      expect(await prices.load(join(dir, 'nope.json'))).toBe(false);
      expect(prices.source()).toBe('bundled');
      const junk = join(dir, 'junk.json');
      await writeFile(junk, 'not json at all', 'utf8');
      expect(await prices.load(junk)).toBe(false);
      const empty = join(dir, 'empty.json');
      await writeFile(empty, '{"models": {}}', 'utf8');
      expect(await prices.load(empty)).toBe(false);
      expect(prices.estimate('gpt-4o', 1000).amount.equals(new Dec('0.0025'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------ the pass-through path (measured defect)

describe('a pass-through refresh(url) with STRING rates', () => {
  it('still estimates and explains — rates are coerced at the swap', async () => {
    // ⚠️ MEASURED 2026-08-01 by the live cross-language trace, not by any offline test: every unit
    // fixture here used numeric rates, so nothing exercised a quoted one. `parseDecimalJson` turns
    // a JSON *number* into a Decimal but leaves a JSON *string* a string, and a table that quotes
    // its rates then made `estimate()` throw `inputRate.times is not a function`. Python never
    // showed it because its estimate() already coerced with `Decimal(str(...))`.
    stub({
      'cendor-prices': JSON.stringify({
        _updated: '2026-08-01',
        models: { 'gpt-4o': { input: '0.0000025', output: '0.00001', cached: '0.00000125' } },
        _provenance: { 'gpt-4o': { src: 'azure', asof: '2026-07-01' } },
      }),
    });
    expect(await prices.refresh()).toBe(true);
    const c = prices.estimate('gpt-4o', 1000, { outputTokens: 500, cachedTokens: 200 });
    expect(c.amount.equals(new Dec('0.00725'))).toBe(true);
    expect(prices.explain('gpt-4o').summary()).toContain('input=0.0000025');
  });

  it('the live feed itself parses into Decimals (the schema is number literals)', async () => {
    // `prices/1` specifies JSON number literals; the feed emits them, and `parseDecimalJson` reads
    // the token text verbatim so 0.000000123456789012345 survives to the last digit.
    stub({ 'cendor-prices': '{"models": {"m": {"input": 0.000000123456789012345}}}' });
    await prices.refresh();
    expect(prices.estimate('m', 1_000_000).amount.equals(new Dec('0.123456789012345'))).toBe(true);
  });
});
