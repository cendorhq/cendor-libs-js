// Newer client shapes: the @google/genai SDK (sync `client.models` + parity async `client.aio.models`)
// and non-dict message guards. Mock clients only, no network. Ported from PY tests/test_new_shapes.py
// (the OpenAI Responses cases are covered in instrument.test.ts). Adapted to camelCase generateContent.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LLMCall, type Message, bus, instrument, tokens } from '../src/index.js';

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

describe('instrument() — google-genai SDK', () => {
  it('sync: client.models.generateContent(model, contents) — model from the arg', async () => {
    const client = {
      models: {
        generateContent: async (_p: unknown) => ({
          usage_metadata: { prompt_token_count: 40, candidates_token_count: 20 },
        }),
      },
    };
    instrument(client);
    await client.models.generateContent({ model: 'gemini-2.5-pro', contents: 'hello' });
    const c = calls[0]!;
    expect(c.provider).toBe('google');
    expect(c.model).toBe('gemini-2.5-pro'); // read from the model arg (no bound object)
    expect(c.usage?.inputTokens).toBe(40);
    expect(c.usage?.outputTokens).toBe(20);
    expect(c.cost).not.toBeNull();
  });

  it('async: client.aio.models.generateContent — thoughts fold into output and surface as reasoning', async () => {
    const client = {
      aio: {
        models: {
          generateContent: async (_p: unknown) => ({
            usage_metadata: {
              prompt_token_count: 30,
              candidates_token_count: 10,
              thoughts_token_count: 4,
            },
          }),
        },
      },
    };
    instrument(client);
    await client.aio.models.generateContent({ model: 'gemini-1.5-pro', contents: 'hi' });
    const c = calls[0]!;
    expect(c.provider).toBe('google');
    expect(c.model).toBe('gemini-1.5-pro');
    expect(c.usage?.inputTokens).toBe(30);
    expect(c.usage?.outputTokens).toBe(14); // 10 candidates + 4 thoughts
    expect(c.usage?.reasoningTokens).toBe(4);
  });

  it('wraps both models and aio.models, idempotently', async () => {
    const client = {
      models: {
        generateContent: async (_p: unknown) => ({
          usage_metadata: { prompt_token_count: 1, candidates_token_count: 1 },
        }),
      },
      aio: {
        models: {
          generateContent: async (_p: unknown) => ({
            usage_metadata: { prompt_token_count: 2, candidates_token_count: 2 },
          }),
        },
      },
    };
    const originalSync = client.models.generateContent;
    instrument(client);
    expect(client.models.generateContent).not.toBe(originalSync); // both wrapped
    const firstSync = client.models.generateContent;
    const firstAsync = client.aio.models.generateContent;
    instrument(client);
    expect(client.models.generateContent).toBe(firstSync); // not double-wrapped
    expect(client.aio.models.generateContent).toBe(firstAsync);
  });
});

describe('tokens.count() — non-dict message guard', () => {
  it('tolerates bare strings and Part-like objects without throwing', () => {
    // Gemini list-`contents` can be bare strings or SDK Part-like objects, not dicts.
    expect(
      tokens.count(['hello', 'world'] as unknown as Message[], 'gemini-1.5-pro'),
    ).toBeGreaterThan(0);
    const part = { text: 'a thought' } as unknown as Message; // types.Part-like object
    expect(tokens.count([part], 'gemini-1.5-pro')).toBeGreaterThan(0);
    expect(
      tokens.count(['a', { role: 'user', content: 'b' }, part] as unknown as Message[], 'gpt-4o'),
    ).toBeGreaterThan(0);
  });

  it('gemini stream estimate with list-contents does not throw and estimates cleanly', async () => {
    // A stream with no usage_metadata forces the offline estimate path, which counts call.messages.
    async function* gen() {
      yield { text: 'partial' };
    }
    const client = { models: { generateContent: async (_p: unknown) => gen() } };
    instrument(client);
    const stream = (await client.models.generateContent({
      model: 'gemini-1.5-pro',
      contents: ['turn one', 'turn two'],
      stream: true,
    })) as AsyncIterable<unknown>;
    for await (const _ of stream) {
      /* drain */
    }
    const c = calls[0]!;
    expect(c.metadata.usage_estimated).toBe(true);
    expect(c.usage?.inputTokens).toBeGreaterThan(0);
  });
});
