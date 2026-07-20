// Opt-in content capture (G17), thinking parse (G18), the G20 span emitter, and TTFT (G23) — the TS
// mirror of PY tests/test_content_capture.py. The privacy assertions are the headline: capture is
// OFF by default; nothing content-bearing appears unless it is explicitly turned on. No OTel needed
// (the emitter is exercised with a fake tracer, like the acttrace mirror tests).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LLMCall, Money, ToolCall, Usage, bus, instrument, otel } from '../src/index.js';

beforeEach(() => {
  otel.resetCapture();
  bus._reset();
});
afterEach(() => {
  otel.resetCapture();
  bus._reset();
  process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = '';
});

describe('capture off by default', () => {
  it('emits no content attrs', () => {
    expect(otel.contentCapture().mode).toBe('off');
    expect(
      otel.contentAttrs({
        system: 'you are a bot',
        inputMessages: [{ role: 'user', content: 'secret' }],
      }),
    ).toEqual({});
    expect(otel.toolContentAttrs({ q: 'secret' }, 'answer')).toEqual({});
  });

  it('is enabled by the standard env var', () => {
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = 'true';
    expect(otel.contentCapture().mode).toBe('span');
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = 'false';
    expect(otel.contentCapture().mode).toBe('off');
  });
});

describe('capture on', () => {
  it('builds JSON-string content attrs', () => {
    otel.captureContent();
    const attrs = otel.contentAttrs({
      system: 'you are a bot',
      inputMessages: [{ role: 'user', content: 'hello' }],
    });
    expect(JSON.parse(attrs[otel.GENAI_INPUT_MESSAGES])).toEqual([
      { role: 'user', content: 'hello' },
    ]);
    expect(JSON.parse(attrs[otel.GENAI_SYSTEM_INSTRUCTIONS])[0].content).toBe('you are a bot');
  });

  it('applies the mask before export', () => {
    otel.captureContent({ mask: (msgs) => msgs.map((m) => ({ ...m, content: '[REDACTED]' })) });
    const attrs = otel.contentAttrs({ inputMessages: [{ role: 'user', content: 'ssn 123' }] });
    expect(attrs[otel.GENAI_INPUT_MESSAGES]).not.toContain('123');
  });

  it('fails closed when the mask throws', () => {
    otel.captureContent({
      mask: () => {
        throw new Error('bad');
      },
    });
    const attrs = otel.contentAttrs({ inputMessages: [{ role: 'user', content: 'sensitive' }] });
    expect(attrs[otel.GENAI_INPUT_MESSAGES]).not.toContain('sensitive');
    expect(attrs[otel.GENAI_INPUT_MESSAGES]).toContain('withheld');
  });

  it('caps bytes with a truncation marker', () => {
    otel.captureContent({ maxBytes: 64 });
    const attrs = otel.contentAttrs({
      inputMessages: [{ role: 'user', content: 'x'.repeat(500) }],
    });
    expect(attrs[otel.GENAI_INPUT_MESSAGES].endsWith(otel.TRUNCATION_MARKER)).toBe(true);
  });

  it('captures tool arg/result values', () => {
    otel.captureContent();
    const attrs = otel.toolContentAttrs({ q: 'weather' }, { temp: 20 });
    expect(attrs[otel.CENDOR_TOOL_ARGUMENTS]).toContain('weather');
    expect(attrs[otel.CENDOR_TOOL_RESULT]).toContain('20');
  });
});

describe('responseMessages (G18)', () => {
  function call(provider: string, response: unknown, meta: Record<string, unknown> = {}): LLMCall {
    const c = new LLMCall({ id: 'x', provider, model: 'm', messages: [] });
    c.metadata.response = response;
    Object.assign(c.metadata, meta);
    return c;
  }

  it('openai chat', () => {
    const msgs = otel.responseMessages(
      call('openai', { choices: [{ message: { content: 'The answer is 42.' } }] }),
    );
    expect(msgs).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'The answer is 42.' }] },
    ]);
  });

  it('anthropic thinking', () => {
    const parts = otel.responseMessages(
      call('anthropic', {
        content: [
          { type: 'thinking', thinking: 'reason' },
          { type: 'text', text: 'final' },
        ],
      }),
    )[0].parts as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: 'thinking', content: 'reason' });
    expect(parts[1]).toEqual({ type: 'text', content: 'final' });
  });

  it('gemini thought + bedrock reasoning', () => {
    const gp = otel.responseMessages(
      call('google', {
        candidates: [{ content: { parts: [{ text: 'hmm', thought: true }, { text: 'a' }] } }],
      }),
    )[0].parts as Array<Record<string, unknown>>;
    expect(gp).toContainEqual({ type: 'thinking', content: 'hmm' });
    const bp = otel.responseMessages(
      call('bedrock', {
        output: {
          message: {
            content: [{ reasoningContent: { reasoningText: { text: 's' } } }, { text: 'r' }],
          },
        },
      }),
    )[0].parts as Array<Record<string, unknown>>;
    expect(bp).toContainEqual({ type: 'thinking', content: 's' });
    expect(bp).toContainEqual({ type: 'text', content: 'r' });
  });

  it('empty when no response', () => {
    expect(
      otel.responseMessages(new LLMCall({ id: 'x', provider: 'openai', model: 'm', messages: [] })),
    ).toEqual([]);
  });
});

// --- G20 span emitter (fake tracer) + G23 TTFT -------------------------------------------------

interface RecordedSpan {
  name: string;
  attrs: Record<string, unknown>;
}
function fakeTracer(spans: RecordedSpan[]) {
  return {
    startSpan(name: string) {
      const attrs: Record<string, unknown> = {};
      spans.push({ name, attrs });
      return {
        setAttribute: (k: string, v: unknown): void => {
          attrs[k] = v;
        },
        end: (): void => {},
      };
    },
  };
}

describe('useSpanEmitter (G20)', () => {
  it('emits chat + tool spans; content off by default', () => {
    const spans: RecordedSpan[] = [];
    const dispose = otel.useSpanEmitter(fakeTracer(spans));
    const call = new LLMCall({
      id: '1',
      provider: 'openai',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    call.usage = new Usage({ inputTokens: 10, outputTokens: 5 });
    call.cost = new Money('0.001');
    call.latencyMs = 12;
    bus.emit(call);
    bus.emit(
      new ToolCall({ id: '2', name: 'search', arguments: { q: 'x' }, result: 'ok', latencyMs: 3 }),
    );
    dispose();
    const byName = Object.fromEntries(spans.map((s) => [s.name, s]));
    expect(byName['chat gpt-4o'].attrs['gen_ai.usage.input_tokens']).toBe(10);
    expect(byName['chat gpt-4o'].attrs[otel.GENAI_INPUT_MESSAGES]).toBeUndefined();
    expect(byName['execute_tool search']).toBeDefined();
  });

  it('includes content when opted in', () => {
    const spans: RecordedSpan[] = [];
    otel.captureContent();
    const dispose = otel.useSpanEmitter(fakeTracer(spans));
    const call = new LLMCall({
      id: '1',
      provider: 'openai',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    call.metadata.response = { choices: [{ message: { content: 'hello' } }] };
    bus.emit(call);
    dispose();
    expect(JSON.parse(spans[0].attrs[otel.GENAI_INPUT_MESSAGES] as string)).toEqual([
      { role: 'user', content: 'hi' },
    ]);
    expect(spans[0].attrs[otel.GENAI_OUTPUT_MESSAGES]).toContain('hello');
  });

  it('defers to an active liveSpans', () => {
    const spans: RecordedSpan[] = [];
    const dispose = otel.useSpanEmitter(fakeTracer(spans));
    otel.enterLiveSpans();
    bus.emit(new LLMCall({ id: '1', provider: 'openai', model: 'gpt-4o', messages: [] }));
    otel.exitLiveSpans();
    dispose();
    expect(spans).toHaveLength(0);
  });
});

describe('TTFT (G23)', () => {
  it('is stamped on a streamed call', async () => {
    const chunks = [
      { choices: [{ delta: { content: 'hi' } }], usage: null },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ];
    const seen: LLMCall[] = [];
    bus.subscribe((e) => {
      if (e instanceof LLMCall) seen.push(e);
    });
    const client = instrument({
      chat: {
        completions: {
          create: () =>
            (async function* () {
              for (const c of chunks) yield c;
            })(),
        },
      },
    });
    const stream = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    for await (const _ of stream as AsyncIterable<unknown>) {
      // drain
    }
    expect(typeof seen[0].metadata.ttft_ms).toBe('number');
  });
});
