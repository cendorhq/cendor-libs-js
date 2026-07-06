// Reasoning-token accounting across providers + streaming. Reasoning tokens are a *subset of* output
// tokens: providers that report them separately (OpenAI's completion_tokens_details.reasoning_tokens,
// Gemini's thoughts_token_count) populate Usage.reasoningTokens; providers that fold thinking into
// output_tokens without a separate count leave it 0. Cost is unaffected. Ported from PY
// tests/test_reasoning.py.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LLMCall, Usage, bus, instrument } from '../src/index.js';

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

describe('reasoning tokens', () => {
  it('are a subset of output, not added to the total', () => {
    const u = new Usage({ inputTokens: 200, outputTokens: 1200, reasoningTokens: 1000 });
    expect(u.reasoningTokens).toBe(1000);
    expect(u.totalTokens).toBe(1400); // 200 + 1200; reasoning lives inside output
  });

  it('OpenAI: reasoning_tokens extracted from completion_tokens_details', async () => {
    const client = {
      chat: {
        completions: {
          create: async (_p: unknown) => ({
            usage: {
              prompt_tokens: 200,
              completion_tokens: 1200, // already includes the 1000 reasoning tokens
              completion_tokens_details: { reasoning_tokens: 1000 },
            },
          }),
        },
      },
    };
    instrument(client);
    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'x' }],
    });
    const u = calls[0]!.usage!;
    expect(u.inputTokens).toBe(200);
    expect(u.outputTokens).toBe(1200);
    expect(u.reasoningTokens).toBe(1000);
  });

  it('OpenAI: stays zero without reasoning details', async () => {
    const client = {
      chat: {
        completions: {
          create: async (_p: unknown) => ({ usage: { prompt_tokens: 100, completion_tokens: 50 } }),
        },
      },
    };
    instrument(client);
    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(calls[0]!.usage?.reasoningTokens).toBe(0);
  });

  it('Gemini: thoughts folded into output and surfaced as reasoning', async () => {
    const client = {
      model: 'models/gemini-1.5-pro',
      generateContent: async (_contents: unknown) => ({
        usage_metadata: {
          prompt_token_count: 40,
          candidates_token_count: 20,
          thoughts_token_count: 80,
        },
      }),
    };
    instrument(client);
    await client.generateContent('hello');
    const u = calls[0]!.usage!;
    expect(u.inputTokens).toBe(40);
    expect(u.outputTokens).toBe(100); // 20 candidates + 80 thoughts
    expect(u.reasoningTokens).toBe(80);
  });

  it('Anthropic: reasoning stays 0 (thinking folded into output with no separate count)', async () => {
    const client = {
      messages: {
        create: async (_p: unknown) => ({
          usage: { input_tokens: 50, output_tokens: 300, cache_read_input_tokens: 0 },
        }),
      },
    };
    instrument(client);
    await client.messages.create({
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(calls[0]!.usage?.outputTokens).toBe(300);
    expect(calls[0]!.usage?.reasoningTokens).toBe(0);
  });

  it('OpenAI streaming: recovers reasoning from the final usage chunk', async () => {
    async function* gen() {
      yield { choices: [{ delta: { content: 'Hi' } }], usage: null };
      yield {
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 900,
          completion_tokens_details: { reasoning_tokens: 800 },
        },
      };
    }
    const client = { chat: { completions: { create: async (_p: unknown) => gen() } } };
    instrument(client);
    const stream = (await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    })) as AsyncIterable<unknown>;
    for await (const _ of stream) {
      /* drain */
    }
    const u = calls[0]!.usage!;
    expect(u.inputTokens).toBe(100);
    expect(u.outputTokens).toBe(900);
    expect(u.reasoningTokens).toBe(800);
    expect(calls[0]!.metadata.streamed).toBe(true);
  });
});
