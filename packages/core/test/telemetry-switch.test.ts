/**
 * The telemetry switch (DR-1/DR-6): zero telemetry code, spans still flow. TS mirror of
 * cendor-libs' tests/test_telemetry_switch.py.
 *
 * An app that configures an OpenTelemetry provider normally and uses Cendor normally must get its
 * calls as `gen_ai.*` spans **without writing a line of telemetry code** — Cendor emits into the
 * provider the app configured and has no endpoint of its own. `CENDOR_TELEMETRY=off` turns it all off;
 * with `@opentelemetry/api` absent nothing is wired at all (see otel-absent.test.ts).
 *
 * No network: a fake client + an in-memory span exporter.
 */
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus, instrument, instrumentTool, otel } from '../src/index.js';
import { _resetAutoTelemetry } from '../src/otel.js';

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider | null = null;

function installProvider(): void {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
}

function names(): string[] {
  return exporter.getFinishedSpans().map((s) => s.name);
}

function fakeClient(
  prompt = 100,
  completion = 50,
): {
  chat: { completions: { create: (args: unknown) => unknown } };
} {
  return {
    chat: {
      completions: {
        create: () => ({ usage: { prompt_tokens: prompt, completion_tokens: completion } }),
      },
    },
  };
}

beforeEach(() => {
  bus._reset();
  _resetAutoTelemetry();
  Reflect.deleteProperty(process.env, 'CENDOR_TELEMETRY');
  Reflect.deleteProperty(process.env, 'CENDOR_DEBUG_TELEMETRY');
  exporter = new InMemorySpanExporter();
  installProvider();
});

afterEach(async () => {
  bus._reset();
  _resetAutoTelemetry();
  await provider?.shutdown();
  provider = null;
  trace.disable(); // drop the global provider so the next test starts from the proxy/noop state
});

describe('the telemetry switch', () => {
  it('a zero-telemetry-code app emits spans', async () => {
    const client = instrument(fakeClient());
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    expect(names()).toEqual(['chat gpt-4o']);
    const attrs = exporter.getFinishedSpans()[0]!.attributes;
    expect(attrs['gen_ai.operation.name']).toBe('chat');
    expect(attrs['gen_ai.usage.input_tokens']).toBe(100);
    expect(attrs['gen_ai.usage.output_tokens']).toBe(50);
    expect(attrs['gen_ai.usage.cost']).toBeTruthy();
    expect(otel.autoTelemetryState().emitting).toBe(true);
  });

  it('a provider registered AFTER the first calls still starts emitting', async () => {
    trace.disable(); // back to the noop delegate — the app has not configured OTel yet
    const client = instrument(fakeClient());
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    expect(exporter.getFinishedSpans()).toEqual([]);
    expect(otel.autoTelemetryState().armed).toBe(true); // armed and waiting
    installProvider();
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    expect(names()).toEqual(['chat gpt-4o']);
  });

  it('ingest() arms the emitter too (the managed-runtime path)', () => {
    otel.ingest({
      'gen_ai.system': 'az.ai.agents',
      'gen_ai.request.model': 'gpt-4o',
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 5,
    });
    expect(names()).toEqual(['chat gpt-4o']);
  });

  it('tool calls ride the same emitter', async () => {
    instrument(fakeClient()); // arm via the documented adoption point
    const getWeather = (instrumentTool('get_weather') as (fn: () => string) => () => string)(
      () => 'sunny',
    );
    getWeather();
    expect(names()).toEqual(['execute_tool get_weather']);
  });

  it('CENDOR_TELEMETRY=off kills everything', async () => {
    process.env.CENDOR_TELEMETRY = 'off';
    expect(otel.telemetryMode()).toBe('off');
    const client = instrument(fakeClient());
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    expect(exporter.getFinishedSpans()).toEqual([]);
    expect(otel.autoTelemetryState().armed).toBe(false); // nothing is even subscribed
  });

  it('off exported LATE still silences an armed emitter', async () => {
    const client = instrument(fakeClient());
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    expect(names()).toHaveLength(1);
    process.env.CENDOR_TELEMETRY = 'off';
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    expect(names()).toHaveLength(1);
  });

  it('an unknown switch value means auto (a typo never disables telemetry)', async () => {
    process.env.CENDOR_TELEMETRY = 'yes-please';
    expect(otel.telemetryMode()).toBe('auto');
    const client = instrument(fakeClient());
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    expect(names()).toEqual(['chat gpt-4o']);
  });

  it('a manual emitter supersedes the automatic one (never two spans)', async () => {
    const client = instrument(fakeClient()); // arms the auto path
    const off = otel.useSpanEmitter(); // …which this must supersede
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    expect(names()).toEqual(['chat gpt-4o']);
    const state = otel.autoTelemetryState();
    expect(state.manual).toBe(1);
    expect(state.armed).toBe(false);
    off();
  });

  it('manual first, then instrument(), is also single', async () => {
    const off = otel.useSpanEmitter();
    const client = instrument(fakeClient());
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    expect(names()).toEqual(['chat gpt-4o']);
    off();
  });

  it('disposing the manual emitter re-arms the automatic one', async () => {
    const client = instrument(fakeClient());
    otel.useSpanEmitter()();
    instrument(fakeClient()); // a fresh adoption re-arms
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    expect(names()).toEqual(['chat gpt-4o']);
  });

  it('a liveSpans scope still wins over the auto emitter', async () => {
    const client = instrument(fakeClient());
    await (async () => {
      await Promise.resolve();
      otel.enterLiveSpans();
      await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
      otel.exitLiveSpans();
    })();
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it('providerConfigured() reads the proxy delegate, not the proxy', () => {
    expect(otel.providerConfigured()).toBe(true);
    trace.disable();
    expect(otel.providerConfigured()).toBe(false);
  });

  it('the predicate is cheap enough to run per event', () => {
    // A regression guard, not a benchmark: it catches the class of mistake this code actually made —
    // loading `@opentelemetry/api` per call cost ~90 µs, 45× the call it observes. The bound is loose
    // on purpose (a shared CI runner is an order slower than a quiet machine) and nothing published
    // depends on it.
    const n = 5000;
    const start = performance.now();
    for (let i = 0; i < n; i++) otel.providerConfigured();
    const perCallUs = ((performance.now() - start) / n) * 1000;
    expect(perCallUs).toBeLessThan(20);
  });

  it('CENDOR_DEBUG_TELEMETRY=1 prints one line, and nothing without it', async () => {
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      process.env.CENDOR_DEBUG_TELEMETRY = '1';
      const client = instrument(fakeClient());
      await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
      await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    } finally {
      process.stderr.write = original;
    }
    const text = lines.join('');
    expect(text).toContain('cendor telemetry:');
    expect(text.split('emitter=attached').length - 1).toBe(1); // one-shot, never per event
  });
});
