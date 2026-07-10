import { afterEach, describe, expect, it } from 'vitest';
import { tokens } from '../src/index.js';
import type { Message } from '../src/index.js';
import { loadFixture } from './_fixtures.js';

interface TokenFixture {
  textCases: {
    text: string;
    model: string;
    count: number;
    method: string;
    family: string;
    isExact: boolean;
  }[];
  messageCases: { messages: Message[]; model: string; count: number }[];
}

const fx = loadFixture<TokenFixture>('tokens.json');

describe('tokens — cross-language conformance (tiktoken ↔ js-tiktoken)', () => {
  afterEach(() => tokens._reset());

  it.each(fx.textCases)('count($model, "$text") — exact match', (c) => {
    expect(tokens.count(c.text, c.model)).toBe(c.count);
    expect(tokens.family(c.model)).toBe(c.family);
    expect(tokens.method(c.model)).toBe(c.method);
    expect(tokens.isExact(c.model)).toBe(c.isExact);
  });

  it.each(fx.messageCases)('count(messages, $model) — exact match', (c) => {
    expect(tokens.count(c.messages, c.model)).toBe(c.count);
  });

  it('register() overrides a family counter', () => {
    tokens.register('openai', () => 999);
    expect(tokens.count('anything', 'gpt-4o')).toBe(999);
    expect(tokens.method('gpt-4o')).toBe('registered');
  });

  it('empty text is 0 tokens', () => {
    expect(tokens.count('', 'gpt-4o')).toBe(0);
  });
});

describe('tokens — H2 non-native BPE routing', () => {
  afterEach(() => tokens._reset());

  it('new o-series ids and OpenAI fine-tunes resolve to the openai family', () => {
    expect(tokens.family('o5-mini')).toBe('openai');
    expect(tokens.family('o1')).toBe('openai');
    expect(tokens.family('ft:gpt-4o:acme::abc123')).toBe('openai');
    expect(tokens.family('ft:gpt-4o-2024-08-06:acme::xyz')).toBe('openai');
    // non-OpenAI open/hosted models stay "default" (but now count via the o200k proxy).
    expect(tokens.family('llama-3.1-70b')).toBe('default');
    expect(tokens.family('deepseek-chat')).toBe('default');
    // "ollama"/"olmo" must not be mistaken for an o-series id.
    expect(tokens.family('ollama-thing')).toBe('default');
    expect(tokens.family('olmo-7b')).toBe('default');
  });

  it('non-OpenAI/hosted models use the o200k BPE proxy, not the char heuristic', () => {
    for (const m of ['llama-3.1-70b', 'mistral-large', 'deepseek-chat', 'qwen2.5-72b', 'o5-mini']) {
      expect(tokens.method(m)).toBe('bpe-estimate');
    }
    // llama counts identically to Claude/Gemini (all o200k) — not via a +12% char divisor.
    const sample = 'The quick brown fox jumps over the lazy dog. '.repeat(6);
    expect(tokens.count(sample, 'llama-3.1-70b')).toBe(tokens.count(sample, 'claude-opus-4-8'));
    expect(tokens.count(sample, 'mistral-large')).toBe(tokens.count(sample, 'gemini-2.5-pro'));
  });

  it('a fine-tuned OpenAI id counts exactly under its base model', () => {
    expect(tokens.method('ft:gpt-4o:acme::abc')).toBe('exact');
    expect(tokens.isExact('ft:gpt-4o:acme::abc')).toBe(true);
    const sample = 'hello world, this is a test of fine-tune tokenization';
    expect(tokens.count(sample, 'ft:gpt-4o:acme::abc')).toBe(tokens.count(sample, 'gpt-4o'));
  });
});
