import { metrics } from '@opentelemetry/api';
/**
 * S8 — `OTelSink({ meter })` injection, and the global default unchanged.
 *
 * WHY (filed by the external black-box suite as a product improvement): `OTelSink` had no `meter`, so
 * the ONLY way to read its counters was to install a **process-global** meter provider.
 *
 * The JS metrics API has no proxy provider, so `OTelSink` acquires counters lazily per write until a
 * real provider answers (see `ensureCounters` and `otel-sink-lazy.test.ts`). An INJECTED meter needs
 * no such dance — there is nothing to wait for — so it binds in the constructor. Both paths are
 * asserted here, and the negative control is that the no-meter path still reaches the global provider.
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
  tags: { feature: 'search' },
  usd: '0.002',
  input_tokens: 100,
  output_tokens: 40,
  reasoning_tokens: 8,
  model: 'gpt-4o',
};

const providers: MeterProvider[] = [];

/** A provider that is NEVER registered globally — that is the whole point of the seam. */
function isolated(): {
  meter: ReturnType<MeterProvider['getMeter']>;
  collect: () => Promise<Record<string, number>>;
  attributeKeys: () => Promise<string[]>;
} {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
  const provider = new MeterProvider({ readers: [reader] });
  providers.push(provider);
  const walk = async (): Promise<
    Array<{ name: string; value: number; attributes: Record<string, unknown> }>
  > => {
    await provider.forceFlush();
    const rows: Array<{ name: string; value: number; attributes: Record<string, unknown> }> = [];
    for (const rm of exporter.getMetrics()) {
      for (const sm of rm.scopeMetrics) {
        for (const m of sm.metrics) {
          for (const dp of m.dataPoints) {
            rows.push({
              name: m.descriptor.name,
              value: Number(dp.value),
              attributes: dp.attributes,
            });
          }
        }
      }
    }
    return rows;
  };
  return {
    meter: provider.getMeter('test'),
    collect: async () => {
      const out: Record<string, number> = {};
      for (const r of await walk()) out[r.name] = (out[r.name] ?? 0) + r.value;
      return out;
    },
    attributeKeys: async () => {
      const keys = new Set<string>();
      for (const r of await walk()) for (const k of Object.keys(r.attributes)) keys.add(k);
      return [...keys].sort();
    },
  };
}

afterEach(async () => {
  for (const p of providers.splice(0)) await p.shutdown();
  metrics.disable(); // drop any global provider so each test starts from the noop state
});

describe('@cendor/tokenguard — OTelSink({ meter }) injection (S8)', () => {
  it('writes the same counters to an injected meter', async () => {
    const iso = isolated();
    new OTelSink({ meter: iso.meter }).write(ROW as never);

    const t = await iso.collect();
    expect(t['gen_ai.client.token.usage']).toBe(140); // 100 + 40
    expect(t['gen_ai.client.reasoning.token.usage']).toBe(8);
    expect(t['gen_ai.client.cost.usd']).toBeCloseTo(0.002, 9);
  });

  // --- NEGATIVE CONTROL: a sink on meter A must not increment meter B. ---
  it('keeps two injected meters isolated', async () => {
    const a = isolated();
    const b = isolated();
    new OTelSink({ meter: a.meter }).write(ROW as never);
    expect((await a.collect())['gen_ai.client.token.usage']).toBe(140);
    expect(await b.collect()).toEqual({});
  });

  // --- NEGATIVE CONTROL: no meter ⇒ the GLOBAL provider, exactly as before. ---
  it('still uses the global meter provider when no meter is passed', async () => {
    const iso = isolated();
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    const provider = new MeterProvider({ readers: [reader] });
    providers.push(provider);
    metrics.setGlobalMeterProvider(provider);

    new OTelSink().write(ROW as never);

    await provider.forceFlush();
    let tokens = 0;
    for (const rm of exporter.getMetrics())
      for (const sm of rm.scopeMetrics)
        for (const m of sm.metrics)
          if (m.descriptor.name === 'gen_ai.client.token.usage')
            for (const dp of m.dataPoints) tokens += Number(dp.value);
    expect(tokens).toBe(140);
    // …and the injected-style provider from this test saw nothing, because it was never wired.
    expect(await iso.collect()).toEqual({});
  });

  it('honours tags:false with an injected meter (the options do not interfere)', async () => {
    const iso = isolated();
    new OTelSink({ tags: false, meter: iso.meter }).write(ROW as never);
    expect(await iso.attributeKeys()).toEqual(['model']);
  });

  it('an injected meter binds immediately — no lazy re-check, no ordering trap', async () => {
    // The lazy path exists because a global provider can be installed AFTER construction. That cannot
    // happen to a meter the caller already holds, so the very FIRST write must land — with no global
    // provider registered anywhere in this test.
    const iso = isolated();
    const sink = new OTelSink({ meter: iso.meter });
    sink.write(ROW as never);
    expect((await iso.collect())['gen_ai.client.token.usage']).toBe(140);
  });
});
