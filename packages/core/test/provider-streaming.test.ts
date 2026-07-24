// Streaming usage recovery for Bedrock / Gemini / Ollama: chunks pass through unchanged, real usage
// recovered once on completion (never the offline estimate). Mock clients only, no network. Ported
// from PY tests/test_streaming.py (the Bedrock/Gemini/Ollama additions).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LLMCall, bus, instrument } from '../src/index.js';

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

async function drain(stream: unknown): Promise<unknown[]> {
  const got: unknown[] = [];
  for await (const ch of stream as AsyncIterable<unknown>) got.push(ch);
  return got;
}

describe('instrument() — provider streaming usage recovery', () => {
  it('Bedrock: recovers usage from the metadata event (camelCase)', async () => {
    const chunks = [
      { contentBlockDelta: { delta: { text: 'hi' } } },
      { metadata: { usage: { inputTokens: 30, outputTokens: 12 } } },
    ];
    async function* gen() {
      for (const ch of chunks) yield ch;
    }
    const client = { converse: async (_p: unknown) => gen() };
    instrument(client);
    const got = await drain(
      await client.converse({
        modelId: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: [{ text: 'hi' }] }],
        stream: true,
      }),
    );
    expect(got).toEqual(chunks);
    const c = calls[0]!;
    expect(c.provider).toBe('bedrock');
    expect(c.usage?.inputTokens).toBe(30);
    expect(c.usage?.outputTokens).toBe(12);
    expect(c.metadata.usage_estimated).toBeUndefined(); // real usage recovered
  });

  it('Gemini: recovers usage from the final full-response-shaped chunk', async () => {
    const chunks = [
      { text: 'par', usage_metadata: null },
      { text: 'tial', usage_metadata: { prompt_token_count: 40, candidates_token_count: 20 } },
    ];
    async function* gen() {
      for (const ch of chunks) yield ch;
    }
    const client = { models: { generateContent: async (_p: unknown) => gen() } };
    instrument(client);
    const got = await drain(
      await client.models.generateContent({
        model: 'gemini-1.5-pro',
        contents: 'hi',
        stream: true,
      }),
    );
    expect(got).toEqual(chunks);
    const c = calls[0]!;
    expect(c.provider).toBe('google');
    expect(c.usage?.inputTokens).toBe(40);
    expect(c.usage?.outputTokens).toBe(20);
    expect(c.metadata.usage_estimated).toBeUndefined();
  });

  it('Gemini streaming: camelCase usageMetadata on the final chunk (H3)', async () => {
    // The real @google/genai stream carries camelCase usage on the final chunk — must recover it
    // (not fall to an estimate) just like the non-streaming path.
    const chunks = [
      { text: 'par' },
      { text: 'tial', usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6 } },
    ];
    async function* gen() {
      for (const ch of chunks) yield ch;
    }
    const client = { models: { generateContent: async (_p: unknown) => gen() } };
    instrument(client);
    await drain(
      await client.models.generateContent({
        model: 'gemini-1.5-pro',
        contents: 'hi',
        stream: true,
      }),
    );
    const c = calls[0]!;
    expect(c.provider).toBe('google');
    expect(c.usage?.inputTokens).toBe(12);
    expect(c.usage?.outputTokens).toBe(6);
    expect(c.metadata.usage_estimated).toBeUndefined(); // real usage recovered, not estimated
  });

  it('Ollama: recovers top-level counts from the final chunk', async () => {
    const chunks = [
      { message: { content: 'par' } },
      { message: { content: 'tial' }, prompt_eval_count: 7, eval_count: 5 },
    ];
    async function* gen() {
      for (const ch of chunks) yield ch;
    }
    const client = { chat: async (_p: unknown) => gen() };
    instrument(client);
    const got = await drain(
      await client.chat({
        model: 'llama3',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    );
    expect(got).toEqual(chunks);
    const c = calls[0]!;
    expect(c.provider).toBe('ollama');
    expect(c.usage?.inputTokens).toBe(7);
    expect(c.usage?.outputTokens).toBe(5);
    expect(c.metadata.usage_estimated).toBeUndefined();
  });
});

// P1 parity port (G1): boto-shaped converse_stream — an always-stream target whose iterable arrives
// as the `stream` member of the response object. Mirrors PY test_core_captures_wl3.py L3 cases.
describe('instrument() — Bedrock converse_stream (always-stream, member shape)', () => {
  it('captures usage from the metadata event; response object + chunks pass through', async () => {
    const streamEvents = [
      { contentBlockDelta: { delta: { text: 'hel' } } },
      { contentBlockDelta: { delta: { text: 'lo' } } },
      { metadata: { usage: { inputTokens: 40, outputTokens: 12 } } },
    ];
    async function* gen() {
      for (const e of streamEvents) yield e;
    }
    const client = {
      converse: async (_p: unknown) => ({}), // present so detection keys off Bedrock
      converse_stream: async (_p: unknown) => ({
        stream: gen(),
        ResponseMetadata: { HTTPStatusCode: 200 },
      }),
    };
    instrument(client);
    const response = (await client.converse_stream({
      modelId: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
    })) as { stream: AsyncIterable<unknown>; ResponseMetadata?: unknown };

    expect(response.ResponseMetadata).toBeDefined(); // response object shape preserved
    const got = await drain(response.stream);
    expect(got).toEqual(streamEvents); // chunks pass through unchanged
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.provider).toBe('bedrock'); // public provider, not the internal bedrock_stream tag
    expect(c.model).toBe('claude-sonnet-4-6'); // modelId extracted for the streaming target too
    expect(c.usage?.inputTokens).toBe(40);
    expect(c.usage?.outputTokens).toBe(12);
    expect(c.metadata.usage_estimated).toBeUndefined(); // real usage from the metadata event
  });

  it('estimates thinking tokens from reasoningContent deltas when there is no metadata event', async () => {
    const streamEvents = [
      { contentBlockDelta: { delta: { reasoningContent: { text: 'thinking hard about it' } } } },
      { contentBlockDelta: { delta: { text: 'final answer' } } },
    ];
    async function* gen() {
      for (const e of streamEvents) yield e;
    }
    const client = {
      converse: async (_p: unknown) => ({}),
      converse_stream: async (_p: unknown) => ({ stream: gen() }),
    };
    instrument(client);
    const response = (await client.converse_stream({
      modelId: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
    })) as { stream: AsyncIterable<unknown> };
    await drain(response.stream);

    const c = calls[0]!;
    expect(c.metadata.usage_estimated).toBe(true); // no metadata event → offline estimate
    expect(c.usage?.reasoningTokens ?? 0).toBeGreaterThan(0);
  });
});
