/**
 * TG-STREAM-BREAKER — onExceed: 'break': mid-stream cut when the running estimate crosses the cap.
 * Mirrors test_stream_breaker.py. Mock streaming clients, no network. The TS core is async-first, so
 * `create` returns a Promise resolving to an async iterable; the breaker throws out of `for await`.
 */
import { LLMCall, bus, instrument } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as tokenguard from '../src/index.js';
import { BudgetEvent, BudgetExceeded, withBudget } from '../src/index.js';

describe('onExceed: break', () => {
  let events: unknown[];
  beforeEach(() => {
    bus._reset();
    tokenguard.reset();
    events = [];
    bus.subscribe((e) => events.push(e));
  });
  afterEach(() => {
    bus._reset();
    tokenguard.reset();
  });

  function content(text: string) {
    return { choices: [{ delta: { content: text } }], usage: null };
  }
  function budgetEvents(): BudgetEvent[] {
    return events.filter((e): e is BudgetEvent => e instanceof BudgetEvent);
  }
  function llmCalls(): LLMCall[] {
    return events.filter((e): e is LLMCall => e instanceof LLMCall);
  }

  /** An async stream that records aborts (its return() runs on IteratorClose when thrown out of). */
  function closableStream(chunks: unknown[]): {
    gen: () => AsyncGenerator<unknown>;
    aborted: () => boolean;
  } {
    let aborted = false;
    async function* gen() {
      try {
        for (const ch of chunks) yield ch;
      } finally {
        aborted = true;
      }
    }
    return { gen, aborted: () => aborted };
  }

  function client(gen: () => AsyncGenerator<unknown>) {
    return instrument({ chat: { completions: { create: async () => gen() } } }) as {
      chat: { completions: { create: (p: unknown) => Promise<AsyncIterable<unknown>> } };
    };
  }

  it('headline: cuts a runaway stream, one estimated emit, one broken event', async () => {
    const chunks = Array.from({ length: 50 }, () => content('one two three four five '));
    const s = closableStream(chunks);
    const c = client(s.gen);
    const got: unknown[] = [];
    await withBudget({ tokens: 20, onExceed: 'break', name: 'stream-cap' }, async () => {
      const stream = await c.chat.completions.create({
        model: 'gpt-4o',
        messages: [],
        stream: true,
      });
      await expect(async () => {
        for await (const ch of stream) got.push(ch);
      }).rejects.toThrow(/mid-stream break/);
    });
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThan(50);
    expect(s.aborted()).toBe(true); // IteratorClose aborted the underlying stream
    expect(llmCalls()).toHaveLength(1);
    expect(llmCalls()[0]!.metadata.usage_estimated).toBe(true);
    const broken = budgetEvents().filter((e) => e.action === 'broken');
    expect(broken).toHaveLength(1);
    expect(broken[0]!.name).toBe('stream-cap');
    expect(broken[0]!.capTokens).toBe(20);
  });

  it('exactly one raise (settle does not re-raise)', async () => {
    const chunks = Array.from({ length: 30 }, () => content('alpha beta gamma delta '));
    const c = client(closableStream(chunks).gen);
    let raises = 0;
    await withBudget({ tokens: 15, onExceed: 'break' }, async () => {
      const stream = await c.chat.completions.create({
        model: 'gpt-4o',
        messages: [],
        stream: true,
      });
      try {
        for await (const _ of stream) {
          /* drain */
        }
      } catch (e) {
        if (e instanceof BudgetExceeded) raises += 1;
      }
    });
    expect(raises).toBe(1);
    expect(llmCalls()).toHaveLength(1);
  });

  it('USD cap converts to a token allowance and cuts', async () => {
    const chunks = Array.from({ length: 200 }, () => content('some words here to bill '));
    const c = client(closableStream(chunks).gen);
    const got: unknown[] = [];
    await withBudget({ usd: 0.001, onExceed: 'break' }, async () => {
      const stream = await c.chat.completions.create({
        model: 'gpt-4o',
        messages: [],
        stream: true,
      });
      await expect(async () => {
        for await (const ch of stream) got.push(ch);
      }).rejects.toThrow(BudgetExceeded);
    });
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThan(200);
    expect(budgetEvents().filter((e) => e.action === 'broken')).toHaveLength(1);
  });

  it('counts visible thinking (Anthropic thinking_delta)', async () => {
    const chunks = Array.from({ length: 60 }, () => ({
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'reasoning step number here ' },
    }));
    const anthropic = instrument({
      messages: {
        create: async () =>
          (async function* () {
            for (const ch of chunks) yield ch;
          })(),
      },
    }) as { messages: { create: (p: unknown) => Promise<AsyncIterable<unknown>> } };
    const got: unknown[] = [];
    await withBudget({ tokens: 25, onExceed: 'break' }, async () => {
      const stream = await anthropic.messages.create({
        model: 'claude-opus-4-8',
        messages: [],
        stream: true,
      });
      await expect(async () => {
        for await (const ch of stream) got.push(ch);
      }).rejects.toThrow(BudgetExceeded);
    });
    expect(got.length).toBeLessThan(60);
    expect(llmCalls()[0]!.usage?.reasoningTokens ?? 0).toBeGreaterThan(0);
  });

  it('break is a valid value; a typo throws eagerly', () => {
    expect(() => tokenguard.budget({ tokens: 10, onExceed: 'break' })).not.toThrow();
    // @ts-expect-error — 'brake' is not an OnExceedMode
    expect(() => tokenguard.budget({ tokens: 10, onExceed: 'brake' })).toThrow(/on_exceed/);
  });
});
