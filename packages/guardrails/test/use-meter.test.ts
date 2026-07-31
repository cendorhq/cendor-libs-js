import { metrics } from '@opentelemetry/api';
/**
 * S8 — `useMeter()` points the `cendor.guardrails.decisions` counter at a meter you own.
 *
 * WHY (filed by the external black-box suite as a product improvement): the counter had no injection
 * seam, so the ONLY way to read it was to install a **process-global** meter provider.
 *
 * The negative controls matter more than the feature: the default must still be the global provider,
 * `useMeter(null)` must genuinely restore that (not go permanently silent), and — measured in the
 * Python twin during this wave — a BROKEN meter must never take the governance decision down with it.
 */
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { afterEach, describe, expect, it } from 'vitest';
import { Verdict, apply, defineGuardrail, useMeter } from '../src/index.js';

const providers: MeterProvider[] = [];

function isolated(): {
  provider: MeterProvider;
  meter: ReturnType<MeterProvider['getMeter']>;
  collect: () => Promise<Record<string, number>>;
} {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
  const provider = new MeterProvider({ readers: [reader] });
  providers.push(provider);
  return {
    provider,
    meter: provider.getMeter('test'),
    collect: async () => {
      await provider.forceFlush();
      const out: Record<string, number> = {};
      for (const rm of exporter.getMetrics())
        for (const sm of rm.scopeMetrics)
          for (const m of sm.metrics)
            for (const dp of m.dataPoints)
              out[m.descriptor.name] = (out[m.descriptor.name] ?? 0) + Number(dp.value);
      return out;
    },
  };
}

const flagger = (name: string) =>
  defineGuardrail(() => new Verdict('flag', 'nope'), { stage: 'input', name });

afterEach(async () => {
  useMeter(null); // always hand the counter back to the global provider
  for (const p of providers.splice(0)) await p.shutdown();
  metrics.disable();
});

describe('@cendor/guardrails — useMeter injection (S8)', () => {
  it('increments the decisions counter on an injected meter', async () => {
    const iso = isolated();
    useMeter(iso.meter);
    apply([flagger('ban')], 'input', 'anything', { stage: 'input' });
    expect((await iso.collect())['cendor.guardrails.decisions']).toBe(1);
  });

  // --- NEGATIVE CONTROL: reset must restore the GLOBAL provider, not go silent forever. ---
  it('useMeter(null) restores the global default', async () => {
    const injected = isolated();
    useMeter(injected.meter);
    useMeter(null);

    const globalSide = isolated();
    metrics.setGlobalMeterProvider(globalSide.provider);
    apply([flagger('ban2')], 'input', 'anything', { stage: 'input' });

    expect((await injected.collect())['cendor.guardrails.decisions']).toBeUndefined();
    expect((await globalSide.collect())['cendor.guardrails.decisions']).toBe(1);
  });

  // --- NEGATIVE CONTROL: observability must never gate a decision. ---
  it('a meter whose add() throws does not break the gate', () => {
    useMeter({
      createCounter: () => ({
        add: () => {
          throw new Error('metrics backend down');
        },
      }),
    });
    const decisions = apply([flagger('ban3')], 'input', 'anything', { stage: 'input' });
    expect(decisions.map((d) => [d.guardrail, d.action])).toEqual([['ban3', 'flag']]);
  });
});
