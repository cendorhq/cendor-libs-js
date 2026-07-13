/**
 * instrument() embeddings capture (0.6.0): mocked openai-shaped clients, no network. Mirrors
 * tests/test_embeddings_capture.py. `embeddings.create` is wrapped like chat/responses: the
 * pre-flight interceptor pass runs, and the emitted LLMCall carries `metadata.embedding = true`,
 * usage from `response.usage`, and cost from the price table.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LLMCall,
  MISS,
  Reroute,
  addInterceptor,
  bus,
  instrument,
  removeInterceptor,
} from '../src/index.js';

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

function embeddingsClient(seen: Record<string, unknown>, promptTokens = 8) {
  return {
    chat: {
      completions: {
        create: async (_opts: Record<string, unknown>) => ({
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      },
    },
    embeddings: {
      create: async (opts: Record<string, unknown>) => {
        Object.assign(seen, opts);
        return {
          data: [{ embedding: [0.1, 0.2] }],
          usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
        };
      },
    },
  };
}

describe('instrument() embeddings capture', () => {
  it('emits an LLMCall with golden usage/cost and metadata.embedding', async () => {
    const seen: Record<string, unknown> = {};
    const client = instrument(embeddingsClient(seen, 1000));
    await client.embeddings.create({ model: 'text-embedding-3-small', input: 'hello world' });

    expect(calls.length).toBe(1);
    const call = calls[0];
    expect(call.provider).toBe('openai'); // internal openai_embeddings surfaces as openai
    expect(call.model).toBe('text-embedding-3-small');
    expect(call.metadata.embedding).toBe(true);
    expect(call.usage?.inputTokens).toBe(1000);
    expect(call.usage?.outputTokens).toBe(0);
    // golden: $0.02/1M -> 0.00000002/token * 1000 = 0.00002
    expect(call.cost?.amount.toString()).toBe('0.00002');
    expect(call.metadata.cost_estimated).toBe(true);
  });

  it('normalizes list input to message dicts', async () => {
    const seen: Record<string, unknown> = {};
    const client = instrument(embeddingsClient(seen));
    await client.embeddings.create({ model: 'text-embedding-3-small', input: ['a', 'b'] });
    expect(calls[0].messages).toEqual([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ]);
  });

  it('runs the pre-flight interceptor pass (a raising interceptor blocks the call)', async () => {
    const seen: Record<string, unknown> = {};
    const client = instrument(embeddingsClient(seen));
    const block = (call: unknown): unknown => {
      if (call instanceof LLMCall && call.metadata.embedding) throw new Error('blocked');
      return MISS;
    };
    addInterceptor(block);
    try {
      await expect(
        client.embeddings.create({ model: 'text-embedding-3-small', input: 'hello' }),
      ).rejects.toThrow('blocked');
    } finally {
      removeInterceptor(block);
    }
    expect(Object.keys(seen).length).toBe(0); // the provider was never called
  });

  it('maps a Reroute(messages) back to the raw input shape (redact-before-send)', async () => {
    const seen: Record<string, unknown> = {};
    const client = instrument(embeddingsClient(seen));
    const scrubber = (call: unknown): unknown => {
      if (call instanceof LLMCall && call.metadata.embedding) {
        return new Reroute({ messages: [{ role: 'user', content: '[email]' }] });
      }
      return MISS;
    };
    addInterceptor(scrubber);
    try {
      await client.embeddings.create({ model: 'text-embedding-3-small', input: 'bob@acme.com' });
    } finally {
      removeInterceptor(scrubber);
    }
    expect(seen.input).toBe('[email]'); // string input stays a string, content scrubbed
    expect(calls[0].messages).toEqual([{ role: 'user', content: '[email]' }]);

    for (const k of Object.keys(seen)) delete seen[k];
    addInterceptor(scrubber);
    try {
      await client.embeddings.create({
        model: 'text-embedding-3-small',
        input: ['bob@acme.com'],
      });
    } finally {
      removeInterceptor(scrubber);
    }
    expect(seen.input).toEqual(['[email]']); // list input stays a list
  });

  it('leaves chat capture unaffected', async () => {
    const seen: Record<string, unknown> = {};
    const client = instrument(embeddingsClient(seen));
    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(calls.length).toBe(1);
    expect(calls[0].metadata.embedding).toBeUndefined();
  });
});
