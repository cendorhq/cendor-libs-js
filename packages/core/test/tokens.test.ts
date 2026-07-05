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
