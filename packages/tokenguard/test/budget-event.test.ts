/**
 * tokenguard emits a BudgetEvent on the bus for each pre-flight budget action (blocked/downgraded/
 * clamped). Mirrors test_budget_event.py. A blocked call never reaches the bus as an LLMCall, so the
 * BudgetEvent is the only signal the breaker fired — what acttrace chains and an OTel mirror alerts on.
 */
import { bus } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as tokenguard from '../src/index.js';
import { BudgetEvent, BudgetExceeded, withBudget } from '../src/index.js';
import { OTelSink } from '../src/sinks.js';
import { callN, makeClient } from './_helpers.js';

describe('BudgetEvent', () => {
  beforeEach(() => {
    bus._reset();
    tokenguard.reset();
  });
  afterEach(() => {
    bus._reset();
    tokenguard.reset();
  });

  function capture(): BudgetEvent[] {
    const events: BudgetEvent[] = [];
    bus.subscribe((ev) => {
      if (ev instanceof BudgetEvent) events.push(ev);
    });
    return events;
  }

  it('emits a blocked event on a pre-flight USD block', async () => {
    const events = capture();
    const client = makeClient();
    await expect(
      withBudget({ usd: 0.01, onExceed: 'block', scope: 'session' }, async () => {
        await callN(client, { n: 2 });
      }),
    ).rejects.toThrow(BudgetExceeded);

    const blocked = events.filter((e) => e.action === 'blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.model).toBe('gpt-4o');
    expect(blocked[0]?.capUsd).toBe('0.01');
    expect(blocked[0]?.scope).toBe('session');
    expect(blocked[0]?.projectedUsd).not.toBeNull();
  });

  it('emits a downgraded event on a pre-flight reroute', async () => {
    const events = capture();
    const client = makeClient();
    await withBudget(
      { usd: 0.001, onExceed: 'downgrade', downgrade: { 'gpt-4o': 'gpt-4o-mini' } },
      async () => {
        await callN(client);
      },
    );
    const dg = events.filter((e) => e.action === 'downgraded');
    expect(dg).toHaveLength(1);
    expect(dg[0]?.model).toBe('gpt-4o');
    expect(dg[0]?.toModel).toBe('gpt-4o-mini');
  });

  it('emits a clamped event on a pre-flight token clamp', async () => {
    const events = capture();
    const client = makeClient();
    await withBudget({ tokens: 1200, onExceed: 'clamp' }, async () => {
      await callN(client);
    });
    const clamped = events.filter((e) => e.action === 'clamped');
    expect(clamped).toHaveLength(1);
    expect(clamped[0]?.capTokens).toBe(1200);
  });

  it('carries the active track() tags', async () => {
    const events = capture();
    const client = makeClient();
    await expect(
      tokenguard.track({ feature: 'refund_sync', user_id: 'alice' }, async () => {
        await withBudget({ usd: 0.01, onExceed: 'block' }, async () => {
          await callN(client, { n: 2 });
        });
      }),
    ).rejects.toThrow(BudgetExceeded);
    const blocked = events.filter((e) => e.action === 'blocked');
    expect(blocked[0]?.tags.feature).toBe('refund_sync');
  });

  it('emits nothing when under the cap', async () => {
    const events = capture();
    const client = makeClient();
    await withBudget({ usd: 100.0, onExceed: 'block' }, async () => {
      await callN(client);
    });
    expect(events.filter((e) => e instanceof BudgetEvent)).toHaveLength(0);
  });

  it('carries name and description when set (G10)', async () => {
    const events = capture();
    const client = makeClient();
    await expect(
      withBudget(
        {
          usd: 0.01,
          onExceed: 'block',
          name: 'per-run cap',
          description: 'hard ceiling per support run',
        },
        async () => {
          await callN(client, { n: 2 });
        },
      ),
    ).rejects.toThrow(BudgetExceeded);
    const blocked = events.filter((e) => e.action === 'blocked');
    expect(blocked[0]?.name).toBe('per-run cap');
    expect(blocked[0]?.description).toBe('hard ceiling per support run');
  });

  it('leaves name/description null for an unnamed budget (G10)', async () => {
    const events = capture();
    const client = makeClient();
    await withBudget(
      { usd: 0.001, onExceed: 'downgrade', downgrade: { 'gpt-4o': 'gpt-4o-mini' } },
      async () => {
        await callN(client);
      },
    );
    const dg = events.filter((e) => e.action === 'downgraded');
    expect(dg[0]?.name).toBeNull();
    expect(dg[0]?.description).toBeNull();
  });

  it('the G15 counter increment never throws without OpenTelemetry', async () => {
    // Driving a real block exercises the budgetEventsAdd no-op path (OTel not installed here).
    const client = makeClient();
    await expect(
      withBudget({ usd: 0.01, onExceed: 'block', name: 'x' }, async () => {
        await callN(client, { n: 2 });
      }),
    ).rejects.toThrow(BudgetExceeded);
  });
});

describe('OTelSink attribution dimensions (G9)', () => {
  it('dimensions counters by track tags, and can suppress them', () => {
    const captured: { amount: number; attrs: Record<string, unknown> }[] = [];
    const fake = {
      add: (amount: number, attrs: Record<string, unknown>) => captured.push({ amount, attrs }),
    };

    const sink = new OTelSink();
    // Inject fake counters so the dimensioning is testable without an OTel SDK installed.
    (sink as unknown as Record<string, unknown>).tokensCounter = fake;
    (sink as unknown as Record<string, unknown>).reasoningCounter = fake;
    (sink as unknown as Record<string, unknown>).costCounter = fake;
    sink.write({
      tags: { feature: 'support', user_id: 'alice' },
      usd: '0.01',
      input_tokens: 10,
      output_tokens: 5,
      reasoning_tokens: 0,
      model: 'gpt-4o',
    });
    expect(captured[0]?.attrs.model).toBe('gpt-4o');
    expect(captured[0]?.attrs.feature).toBe('support');
    expect(captured[0]?.attrs.user_id).toBe('alice');

    const captured2: { amount: number; attrs: Record<string, unknown> }[] = [];
    const fake2 = {
      add: (amount: number, attrs: Record<string, unknown>) => captured2.push({ amount, attrs }),
    };
    const modelOnly = new OTelSink({ tags: false });
    (modelOnly as unknown as Record<string, unknown>).tokensCounter = fake2;
    (modelOnly as unknown as Record<string, unknown>).reasoningCounter = fake2;
    (modelOnly as unknown as Record<string, unknown>).costCounter = fake2;
    modelOnly.write({
      tags: { feature: 'support' },
      usd: '0.01',
      input_tokens: 1,
      output_tokens: 1,
      model: 'm',
    });
    expect(captured2[0]?.attrs).toEqual({ model: 'm' });
  });
});
