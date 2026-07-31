// Gemini streaming capture — @google/genai's `generateContentStream`.
//
// The SDK streams through a *separate method*, not a `stream: true` kwarg, so before @cendor/core
// 3.1.0 a streamed Gemini call emitted **nothing at all** (measured live 2026-07-31: zero LLMCalls,
// both languages). Pinned here: one LLMCall on completion, real usage from the LAST chunk's
// `usageMetadata` (Gemini reports running totals on every chunk), a flagged offline estimate when a
// stream reports none, chunks passed through unchanged, and the stream-observer seam firing.
//
// No network. Chunks arrive with a **real cadence** — a generator that yields everything instantly
// cannot tell a per-chunk observer apart from a post-hoc one (org rail) — so `cadenced()` awaits a
// real timer between chunks and the test asserts the elapsed gap.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LLMCall, addStreamObserver, bus, instrument, removeStreamObserver } from '../src/index.js';

const CHUNK_GAP_MS = 15;

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

/** One @google/genai stream chunk. `usageMetadata` is camelCase and cumulative. */
function chunk(text: string, prompt?: number, candidates?: number, thoughts?: number): unknown {
  return {
    text,
    usageMetadata:
      prompt === undefined
        ? undefined
        : {
            promptTokenCount: prompt,
            candidatesTokenCount: candidates ?? 0,
            thoughtsTokenCount: thoughts,
          },
  };
}

/** An async generator with a real inter-chunk delay, plus a `closed` flag the abort path sets. */
function cadenced(chunks: unknown[], state: { closed: boolean }): AsyncGenerator<unknown> {
  async function* gen(): AsyncGenerator<unknown> {
    try {
      for (const [i, ch] of chunks.entries()) {
        if (i > 0) await new Promise((r) => setTimeout(r, CHUNK_GAP_MS));
        yield ch;
      }
    } finally {
      state.closed = true; // `return()` on early exit runs this
    }
  }
  return gen();
}

function client(stream: AsyncGenerator<unknown>): {
  models: {
    generateContent: (p: unknown) => Promise<unknown>;
    generateContentStream: (p: unknown) => Promise<AsyncGenerator<unknown>>;
  };
} {
  return {
    models: {
      generateContent: async (_p: unknown) => ({ usageMetadata: undefined }),
      generateContentStream: async (_p: unknown) => stream,
    },
  };
}

async function drain(stream: unknown): Promise<unknown[]> {
  const got: unknown[] = [];
  for await (const ch of stream as AsyncIterable<unknown>) got.push(ch);
  return got;
}

describe('instrument() — Gemini generateContentStream', () => {
  it('emits exactly one LLMCall with real usage, chunks unchanged', async () => {
    const state = { closed: false };
    const c = client(cadenced([chunk('One, ', 4, 3), chunk('two, three.', 4, 7)], state));
    instrument(c);

    const t0 = Date.now();
    const got = await drain(
      await c.models.generateContentStream({
        model: 'gemini-2.5-flash',
        contents: 'Count to three',
      }),
    );
    const elapsed = Date.now() - t0;

    expect(got.map((g) => (g as { text: string }).text)).toEqual(['One, ', 'two, three.']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.provider).toBe('google'); // not the internal `google_stream` tag
    expect(calls[0]?.model).toBe('gemini-2.5-flash');
    expect(calls[0]?.metadata.streamed).toBe(true);
    expect(calls[0]?.metadata.usage_estimated).toBeUndefined();
    // cumulative per-chunk counts -> the LAST chunk is the total, not the first
    expect(calls[0]?.usage?.inputTokens).toBe(4);
    expect(calls[0]?.usage?.outputTokens).toBe(7);
    expect(calls[0]?.cost?.amount.greaterThan(0)).toBe(true);
    // negative control on the cadence itself: the chunks really did arrive apart in time
    expect(elapsed).toBeGreaterThanOrEqual(CHUNK_GAP_MS);
  });

  it('takes the last usage-bearing chunk, not the first', async () => {
    const state = { closed: false };
    const c = client(cadenced([chunk('a', 5, 3), chunk('b', 5, 8), chunk('c', 5, 12)], state));
    instrument(c);
    await drain(
      await c.models.generateContentStream({ model: 'gemini-2.5-flash', contents: 'hi' }),
    );
    expect(calls[0]?.usage?.outputTokens).toBe(12);
  });

  it('folds thoughts into output and surfaces them as reasoning', async () => {
    const state = { closed: false };
    const c = client(cadenced([chunk('x', 6, 10, 4)], state));
    instrument(c);
    await drain(
      await c.models.generateContentStream({ model: 'gemini-2.5-flash', contents: 'hi' }),
    );
    expect(calls[0]?.usage?.outputTokens).toBe(14);
    expect(calls[0]?.usage?.reasoningTokens).toBe(4);
  });

  it('falls back to a FLAGGED offline estimate when a stream reports no usage', async () => {
    const state = { closed: false };
    const c = client(cadenced([chunk('hello '), chunk('world')], state));
    instrument(c);
    await drain(
      await c.models.generateContentStream({ model: 'gemini-2.5-flash', contents: 'hi there' }),
    );
    expect(calls[0]?.metadata.usage_estimated).toBe(true);
    expect(calls[0]?.usage?.outputTokens).toBeGreaterThan(0);
  });

  it('leaves the non-streaming twin working and does not double-wrap', async () => {
    const state = { closed: false };
    const c = client(cadenced([chunk('x', 1, 1)], state));
    instrument(c);
    const first = c.models.generateContentStream;
    instrument(c);
    expect(c.models.generateContentStream).toBe(first);
    await c.models.generateContent({ model: 'gemini-2.5-flash', contents: 'hi' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.metadata.streamed).toBeUndefined();
  });

  it('leaves a client without generateContentStream untouched', async () => {
    const c = {
      models: {
        generateContent: async (_p: unknown) => ({
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
        }),
      },
    };
    instrument(c);
    await c.models.generateContent({ model: 'gemini-2.5-flash', contents: 'hi' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.usage?.inputTokens).toBe(2);
  });

  it('runs stream observers per chunk; throwing aborts the stream and finalizes once', async () => {
    const seen: string[] = [];
    const observer = (_call: LLMCall, text: string): void => {
      seen.push(text);
      if (seen.length === 2) throw new Error('cut');
    };
    const state = { closed: false };
    const c = client(cadenced([chunk('a', 1, 1), chunk('b', 1, 2), chunk('c', 1, 3)], state));
    addStreamObserver(observer);
    try {
      instrument(c);
      await expect(
        drain(await c.models.generateContentStream({ model: 'gemini-2.5-flash', contents: 'hi' })),
      ).rejects.toThrow('cut');
    } finally {
      removeStreamObserver(observer);
    }
    expect(seen).toEqual(['a', 'b']);
    expect(state.closed).toBe(true); // the underlying generator was returned/closed
    expect(calls).toHaveLength(1);
    expect(calls[0]?.metadata.streamed).toBe(true);
  });
});
