import { metrics } from '@opentelemetry/api';
/**
 * OTelSink acquires its meter LAZILY (R3 / W0.4).
 *
 * The JS metrics API has no proxy provider: before `metrics.setGlobalMeterProvider`,
 * `metrics.getMeterProvider()` is a `NoopMeterProvider` and a counter taken from it stays a
 * `NoopCounterMetric` forever. Acquiring in the constructor therefore made `new OTelSink()` a
 * PERMANENT silent no-op for any app that constructed the sink before starting its OTel SDK — the
 * ordering trap the auto-wiring plan has to remove (Python is order-safe: its providers proxy).
 *
 * These tests need a real `@opentelemetry/api` + `@opentelemetry/sdk-metrics`, which this package now
 * carries as devDependencies (the peer stays optional at runtime).
 */
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { afterEach, describe, expect, it } from 'vitest';
import { OTelSink } from '../src/sinks.js';

const ROW = {
  tags: { feature: 'refunds' },
  usd: '0.0013',
  input_tokens: 100,
  output_tokens: 50,
  model: 'gpt-4o-mini',
};

function installProvider(): {
  collect: () => Promise<Record<string, number>>;
  provider: MeterProvider;
} {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
  const provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
  return {
    provider,
    collect: async () => {
      await provider.forceFlush();
      const out: Record<string, number> = {};
      for (const rm of exporter.getMetrics()) {
        for (const sm of rm.scopeMetrics) {
          for (const m of sm.metrics) {
            for (const dp of m.descriptor ? m.dataPoints : []) {
              out[m.descriptor.name] = (out[m.descriptor.name] ?? 0) + Number(dp.value);
            }
          }
        }
      }
      return out;
    },
  };
}

afterEach(() => {
  metrics.disable(); // drop the global provider so each test starts from the noop state
});

describe('OTelSink lazy meter (R3)', () => {
  it('records when the provider is registered AFTER construction (the ordering trap)', async () => {
    const sink = new OTelSink(); // <-- constructed while the global provider is still the noop
    const { collect } = installProvider();
    sink.write(ROW);
    const points = await collect();
    expect(points['gen_ai.client.cost.usd']).toBeCloseTo(0.0013, 9);
    expect(points['gen_ai.client.token.usage']).toBe(150);
    expect(points['gen_ai.client.reasoning.token.usage']).toBe(0);
  });

  it('still records when the provider was registered BEFORE construction', async () => {
    const { collect } = installProvider();
    const sink = new OTelSink();
    sink.write(ROW);
    expect((await collect())['gen_ai.client.token.usage']).toBe(150);
  });

  it('writes before any provider exists are silent — and do not poison the later binding', async () => {
    const sink = new OTelSink();
    expect(() => sink.write(ROW)).not.toThrow(); // noop meter — nothing recorded, nothing thrown
    const { collect } = installProvider();
    sink.write(ROW);
    // Only the post-registration write is counted: the earlier one went to the noop instrument.
    expect((await collect())['gen_ai.client.token.usage']).toBe(150);
  });

  it('caches the counters once bound (a later provider swap is not re-read per write)', async () => {
    const { collect, provider } = installProvider();
    const sink = new OTelSink();
    sink.write(ROW);
    sink.write(ROW);
    expect((await collect())['gen_ai.client.token.usage']).toBe(300);
    await provider.shutdown();
  });

  it('tags:false keeps the counters model-only (a user-side cardinality choice)', async () => {
    const { collect } = installProvider();
    new OTelSink({ tags: false }).write(ROW);
    expect((await collect())['gen_ai.client.token.usage']).toBe(150);
  });
});
