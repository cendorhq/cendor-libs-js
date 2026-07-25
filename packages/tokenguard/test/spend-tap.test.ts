import { bus, instrument } from '@cendor/core';
/**
 * The internal OTel spend tap (DR-3): spend reaches your backend with zero telemetry code. TS mirror
 * of cendor-libs' tests/test_spend_tap.py.
 *
 * The tap sits **beside** the user's `useSink` slot, never in it — `useSink` replaces, so wiring the
 * automatic export through that slot would mean a user's later `useSink(new SQLiteSink(...))` silently
 * switched backend spend off. Under `CENDOR_TELEMETRY=off` the tap never runs; without
 * `@opentelemetry/api` it is inert.
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
import { track, useSink } from '../src/index.js';
import { OTelSink, QueueSink } from '../src/sinks.js';

let exporter: InMemoryMetricExporter;
let provider: MeterProvider;

function installProvider(): void {
  exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  provider = new MeterProvider({
    readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
  });
  metrics.setGlobalMeterProvider(provider);
}

async function points(name: string): Promise<number> {
  await provider.forceFlush();
  let total = 0;
  for (const rm of exporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        if (m.descriptor.name !== name) continue;
        for (const dp of m.dataPoints) total += Number(dp.value);
      }
    }
  }
  return total;
}

async function attrsOf(name: string): Promise<Record<string, unknown>> {
  await provider.forceFlush();
  for (const rm of exporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        if (m.descriptor.name === name && m.dataPoints[0]) return m.dataPoints[0].attributes;
      }
    }
  }
  return {};
}

function fakeClient(prompt = 1000, completion = 500) {
  return {
    chat: {
      completions: {
        create: (_args?: unknown) => ({
          usage: { prompt_tokens: prompt, completion_tokens: completion },
        }),
      },
    },
  };
}

beforeEach(() => {
  Reflect.deleteProperty(process.env, 'CENDOR_TELEMETRY');
  bus._reset();
  tokenguard.reset();
  installProvider();
});
afterEach(async () => {
  tokenguard.reset();
  bus._reset();
  await provider.shutdown();
  metrics.disable();
});

describe('the internal spend tap', () => {
  it('a zero-code app records spend counters', async () => {
    const client = instrument(fakeClient());
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    expect(await points('gen_ai.client.token.usage')).toBe(1500);
    expect(await points('gen_ai.client.cost.usd')).toBeGreaterThan(0);
    expect((await attrsOf('gen_ai.client.token.usage')).model).toBe('gpt-4o');
  });

  it('carries track tags for attribution', async () => {
    const client = instrument(fakeClient());
    await track({ feature: 'refunds', user_id: 'alice' }, async () => {
      await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    });
    const attrs = await attrsOf('gen_ai.client.cost.usd');
    expect(attrs.feature).toBe('refunds');
    expect(attrs.user_id).toBe('alice');
  });

  it('the user sink and the tap both receive every row', async () => {
    const rows: unknown[] = [];
    useSink({ write: (r: unknown) => rows.push(r) });
    const client = instrument(fakeClient());
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    expect(rows).toHaveLength(1);
    expect(await points('gen_ai.client.token.usage')).toBe(1500);
  });

  it('clearing the user sink does not kill the tap', async () => {
    const client = instrument(fakeClient());
    useSink({ write: () => {} });
    useSink(null);
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    expect(await points('gen_ai.client.token.usage')).toBe(1500);
  });

  it('CENDOR_TELEMETRY=off kills the tap', async () => {
    process.env.CENDOR_TELEMETRY = 'off';
    const client = instrument(fakeClient());
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    expect(await points('gen_ai.client.token.usage')).toBe(0);
  });

  it('an explicit OTelSink makes the tap stand down (no double counting on upgrade)', async () => {
    useSink(new OTelSink());
    const client = instrument(fakeClient());
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    expect(await points('gen_ai.client.token.usage')).toBe(1500);
  });

  it('a QueueSink(OTelSink()) is recognised too', async () => {
    const q = new QueueSink(new OTelSink());
    useSink(q);
    const client = instrument(fakeClient());
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    await q.close();
    expect(await points('gen_ai.client.token.usage')).toBe(1500);
  });

  it('the tap emits the SAME metric names as OTelSink (one vocabulary, two writers)', async () => {
    const client = instrument(fakeClient());
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    await provider.forceFlush();
    const tapNames = new Set<string>();
    for (const rm of exporter.getMetrics())
      for (const sm of rm.scopeMetrics) for (const m of sm.metrics) tapNames.add(m.descriptor.name);
    tokenguard.reset();
    useSink(new OTelSink());
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    await provider.forceFlush();
    const sinkNames = new Set<string>();
    for (const rm of exporter.getMetrics())
      for (const sm of rm.scopeMetrics)
        for (const m of sm.metrics) sinkNames.add(m.descriptor.name);
    expect([...sinkNames].sort()).toEqual([...tapNames].sort());
  });
});
