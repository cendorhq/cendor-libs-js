/**
 * L2: onExceed: 'clamp' injects a per-provider output ceiling — flat (OpenAI/Anthropic) and nested
 * (Bedrock inferenceConfig.maxTokens, Ollama options.num_predict, Gemini plain-object
 * config.max_output_tokens). A typed Gemini config can't be safely merged → hard block. No network.
 */
import { bus, instrument } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as tokenguard from '../src/index.js';
import { BudgetExceeded, clamps, withBudget } from '../src/index.js';

describe('nested clamp injection', () => {
  beforeEach(() => {
    bus._reset();
    tokenguard.reset();
  });
  afterEach(() => {
    bus._reset();
    tokenguard.reset();
  });

  it('Bedrock: injects inferenceConfig.maxTokens (copy-on-write)', async () => {
    let seen: Record<string, unknown> = {};
    const c = instrument({
      converse: async (p: Record<string, unknown>) => {
        seen = p;
        return { usage: { inputTokens: 3, outputTokens: 2 } };
      },
    }) as { converse: (p: unknown) => Promise<unknown> };
    await withBudget({ tokens: 500, onExceed: 'clamp' }, async () => {
      await c.converse({
        modelId: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: [{ text: 'hi' }] }],
        inferenceConfig: { temperature: 0.5 },
      });
    });
    const cfg = seen.inferenceConfig as Record<string, unknown>;
    expect(Number(cfg.maxTokens)).toBeGreaterThan(0);
    expect(cfg.temperature).toBe(0.5); // preserved
    expect(clamps().some((r) => r.kwarg === 'inferenceConfig.maxTokens')).toBe(true);
  });

  it('Ollama: injects options.num_predict', async () => {
    let seen: Record<string, unknown> = {};
    const c = instrument({
      chat: async (p: Record<string, unknown>) => {
        seen = p;
        return { prompt_eval_count: 3, eval_count: 2 };
      },
    }) as { chat: (p: unknown) => Promise<unknown> };
    await withBudget({ tokens: 400, onExceed: 'clamp' }, async () => {
      await c.chat({
        model: 'llama3',
        messages: [{ role: 'user', content: 'hi' }],
        options: { temperature: 0.2 },
      });
    });
    const opts = seen.options as Record<string, unknown>;
    expect(Number(opts.num_predict)).toBeGreaterThan(0);
    expect(opts.temperature).toBe(0.2);
    expect(clamps().some((r) => r.kwarg === 'options.num_predict')).toBe(true);
  });

  it('Gemini dict config: merges max_output_tokens', async () => {
    let seen: Record<string, unknown> = {};
    const c = instrument({
      models: {
        generateContent: async (p: Record<string, unknown>) => {
          seen = p;
          return { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } };
        },
      },
    }) as { models: { generateContent: (p: unknown) => Promise<unknown> } };
    await withBudget({ tokens: 300, onExceed: 'clamp' }, async () => {
      await c.models.generateContent({
        model: 'gemini-1.5-pro',
        contents: 'hi',
        config: { temperature: 0.9 },
      });
    });
    const cfg = seen.config as Record<string, unknown>;
    expect(Number(cfg.max_output_tokens)).toBeGreaterThan(0);
    expect(cfg.temperature).toBe(0.9);
    expect(clamps().some((r) => r.kwarg === 'config.max_output_tokens')).toBe(true);
  });

  it('Gemini typed config: falls back to a hard block', async () => {
    class TypedConfig {
      temperature = 0.9;
    }
    const c = instrument({
      models: {
        generateContent: async () => ({
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
        }),
      },
    }) as { models: { generateContent: (p: unknown) => Promise<unknown> } };
    await expect(
      withBudget({ tokens: 300, onExceed: 'clamp' }, async () => {
        await c.models.generateContent({
          model: 'gemini-1.5-pro',
          contents: 'hi',
          config: new TypedConfig(),
        });
      }),
    ).rejects.toThrow(/cannot fit call/);
  });

  it("respects the caller's tighter cap", async () => {
    let seen: Record<string, unknown> = {};
    const c = instrument({
      converse: async (p: Record<string, unknown>) => {
        seen = p;
        return { usage: { inputTokens: 3, outputTokens: 2 } };
      },
    }) as { converse: (p: unknown) => Promise<unknown> };
    await withBudget({ tokens: 5000, onExceed: 'clamp' }, async () => {
      await c.converse({
        modelId: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: [{ text: 'hi' }] }],
        inferenceConfig: { maxTokens: 10 },
      });
    });
    expect((seen.inferenceConfig as Record<string, unknown>).maxTokens).toBe(10);
    expect(clamps()).toHaveLength(0);
  });
});
