import { bus } from '@cendor/core';
/**
 * tokenguard emits a BudgetEvent on the bus for each pre-flight budget action (blocked/downgraded/
 * clamped). Mirrors test_budget_event.py. A blocked call never reaches the bus as an LLMCall, so the
 * BudgetEvent is the only signal the breaker fired — what acttrace chains and an OTel mirror alerts on.
 */
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
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
  // W0.4: the sink now acquires its meter lazily per write, so a real in-memory MeterProvider tests
  // the dimensioning end-to-end — no more poking private counter fields (which also closes the
  // "OTelSink has no meter= seam" gap the external suite had filed against this test).
  afterEach(() => metrics.disable());

  function points(): { name: string; value: number; attrs: Record<string, unknown> }[] {
    const out: { name: string; value: number; attrs: Record<string, unknown> }[] = [];
    for (const rm of exporter.getMetrics()) {
      for (const sm of rm.scopeMetrics) {
        for (const m of sm.metrics) {
          for (const dp of m.dataPoints) {
            out.push({ name: m.descriptor.name, value: Number(dp.value), attrs: dp.attributes });
          }
        }
      }
    }
    return out;
  }
  let exporter: InMemoryMetricExporter;
  async function install(): Promise<MeterProvider> {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const provider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
    });
    metrics.setGlobalMeterProvider(provider);
    return provider;
  }

  it('dimensions counters by track tags', async () => {
    const provider = await install();
    new OTelSink().write({
      tags: { feature: 'support', user_id: 'alice' },
      usd: '0.01',
      input_tokens: 10,
      output_tokens: 5,
      reasoning_tokens: 0,
      model: 'gpt-4o',
    });
    await provider.forceFlush();
    const tokens = points().find((p) => p.name === 'gen_ai.client.token.usage');
    expect(tokens?.value).toBe(15);
    expect(tokens?.attrs).toEqual({ model: 'gpt-4o', feature: 'support', user_id: 'alice' });
  });

  it('tags:false suppresses them (model-only)', async () => {
    const provider = await install();
    new OTelSink({ tags: false }).write({
      tags: { feature: 'support' },
      usd: '0.01',
      input_tokens: 1,
      output_tokens: 1,
      model: 'm',
    });
    await provider.forceFlush();
    expect(points().find((p) => p.name === 'gen_ai.client.token.usage')?.attrs).toEqual({
      model: 'm',
    });
  });
});
