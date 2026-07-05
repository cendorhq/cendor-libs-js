import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LLMCall,
  MISS,
  Reroute,
  ToolCall,
  addInterceptor,
  bus,
  currentTraceId,
  instrument,
  instrumentTool,
  removeInterceptor,
  trace,
} from '../src/index.js';

let calls: LLMCall[];
let tools: ToolCall[];
function collector(event: unknown): void {
  if (event instanceof LLMCall) calls.push(event);
  if (event instanceof ToolCall) tools.push(event);
}

beforeEach(() => {
  calls = [];
  tools = [];
  bus.subscribe(collector);
});
afterEach(() => {
  bus._reset();
});

// Real-SDK-shaped response fixtures (the exact field names openai-node / @anthropic-ai/sdk return).
function openAiChatClient(usage: unknown) {
  const client = {
    lastParams: undefined as unknown,
    chat: {
      completions: {
        create: async (params: unknown) => {
          client.lastParams = params;
          return {
            id: 'chatcmpl-1',
            choices: [{ message: { role: 'assistant', content: 'hi' } }],
            usage,
          };
        },
      },
    },
  };
  return client;
}

describe('instrument() — OpenAI Chat Completions', () => {
  it('emits a normalized LLMCall with usage + estimated cost', async () => {
    const client = openAiChatClient({
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 20 },
    });
    instrument(client);
    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.provider).toBe('openai');
    expect(c.model).toBe('gpt-4o');
    expect(c.usage?.inputTokens).toBe(100);
    expect(c.usage?.outputTokens).toBe(50);
    expect(c.usage?.cachedTokens).toBe(20);
    expect(c.cost).not.toBeNull();
    expect(c.metadata.cost_estimated).toBe(true);
    expect(c.metadata.response).toBeDefined();
  });

  it('is idempotent — re-instrumenting does not double-emit', async () => {
    const client = openAiChatClient({ prompt_tokens: 1, completion_tokens: 1 });
    instrument(client);
    instrument(client);
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    expect(calls).toHaveLength(1);
  });

  it('reads a gateway-reported cost in preference to an estimate', async () => {
    const client = openAiChatClient({ prompt_tokens: 10, completion_tokens: 5, cost: 0.0042 });
    instrument(client);
    await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    expect(calls[0]!.cost?.toString()).toBe('0.0042 USD');
    expect(calls[0]!.metadata.cost_reported).toBe(true);
  });
});

describe('instrument() — OpenAI Responses API', () => {
  it('surfaces provider "openai" and reads input/output/reasoning tokens', async () => {
    const client = {
      responses: {
        create: async (_p: unknown) => ({
          usage: {
            input_tokens: 200,
            output_tokens: 80,
            input_tokens_details: { cached_tokens: 10 },
            output_tokens_details: { reasoning_tokens: 30 },
          },
        }),
      },
    };
    instrument(client);
    await client.responses.create({ model: 'o3', input: 'solve this' });
    const c = calls[0]!;
    expect(c.provider).toBe('openai');
    expect(c.model).toBe('o3');
    expect(c.messages).toEqual([{ role: 'user', content: 'solve this' }]);
    expect(c.usage?.inputTokens).toBe(200);
    expect(c.usage?.cachedTokens).toBe(10);
    expect(c.usage?.reasoningTokens).toBe(30);
  });
});

describe('instrument() — Anthropic', () => {
  it('folds cache reads into input_tokens and keeps cache_write separate', async () => {
    const client = {
      messages: {
        create: async (_p: unknown) => ({
          usage: {
            input_tokens: 100,
            output_tokens: 40,
            cache_read_input_tokens: 25,
            cache_creation_input_tokens: 15,
          },
        }),
      },
    };
    instrument(client);
    await client.messages.create({
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const c = calls[0]!;
    expect(c.provider).toBe('anthropic');
    expect(c.usage?.inputTokens).toBe(125); // 100 + 25 cache read
    expect(c.usage?.cachedTokens).toBe(25);
    expect(c.usage?.cacheWrite).toBe(15);
    expect(c.usage?.totalTokens).toBe(165); // 125 + 40 (cache_write not added)
  });
});

describe('instrument() — streaming', () => {
  it('OpenAI: injects stream_options and emits once on completion', async () => {
    async function* gen() {
      yield { choices: [{ delta: { content: 'Hel' } }] };
      yield { choices: [{ delta: { content: 'lo' } }] };
      yield { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } };
    }
    const client = openAiChatClient(undefined);
    client.chat.completions.create = async (params: unknown) => {
      client.lastParams = params;
      return gen();
    };
    instrument(client);
    const stream = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [],
      stream: true,
    });
    const chunks: unknown[] = [];
    for await (const ch of stream as AsyncIterable<unknown>) chunks.push(ch);
    expect(chunks).toHaveLength(3);
    expect((client.lastParams as { stream_options?: unknown }).stream_options).toEqual({
      include_usage: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.usage?.inputTokens).toBe(5);
    expect(calls[0]!.usage?.outputTokens).toBe(2);
    expect(calls[0]!.metadata.streamed).toBe(true);
  });

  it('Anthropic: recovers usage from message_start + message_delta', async () => {
    async function* gen() {
      yield {
        type: 'message_start',
        message: { usage: { input_tokens: 50, cache_read_input_tokens: 10 } },
      };
      yield { type: 'content_block_delta', delta: { text: 'hello' } };
      yield { type: 'message_delta', usage: { output_tokens: 12 } };
    }
    const client = { messages: { create: async (_p: unknown) => gen() } };
    instrument(client);
    const stream = await client.messages.create({
      model: 'claude-opus-4-8',
      messages: [],
      stream: true,
    });
    for await (const _ of stream as AsyncIterable<unknown>) {
      /* drain */
    }
    expect(calls[0]!.usage?.inputTokens).toBe(60); // 50 + 10
    expect(calls[0]!.usage?.outputTokens).toBe(12);
    expect(calls[0]!.usage?.cachedTokens).toBe(10);
  });
});

describe('instrument() — interceptors', () => {
  it('replay: an interceptor short-circuits the real call', async () => {
    const realCreate = vi.fn(async () => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const client = { chat: { completions: { create: realCreate } } };
    instrument(client);
    const recorded = { usage: { prompt_tokens: 99, completion_tokens: 3 } };
    const interceptor = (_e: unknown) => recorded;
    addInterceptor(interceptor);
    try {
      const resp = await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
      expect(resp).toBe(recorded);
      expect(realCreate).not.toHaveBeenCalled();
      expect(calls[0]!.metadata.replayed).toBe(true);
      expect(calls[0]!.usage?.inputTokens).toBe(99);
    } finally {
      removeInterceptor(interceptor);
    }
  });

  it('Reroute: an interceptor rewrites the model before the real call', async () => {
    let seenModel = '';
    const client = {
      chat: {
        completions: {
          create: async (p: { model: string }) => {
            seenModel = p.model;
            return { usage: { prompt_tokens: 1, completion_tokens: 1 } };
          },
        },
      },
    };
    instrument(client);
    const interceptor = (_e: unknown) => new Reroute({ model: 'gpt-4o-mini' });
    addInterceptor(interceptor);
    try {
      await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
      expect(seenModel).toBe('gpt-4o-mini');
      expect(calls[0]!.model).toBe('gpt-4o-mini');
      expect(calls[0]!.metadata.rerouted).toBe(true);
    } finally {
      removeInterceptor(interceptor);
    }
  });

  it('MISS lets the real call proceed', async () => {
    const client = openAiChatClient({ prompt_tokens: 2, completion_tokens: 2 });
    instrument(client);
    const interceptor = (_e: unknown) => MISS;
    addInterceptor(interceptor);
    try {
      await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.metadata.replayed).toBeUndefined();
    } finally {
      removeInterceptor(interceptor);
    }
  });
});

describe('instrumentTool()', () => {
  it('emits a ToolCall for a sync tool', () => {
    const decorate = instrumentTool('search') as (
      fn: (q: string) => string,
    ) => (q: string) => string;
    const fn = decorate((q: string) => `result:${q}`);
    const out = fn('weather');
    expect(out).toBe('result:weather');
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('search');
    expect(tools[0]!.result).toBe('result:weather');
    expect(tools[0]!.arguments).toEqual({ args: ['weather'], kwargs: {} });
  });

  it('emits a ToolCall for an async tool', async () => {
    const decorate = instrumentTool('double') as (
      fn: (n: number) => Promise<number>,
    ) => (n: number) => Promise<number>;
    const fn = decorate(async (n: number) => n * 2);
    const out = await fn(21);
    expect(out).toBe(42);
    expect(tools[0]!.name).toBe('double');
    expect(tools[0]!.result).toBe(42);
  });
});

describe('trace()', () => {
  it('stamps the ambient traceId onto emitted calls', async () => {
    const client = openAiChatClient({ prompt_tokens: 1, completion_tokens: 1 });
    instrument(client);
    await trace('run-42', async () => {
      expect(currentTraceId()).toBe('run-42');
      await client.chat.completions.create({ model: 'gpt-4o', messages: [] });
    });
    expect(calls[0]!.traceId).toBe('run-42');
    expect(currentTraceId()).toBe('');
  });
});
