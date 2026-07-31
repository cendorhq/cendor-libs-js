/**
 * S8 — the OTel seams accept an injected tracer/meter, and the global default is unchanged.
 *
 * WHY (filed by the external black-box suite as a product improvement): `otel.span()` had no
 * `tracer`, and `OTelSink` / the guardrails decisions counter had no `meter`, so the ONLY way to
 * observe any of them was to install a **process-global** provider. cendor-testsuits' keyless tree had
 * to do exactly that for these three APIs and only these three.
 *
 * Every "now injectable" assertion is paired with the control that matters more: **the default still
 * goes to the global provider**. A seam that quietly stopped honouring the global provider would break
 * every existing deployment.
 *
 * NOTE: the injected tracer here is deliberately NOT registered globally — that is the whole point.
 */
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';
import { otel } from '../src/index.js';

function isolatedTracer(): {
  tracer: ReturnType<BasicTracerProvider['getTracer']>;
  exporter: InMemorySpanExporter;
  provider: BasicTracerProvider;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { tracer: provider.getTracer('test'), exporter, provider };
}

const providers: BasicTracerProvider[] = [];
function tracked(): ReturnType<typeof isolatedTracer> {
  const t = isolatedTracer();
  providers.push(t.provider);
  return t;
}

afterEach(async () => {
  for (const p of providers.splice(0)) await p.shutdown();
  trace.disable();
});

describe('@cendor/core — otel.span(tracer) injection (S8)', () => {
  it('emits on an injected tracer with the same name and attributes', () => {
    const { tracer, exporter } = tracked();
    const out = otel.span('gpt-4o', { provider: 'openai', tracer, extra: 'x' }, (sp) => {
      expect(sp).not.toBeNull();
      return 'value';
    });
    expect(out).toBe('value');

    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual(['chat gpt-4o']);
    expect(spans[0]!.attributes['gen_ai.request.model']).toBe('gpt-4o');
    expect(spans[0]!.attributes['gen_ai.system']).toBe('openai');
    expect(spans[0]!.attributes.extra).toBe('x');
  });

  it('does not record `tracer` itself as a span attribute', () => {
    const { tracer, exporter } = tracked();
    otel.span('m', { tracer }, () => undefined);
    expect(exporter.getFinishedSpans()[0]!.attributes).not.toHaveProperty('tracer');
  });

  // --- NEGATIVE CONTROL: two isolated tracers must not see each other's spans. ---
  it('keeps two injected tracers isolated', () => {
    const a = tracked();
    const b = tracked();
    otel.span('model-a', { tracer: a.tracer }, () => undefined);
    expect(a.exporter.getFinishedSpans().map((s) => s.name)).toEqual(['chat model-a']);
    expect(b.exporter.getFinishedSpans()).toEqual([]);
  });

  // --- NEGATIVE CONTROL: the default must still be the GLOBAL provider. ---
  it('still uses the global provider when no tracer is passed', () => {
    const { exporter, provider } = tracked();
    trace.setGlobalTracerProvider(provider);
    otel.span('global-model', {}, () => undefined);
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(['chat global-model']);
  });

  it('treats an explicitly null tracer as "use the global one", not "emit nothing"', () => {
    const { exporter, provider } = tracked();
    trace.setGlobalTracerProvider(provider);
    otel.span('null-tracer', { tracer: null }, () => undefined);
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(['chat null-tracer']);
  });

  it('ends the span after an async callback resolves, on an injected tracer too', async () => {
    const { tracer, exporter } = tracked();
    await otel.span('async-model', { tracer }, async () => {
      expect(exporter.getFinishedSpans()).toEqual([]); // not ended yet
      return 'done';
    });
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(['chat async-model']);
  });

  it('ends the span and rethrows when the callback throws, on an injected tracer', () => {
    const { tracer, exporter } = tracked();
    expect(() =>
      otel.span('throwing', { tracer }, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(['chat throwing']);
  });
});
