/**
 * Budget enforcement via the core event bus — pre-flight block/downgrade/clamp, post-flight
 * raise/truncate/callable. Mirrors test_budget.py. Driven with mock-instrumented clients so spend is
 * real but no API is called. The TS core's `instrument()` is async, so every call is awaited.
 */
import { LLMCall, Money, instrument } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as tokenguard from '../src/index.js';
import {
  BudgetExceeded,
  type OnExceed,
  _projectedOutput,
  budget,
  downgrades,
  report,
  track,
  withBudget,
} from '../src/index.js';
import { type FakeClient, callN, makeClient } from './_helpers.js';

describe('budget', () => {
  beforeEach(() => {
    (tokenguard as unknown as { reset(): void }).reset();
  });
  afterEach(() => {
    tokenguard.reset();
  });

  it('raise stops a runaway loop (post-flight; overshoots by one call)', async () => {
    let n = 0;
    const client = makeClient({
      onCreate: () => {
        n += 1;
      },
    });
    await expect(
      withBudget({ usd: 0.01, onExceed: 'raise' }, async () => {
        await callN(client, { n: 100 });
      }),
    ).rejects.toThrow(BudgetExceeded);
    // Cap $0.01; each call $0.0075. Call 1 → $0.0075 (ok), call 2 → $0.015 (trips post-flight).
    expect(n).toBe(2);
  });

  it('block prevents the over-budget call pre-flight', async () => {
    let n = 0;
    const client = makeClient({
      onCreate: () => {
        n += 1;
      },
    });
    await expect(
      withBudget({ usd: 0.01, onExceed: 'block' }, async () => {
        await callN(client, { n: 100 });
      }),
    ).rejects.toThrow(BudgetExceeded);
    // Unlike "raise" (n==2), "block" refuses call 2's projection before it runs.
    expect(n).toBe(1);
  });

  it('under budget does not raise', async () => {
    const client = makeClient();
    await withBudget({ usd: 1.0, onExceed: 'raise' }, async () => {
      await callN(client, { n: 3 }); // $0.0225 total
    });
    expect(report().total().amount.greaterThan(0)).toBe(true);
  });

  it('truncate degrades gracefully in a decorator', async () => {
    const client = makeClient();
    const runaway = budget({ usd: 0.01, onExceed: 'truncate' })(async () => {
      await callN(client, { n: 100 });
      return 'completed';
    });
    expect(await runaway()).toBeUndefined(); // degraded, did not raise, did not complete
  });

  it('truncate in a callback scope exits cleanly', async () => {
    const client = makeClient();
    await withBudget({ usd: 0.01, onExceed: 'truncate' }, async () => {
      await callN(client, { n: 100 });
    });
    expect(report().total().amount.greaterThan(0)).toBe(true);
  });

  it('token budget trips', async () => {
    const client = makeClient(); // 1500 tokens/call
    await expect(
      withBudget({ tokens: 2000, onExceed: 'raise' }, async () => {
        await callN(client, { n: 10 });
      }),
    ).rejects.toThrow(BudgetExceeded);
  });

  it('callable onExceed is invoked instead of raising', async () => {
    const client = makeClient();
    const fired: unknown[] = [];
    await withBudget(
      {
        usd: 0.01,
        onExceed: (ctx) => {
          fired.push(ctx.spentUsd);
        },
      },
      async () => {
        await callN(client, { n: 3 });
      },
    );
    expect(fired.length).toBeGreaterThan(0);
  });

  it('budget + track work around async calls (contextvars → AsyncLocalStorage)', async () => {
    const client = makeClient();
    const handle = budget({ usd: 1.0 })(async () =>
      track({ feature: 'async_bot' }, async () =>
        client.chat.completions.create({ model: 'gpt-4o', messages: [] }),
      ),
    );
    await handle();
    const rows = report(['feature']).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.tags).toEqual({ feature: 'async_bot' });
    expect(rows[0]!.calls).toBe(1);
  });

  it('downgrade reroutes to the cheaper model pre-flight', async () => {
    const models: string[] = [];
    const client = makeClient({
      onCreate: (p) => {
        models.push(p.model as string);
      },
    });
    await withBudget(
      { usd: 0.001, onExceed: 'downgrade', downgrade: { 'gpt-4o': 'gpt-4o-mini' } },
      async () => {
        for (let i = 0; i < 3; i++) await callN(client, { n: 1 });
      },
    );
    expect(models).toEqual(['gpt-4o-mini', 'gpt-4o-mini', 'gpt-4o-mini']);
    const dg = downgrades();
    expect(dg.length).toBe(3);
    expect(dg[0]!.from).toBe('gpt-4o');
    expect(dg[0]!.to).toBe('gpt-4o-mini');
  });

  it('does not downgrade when under budget', async () => {
    const models: string[] = [];
    const client = makeClient({
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      onCreate: (p) => {
        models.push(p.model as string);
      },
    });
    await withBudget(
      { usd: 100.0, onExceed: 'downgrade', downgrade: { 'gpt-4o': 'gpt-4o-mini' } },
      async () => {
        await callN(client, { n: 1 });
      },
    );
    expect(models).toEqual(['gpt-4o']);
    expect(downgrades()).toEqual([]);
  });

  it('nested budgets: inner cap trips first', async () => {
    const client = makeClient(); // $0.0075/call
    await expect(
      withBudget({ usd: 5.0, scope: 'session' }, async () =>
        withBudget({ usd: 0.01 }, async () => {
          await callN(client, { n: 10 });
        }),
      ),
    ).rejects.toThrow(BudgetExceeded);
  });

  it('outer hard cap is enforced through an inner downgrade (no-op must not mask it)', async () => {
    const client = makeClient(); // $0.0075/call
    await expect(
      withBudget({ usd: 0.006, onExceed: 'raise' }, async () =>
        withBudget(
          { usd: 0.006, onExceed: 'downgrade', downgrade: { 'gpt-4o': 'gpt-4o-mini' } },
          async () => {
            await callN(client, { n: 2 }); // $0.015 — over both caps; outer must still trip
          },
        ),
      ),
    ).rejects.toThrow(BudgetExceeded);
  });

  it('rejects invalid config eagerly', () => {
    expect(() => budget({ usd: 1.0, onExceed: 'blok' as unknown as OnExceed })).toThrow();
    expect(() => budget({ onExceed: 'raise' })).toThrow(); // no cap
    expect(() => budget({ usd: 1.0, onExceed: 'downgrade' })).toThrow(); // no map
    expect(() => budget({ tokens: 100, onExceed: 'downgrade', downgrade: { a: 'b' } })).toThrow(); // downgrade needs a usd cap
  });

  it('output_reserve makes block more conservative', async () => {
    let n = 0;
    const client = makeClient({
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      onCreate: () => {
        n += 1;
      },
    });
    await expect(
      // 100k projected output * $0.00001 ≈ $1.0 > $0.50 cap → blocked before running
      withBudget({ usd: 0.5, onExceed: 'block', outputReserve: 100_000 }, async () => {
        await callN(client, { n: 1 });
      }),
    ).rejects.toThrow(BudgetExceeded);
    expect(n).toBe(0);
  });

  it('max_tokens=0 is honored, not treated as unset', () => {
    const call = new LLMCall({ id: '1', provider: 'openai', model: 'gpt-4o', messages: [] });
    call.metadata.request_kwargs = { max_tokens: 0 };
    expect(_projectedOutput(call, 256)).toBe(0); // 0 honored, not treated as falsy → 256
    call.metadata.request_kwargs = { max_completion_tokens: 0 };
    expect(_projectedOutput(call, 256)).toBe(0);
    call.metadata.request_kwargs = {}; // no cap → falls back to the reserve
    expect(_projectedOutput(call, 256)).toBe(256);
  });

  it('streaming budget fires on consumption, not launch', async () => {
    const chunks = [
      { choices: [{ delta: { content: 'hi' } }], usage: null },
      { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500 } }, // $0.0075
    ];
    const client = instrument({
      chat: { completions: { create: async () => chunks } },
    }) as unknown as FakeClient;

    await withBudget({ usd: 0.001, onExceed: 'raise' }, async () => {
      const stream = (await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })) as AsyncIterable<unknown>;
      // Launched but not consumed: nothing recorded yet, breaker has not fired.
      expect(report().total().eq(Money.zero())).toBe(true);
      // Draining records the spend and trips the post-flight breaker at that moment.
      let caught: unknown;
      try {
        for await (const _chunk of stream) {
          // drain
        }
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BudgetExceeded);
    });
  });
  // ── the post-flight message names the cap the caller actually set ─────────────────────────────
  //
  // Found 2026-07-30 driving a real Bedrock Converse call through the cendor-cookbook recipe: a
  // TOKEN budget whose pre-flight estimate fitted but whose settled usage did not raised
  //   "budget exceeded: spent $0.0140800 > cap $null … use on_exceed='block' …"
  // Three defects in one string: a token cap rendered as money, a literal `cap $null` where the
  // number belongs, and advice to use the option the caller had already passed. Enforcement was
  // always correct — only the sentence was wrong.

  async function messageFor(
    cfg: Record<string, unknown>,
    usage: Record<string, unknown>,
  ): Promise<string> {
    const client = makeClient({ usage });
    try {
      await withBudget(cfg as never, async () => {
        await callN(client, { n: 1 });
      });
    } catch (e) {
      if (!(e instanceof BudgetExceeded)) throw e;
      return String(e.message);
    }
    throw new Error('expected BudgetExceeded');
  }

  it('a token-cap breach is reported in tokens, never as `cap $null`', async () => {
    const msg = await messageFor(
      { tokens: 1000, onExceed: 'block' },
      { prompt_tokens: 8, completion_tokens: 1400 }, // small estimate, large settled usage
    );
    expect(msg).toContain('used 1408 tokens > cap 1000 tokens');
    expect(msg).not.toContain('cap $null');
    expect(msg.split('after')[0]).not.toContain('$');
  });

  it('a USD-cap breach is still reported in USD', async () => {
    const msg = await messageFor(
      { usd: 0.001, onExceed: 'raise' },
      { prompt_tokens: 1000, completion_tokens: 500 },
    );
    expect(msg).toContain('cap $0.001');
    expect(msg).not.toContain('tokens > cap');
  });

  it('both caps breached reports both', async () => {
    const msg = await messageFor(
      { usd: 0.001, tokens: 100, onExceed: 'raise' },
      { prompt_tokens: 1000, completion_tokens: 500 },
    );
    expect(msg).toContain('cap $0.001');
    expect(msg).toContain('used 1500 tokens > cap 100 tokens');
    expect(msg).toContain(' and ');
  });

  it('a `block` caller is not told to use `block`', async () => {
    const msg = await messageFor(
      { tokens: 1000, onExceed: 'block' },
      { prompt_tokens: 8, completion_tokens: 1400 },
    );
    expect(msg).not.toContain("use on_exceed='block'");
    expect(msg).toContain('the pre-flight estimate fitted the cap');
  });

  it('`raise` keeps its own advice', async () => {
    const msg = await messageFor(
      { usd: 0.001, onExceed: 'raise' },
      { prompt_tokens: 1000, completion_tokens: 500 },
    );
    expect(msg).toContain("on_exceed='raise' is post-flight");
  });
});
