/**
 * Reasoning-model handling: clamp, reasoning_reserve, the max_completion_tokens projection, and
 * reasoning surfaced in report()/sinks. Mirrors test_reasoning_guard.py.
 *
 * Adaptation: the Python "unsupported provider" case uses an Ollama-shaped client. The TS core's
 * `instrument()` only structurally detects openai/anthropic clients, so an ollama client isn't
 * wrapped; we exercise the identical clamp-fallback path by invoking the exported pre-flight
 * interceptor on a synthesized ollama `LLMCall` inside a clamp budget scope.
 */
import { LLMCall, instrument } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as tokenguard from '../src/index.js';
import {
  BudgetExceeded,
  _preflightInterceptor,
  budget,
  clamps,
  report,
  useSink,
  withBudget,
} from '../src/index.js';
import { SQLiteSink } from '../src/sinks.js';
import type { FakeClient } from './_helpers.js';

function openai(usage: Record<string, unknown>, seen: Record<string, unknown>[]): FakeClient {
  return instrument({
    chat: {
      completions: {
        create: async (params: Record<string, unknown>) => {
          seen.push(params);
          return { usage };
        },
      },
    },
  }) as unknown as FakeClient;
}

describe('reasoning guard', () => {
  beforeEach(() => tokenguard.reset());
  afterEach(() => tokenguard.reset());

  it('clamp requires a tokens cap', () => {
    expect(() => budget({ usd: 0.01, onExceed: 'clamp' })).toThrow(/clamp/);
  });

  it('clamp injects a provider ceiling when the budget runs low', async () => {
    const seen: Record<string, unknown>[] = [];
    const client = openai(
      {
        prompt_tokens: 100,
        completion_tokens: 850, // ~950 tokens/call
        completion_tokens_details: { reasoning_tokens: 800 },
      },
      seen,
    );
    await withBudget({ tokens: 1000, onExceed: 'clamp' }, async () => {
      // Call 1 is comfortably under the cap → untouched; spends ~950 of the 1000.
      await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      });
      // Call 2 would breach → clamp injects max_completion_tokens instead of blocking.
      await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      });
    });

    expect(clamps().length).toBe(1);
    const row = clamps()[0]!;
    expect(row.kwarg).toBe('max_completion_tokens');
    expect(row.limit).toBeGreaterThan(0);
    expect(row.limit).toBeLessThan(1000);
    expect('max_completion_tokens' in seen[0]!).toBe(false); // first call untouched
    expect(seen[1]!.max_completion_tokens).toBe(row.limit); // ceiling reached the provider
  });

  it('clamp falls back to a block on an unsupported provider', async () => {
    await withBudget({ tokens: 100, onExceed: 'clamp' }, async () => {
      const call = new LLMCall({
        id: '1',
        provider: 'ollama',
        model: 'llama3',
        messages: [{ role: 'user', content: 'hi' }],
        metadata: { request_kwargs: {} },
      });
      expect(() => _preflightInterceptor(call)).toThrow(/clamp/);
    });
  });

  it('block reads max_completion_tokens (not only max_tokens)', async () => {
    const seen: Record<string, unknown>[] = [];
    const client = openai({ prompt_tokens: 10, completion_tokens: 5 }, seen);
    await expect(
      withBudget({ tokens: 500, onExceed: 'block' }, async () => {
        await client.chat.completions.create({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
          max_completion_tokens: 1000, // 1000 > 500 cap → must block pre-flight
        });
      }),
    ).rejects.toThrow(/block/);
    expect(seen).toEqual([]); // the over-budget call never executed
  });

  it('reasoning_reserve tightens an uncapped projection', async () => {
    const seen: Record<string, unknown>[] = [];
    const client = openai({ prompt_tokens: 10, completion_tokens: 5 }, seen);
    await expect(
      withBudget({ tokens: 5000, onExceed: 'block', reasoningReserve: 10000 }, async () => {
        await client.chat.completions.create({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
        });
      }),
    ).rejects.toThrow(/block/);
    expect(seen).toEqual([]);
  });

  it('report and sink surface reasoning tokens', async () => {
    const sink = new SQLiteSink(':memory:');
    useSink(sink);
    const client = openai(
      {
        prompt_tokens: 100,
        completion_tokens: 1200,
        completion_tokens_details: { reasoning_tokens: 1000 },
      },
      [],
    );
    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'x' }],
    });

    const row = report().rows[0]!;
    expect(row.reasoning_tokens).toBe(1000);
    expect(row.output_tokens).toBe(1200);
    expect(row.tokens).toBe(100 + 1200); // reasoning is a subset of output — not double-counted

    const persisted = sink.rows()[0]!; // [tags, usd, input, output, reasoning, model]
    expect(persisted[4]).toBe(1000);
    sink.close();
    useSink(null);
  });
});
