// Core stream-observer seam: per-chunk hook, throw-aborts contract, zero-observer byte-identity.
// This is the generic seam @cendor/tokenguard's mid-stream budget breaker rides. Mock clients only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LLMCall, addStreamObserver, bus, instrument, removeStreamObserver } from '../src/index.js';

let calls: LLMCall[];
const registered: Array<Parameters<typeof addStreamObserver>[0]> = [];
function collector(event: unknown): void {
  if (event instanceof LLMCall) calls.push(event);
}
function track(fn: Parameters<typeof addStreamObserver>[0]) {
  registered.push(fn);
  return addStreamObserver(fn);
}
beforeEach(() => {
  calls = [];
  bus.subscribe(collector);
});
afterEach(() => {
  bus._reset();
  for (const fn of registered.splice(0)) removeStreamObserver(fn);
});

function chunk(text: string) {
  return { choices: [{ delta: { content: text } }], usage: null };
}
function usageChunk(prompt: number, completion: number) {
  return { choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } };
}
function openai(chunks: unknown[]) {
  async function* gen() {
    for (const ch of chunks) yield ch;
  }
  return { chat: { completions: { create: async (_p: unknown) => gen() } } };
}
async function drain(stream: unknown): Promise<unknown[]> {
  const got: unknown[] = [];
  for await (const ch of stream as AsyncIterable<unknown>) got.push(ch);
  return got;
}

describe('core stream-observer seam', () => {
  it('zero observers: stream is byte-identical (fast path)', async () => {
    const chunks = [chunk('Hel'), chunk('lo'), usageChunk(3, 2)];
    const client = instrument(openai(chunks));
    const got = await drain(
      await client.chat.completions.create({ model: 'gpt-4o', messages: [], stream: true }),
    );
    expect(got).toEqual(chunks);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.usage?.outputTokens).toBe(2); // real usage, not the observer path
  });

  it('observer sees each visible delta in order; passthrough unchanged', async () => {
    const seen: Array<[string, string]> = [];
    track((_call, text, thinking) => seen.push([text, thinking]));
    const chunks = [chunk('Hel'), chunk('lo'), usageChunk(3, 2)];
    const client = instrument(openai(chunks));
    const got = await drain(
      await client.chat.completions.create({ model: 'gpt-4o', messages: [], stream: true }),
    );
    expect(got).toEqual(chunks);
    expect(seen.map(([t]) => t)).toEqual(['Hel', 'lo', '']);
    expect(seen.every(([, th]) => th === '')).toBe(true);
  });

  it('observer receives the same live LLMCall each chunk', async () => {
    const captured: LLMCall[] = [];
    track((call) => captured.push(call));
    const client = instrument(openai([chunk('x'), usageChunk(1, 1)]));
    await drain(
      await client.chat.completions.create({ model: 'gpt-4o', messages: [], stream: true }),
    );
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.every((c) => c instanceof LLMCall)).toBe(true);
    expect(captured[0]).toBe(captured[captured.length - 1]);
  });

  it('throwing aborts the stream and finalizes exactly once (partial, estimated)', async () => {
    let n = 0;
    let aborted = false;
    track(() => {
      n += 1;
      if (n === 2) throw new Error('cut');
    });
    const chunks = [chunk('a'), chunk('b'), chunk('c'), usageChunk(9, 9)];
    async function* gen() {
      try {
        for (const ch of chunks) yield ch;
      } finally {
        aborted = true; // IteratorClose ran when the consumer's for-await unwound on throw
      }
    }
    const client = { chat: { completions: { create: async (_p: unknown) => gen() } } };
    instrument(client);
    const stream = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });

    const got: unknown[] = [];
    await expect(async () => {
      for await (const ch of stream as AsyncIterable<unknown>) got.push(ch);
    }).rejects.toThrow('cut');

    expect(got).toHaveLength(1); // 1st chunk reached the consumer; crossing (2nd) withheld
    expect(aborted).toBe(true); // underlying stream's return() ran (controller aborts)
    expect(calls).toHaveLength(1);
    expect(calls[0]!.metadata.streamed).toBe(true);
    expect(calls[0]!.metadata.usage_estimated).toBe(true); // partial estimate, no real usage chunk
  });

  it('registration is idempotent; removing an absent observer is a no-op', async () => {
    const seen: string[] = [];
    const fn = (_call: LLMCall, text: string) => {
      seen.push(text);
    };
    track(fn);
    addStreamObserver(fn); // second add is a no-op
    const client = instrument(openai([chunk('a'), usageChunk(1, 1)]));
    await drain(
      await client.chat.completions.create({ model: 'gpt-4o', messages: [], stream: true }),
    );
    expect(seen).toEqual(['a', '']); // observed once per chunk, not twice
    removeStreamObserver(fn);
    removeStreamObserver(fn); // absent -> no throw
  });

  it('Anthropic thinking_delta folds into the estimate as reasoning', async () => {
    const chunks = [
      {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'let me think about this carefully' },
      },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } },
    ];
    async function* gen() {
      for (const ch of chunks) yield ch;
    }
    const client = { messages: { create: async (_p: unknown) => gen() } };
    instrument(client);
    await drain(
      await client.messages.create({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    );
    const call = calls[0]!;
    expect(call.metadata.usage_estimated).toBe(true);
    expect(call.usage?.reasoningTokens ?? 0).toBeGreaterThan(0);
    expect(call.usage?.outputTokens ?? 0).toBeGreaterThan(call.usage?.reasoningTokens ?? 0);
  });
});
