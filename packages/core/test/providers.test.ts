// Provider breadth: Bedrock / Gemini (legacy) / Ollama / HuggingFace instrumentation + family
// detection. Mock clients only, no network. Ported from PY tests/test_providers.py — adapted to the
// real JS SDK method shapes (chatCompletion, generateContent, chat) and the async-first wrapper.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LLMCall, bus, instrument, tokens } from '../src/index.js';

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

describe('instrument() — provider breadth', () => {
  it('Bedrock: converse() is detected, usage read (camelCase) and priced', async () => {
    // NOTE: matches boto-shaped / wrapper clients that expose converse(); aws-sdk v3's command
    // pattern (client.send(new ConverseCommand(...))) is NOT auto-detected — see findTargets().
    const client = {
      converse: async (_p: unknown) => ({ usage: { inputTokens: 30, outputTokens: 12 } }),
    };
    instrument(client);
    await client.converse({
      modelId: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
    });
    const c = calls[0]!;
    expect(c.provider).toBe('bedrock');
    expect(c.model).toBe('claude-sonnet-4-6');
    expect(c.usage?.inputTokens).toBe(30);
    expect(c.usage?.outputTokens).toBe(12);
    expect(c.cost).not.toBeNull(); // priced from the bundled snapshot
  });

  it('Gemini legacy: model id read from the bound object (.model), "models/" stripped', async () => {
    // The legacy @google/generative-ai GenerativeModel binds the model to the object, not the call —
    // instrument() reads it so the LLMCall carries a real, priceable model id. This shape reports
    // snake_case usage keys, still read via the H3 fallback.
    const client = {
      model: 'models/gemini-2.5-pro',
      generateContent: async (_contents: unknown) => ({
        usage_metadata: { prompt_token_count: 40, candidates_token_count: 20 },
      }),
    };
    instrument(client);
    await client.generateContent('hello'); // positional string, no model arg — comes from the object
    const c = calls[0]!;
    expect(c.provider).toBe('google');
    expect(c.model).toBe('gemini-2.5-pro');
    expect(c.usage?.inputTokens).toBe(40);
    expect(c.usage?.outputTokens).toBe(20);
    expect(c.cost).not.toBeNull(); // gemini-2.5-pro is in the snapshot
  });

  it('Gemini @google/genai: camelCase usageMetadata captures usage + cost (H3)', async () => {
    // The real @google/genai Client returns camelCase usage (usageMetadata.promptTokenCount/…) and
    // the model rides the call arg. Regression: the google branch read Python snake_case only, so
    // usage/cost came back null on the actual JS SDK shape.
    const client = {
      models: {
        generateContent: async (_p: unknown) => ({
          usageMetadata: {
            promptTokenCount: 15,
            candidatesTokenCount: 8,
            thoughtsTokenCount: 4,
          },
        }),
      },
    };
    instrument(client);
    await client.models.generateContent({ model: 'gemini-2.5-pro', contents: 'hello' });
    const c = calls[0]!;
    expect(c.provider).toBe('google');
    expect(c.model).toBe('gemini-2.5-pro');
    expect(c.usage).not.toBeNull();
    expect(c.usage?.inputTokens).toBe(15);
    // thinking tokens fold into the output total: 8 candidates + 4 thoughts = 12
    expect(c.usage?.outputTokens).toBe(12);
    expect(c.usage?.reasoningTokens).toBe(4);
    expect(c.cost).not.toBeNull(); // gemini-2.5-pro is in the snapshot
  });

  it('Ollama: chat() callable detected, top-level counts read, local model is UNPRICED', async () => {
    const client = {
      chat: async (_p: unknown) => ({ prompt_eval_count: 7, eval_count: 5 }),
    };
    instrument(client);
    await client.chat({ model: 'llama3', messages: [{ role: 'user', content: 'hi' }] });
    const c = calls[0]!;
    expect(c.provider).toBe('ollama');
    expect(c.usage?.inputTokens).toBe(7);
    expect(c.usage?.outputTokens).toBe(5);
    // A local model has no LIST price, so cost is null — not $0.00. `llama3` used to sit in the
    // hand-fed snapshot at 0/0 (inherited from litellm), which made exactly one local model report
    // a fabricated $0.00 while every other one reported null. The generated snapshot publishes no
    // zero input rate at all. To cost your local runs, say so:
    // `prices.register('llama3', { input: 0, output: 0 })`.
    expect(c.cost).toBeNull();
  });

  it('HuggingFace: chatCompletion() detected first and attributed to "huggingface"', async () => {
    // The InferenceClient response is OpenAI-shaped, so usage reuses the OpenAI branch. Detecting
    // chatCompletion first (before the OpenAI-compat chat.completions.create) attributes it to HF.
    const client = {
      chatCompletion: async (_p: unknown) => ({
        usage: { prompt_tokens: 11, completion_tokens: 4 },
      }),
      chat: { completions: { create: async (_p: unknown) => ({}) } }, // OpenAI-compat surface
    };
    instrument(client);
    await client.chatCompletion({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    const c = calls[0]!;
    expect(c.provider).toBe('huggingface');
    expect(c.usage?.inputTokens).toBe(11);
    expect(c.usage?.outputTokens).toBe(4);
  });
});

describe('tokens.family() — extended detection', () => {
  it('classifies gemini / bedrock-prefixed claude / unknown', () => {
    expect(tokens.family('gemini-1.5-pro')).toBe('google');
    expect(tokens.family('anthropic.claude-sonnet-4-6')).toBe('anthropic'); // bedrock-prefixed id
    expect(tokens.family('llama3')).toBe('default');
  });
});
