// otel.span() is a no-op that never raises when @opentelemetry/api is absent (it is not installed in
// the test env); otel.ingest() has no OTel dependency and turns gen_ai.* attributes into a priced
// LLMCall on the shared bus. Ported from PY tests/test_otel.py + the otel.ingest cases in
// tests/test_providers.py.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LLMCall, bus, otel } from '../src/index.js';

let calls: LLMCall[];
function collector(event: unknown): void {
  if (event instanceof LLMCall) calls.push(event);
}
beforeEach(() => {
  calls = [];
  bus.subscribe(collector);
});
afterEach(() => {
  bus._reset();
});

describe('otel.span()', () => {
  it('is a no-op that yields null (and still runs the callback) when OTel is absent', () => {
    // Callback form: the span (or null) is passed to fn, whose return value is returned.
    let seen: unknown = 'unset';
    const result = otel.span('gpt-4o', { provider: 'openai', custom: 'x' }, (s) => {
      seen = s;
      return 'ok';
    });
    expect(seen).toBeNull();
    expect(result).toBe('ok');
  });
});

describe('otel.ingest()', () => {
  it('emits a priced LLMCall on the shared bus', () => {
    const call = otel.ingest({
      'gen_ai.system': 'azure_ai_foundry',
      'gen_ai.request.model': 'gpt-4o',
      'gen_ai.usage.input_tokens': 1000,
      'gen_ai.usage.output_tokens': 500,
    });
    expect(call).toBeInstanceOf(LLMCall);
    expect(call.provider).toBe('azure_ai_foundry');
    expect(call.usage?.inputTokens).toBe(1000);
    expect(call.usage?.outputTokens).toBe(500);
    expect(call.cost?.amount.toString()).toBe('0.0075'); // gpt-4o pricing
    expect(calls[0]).toBe(call); // joined the shared bus, like an instrumented call
    expect(call.metadata.source).toBe('otel');
  });

  it('reads cached + reasoning breakdowns and bills cached once', () => {
    const call = otel.ingest({
      'gen_ai.system': 'openai',
      'gen_ai.request.model': 'gpt-4o',
      'gen_ai.usage.input_tokens': 1000,
      'gen_ai.usage.output_tokens': 500,
      'gen_ai.usage.cached_tokens': 200,
      'gen_ai.usage.reasoning_tokens': 100,
    });
    expect(call.usage?.inputTokens).toBe(1000);
    expect(call.usage?.outputTokens).toBe(500);
    expect(call.usage?.cachedTokens).toBe(200);
    expect(call.usage?.reasoningTokens).toBe(100);
    // cached ⊆ input, billed once: 2.5e-6*(1000-200) + 1e-5*500 + 1.25e-6*200 = 0.00725
    expect(call.cost?.amount.toString()).toBe('0.00725');
  });

  it('does not emit when emit:false', () => {
    const call = otel.ingest(
      { 'gen_ai.request.model': 'gpt-4o', 'gen_ai.usage.input_tokens': 10 },
      { emit: false },
    );
    expect(call).toBeInstanceOf(LLMCall);
    expect(calls).toHaveLength(0);
  });
});
