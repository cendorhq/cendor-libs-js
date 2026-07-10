/**
 * Budgeted assembly + the receipt. Deterministic. Mirrors the Python `test_contextkit.py` suite.
 *
 * Token-number note: the Python tests monkeypatch `tokens._tiktoken_encoding` to force the offline
 * `ceil(len/4)` heuristic. `@cendor/core` bundles js-tiktoken, so counts here are the REAL tiktoken
 * numbers (e.g. `"z"*400` = 200 tokens, not the heuristic's 100). Per-message *framing* is identical
 * — `(priming, per_message) = (3, 4)` — because it is derived from empty messages whose overhead
 * constants match. So structural assertions (kept/dropped/truncated, roundtrips, "<= budget",
 * ordering) port verbatim; exact token counts are recomputed against the real counter or asserted as
 * relationships.
 */
import { bus, tokens } from '@cendor/core';
import type { EvictionStrategy } from '@cendor/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AssemblyReport,
  Block,
  BlockDecision,
  BudgetError,
  Context,
  ValueError,
  useCompressor,
} from '../src/index.js';

afterEach(() => {
  bus._reset();
  useCompressor(null);
});

describe('contextkit', () => {
  it('exposes the public API', async () => {
    const mod = await import('../src/index.js');
    for (const name of [
      'Block',
      'Context',
      'AssemblyReport',
      'BlockDecision',
      'BudgetError',
      'useCompressor',
    ]) {
      expect(name in mod).toBe(true);
    }
  });

  it('has Block defaults', () => {
    const b = new Block('hi', { priority: 5, pin: true, role: 'system' });
    expect(b.evict).toBe('drop_oldest');
    expect(b.role).toBe('system');
    expect(b.pin).toBe(true);
  });

  it('keeps everything under budget', async () => {
    const ctx = new Context({ budgetTokens: 1000, model: 'gpt-4o' });
    ctx.add(new Block('system prompt', { priority: 10, pin: true, role: 'system' }));
    ctx.add(new Block('the question', { priority: 9, pin: true, role: 'user' }));
    const messages = await ctx.assemble();
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']); // system first, user last
    expect(ctx.report().decisions.every((d) => d.action === 'kept')).toBe(true);
  });

  it('drop_oldest evicts low priority when tight', async () => {
    const ctx = new Context({ budgetTokens: 8, model: 'gpt-4o' }); // ~8 tokens of room
    ctx.add(new Block('x'.repeat(4), { priority: 10, role: 'system' })); // ~1 tok, kept
    ctx.add(new Block('y'.repeat(200), { priority: 1, role: 'user', evict: 'drop_oldest' }));
    const messages = await ctx.assemble();
    const roles = messages.map((m) => m.role);
    expect(roles).not.toContain('user'); // low-priority block dropped
    const dropped = ctx.report().decisions.filter((d) => d.action === 'dropped');
    expect(dropped.length).toBe(1);
    expect(dropped[0]!.role).toBe('user');
  });

  it('truncate shrinks to fit', async () => {
    const ctx = new Context({ budgetTokens: 40, model: 'gpt-4o' });
    ctx.add(new Block('s', { priority: 10, role: 'system' }));
    ctx.add(new Block('z'.repeat(400), { priority: 1, role: 'user', evict: 'truncate' }));
    await ctx.assemble();
    const decision = ctx.report().decisions.find((d) => d.role === 'user')!;
    expect(decision.action).toBe('truncated');
    expect(decision.tokensAfter).toBeLessThan(decision.tokensBefore);
    expect(ctx.report().used).toBeLessThanOrEqual(
      ctx.report().budget - ctx.report().reservedOutput,
    );
  });

  it('raises on pinned overflow', async () => {
    const ctx = new Context({ budgetTokens: 5, model: 'gpt-4o' });
    ctx.add(new Block('w'.repeat(400), { priority: 10, pin: true, role: 'system' }));
    await expect(ctx.assemble()).rejects.toBeInstanceOf(BudgetError);
  });

  it('reserve_output reduces usable budget', async () => {
    const ctx = new Context({ budgetTokens: 100, model: 'gpt-4o', reserveOutput: 80 });
    ctx.add(new Block('a'.repeat(200), { priority: 1, role: 'user', evict: 'truncate' }));
    await ctx.assemble();
    expect(ctx.report().used).toBeLessThanOrEqual(20); // only ~20 usable
    expect(ctx.report().decisions.find((d) => d.role === 'user')!.action).toBe('truncated');
  });

  it('whatif does not commit', async () => {
    const ctx = new Context({ budgetTokens: 1000, model: 'gpt-4o' });
    ctx.add(new Block('hello there', { priority: 5, role: 'user' }));
    await ctx.assemble();
    const committedUsed = ctx.report().used;
    const preview = await ctx.whatif(3);
    expect(preview.budget).toBe(3);
    expect(ctx.report().used).toBe(committedUsed); // committed report unchanged
  });

  it('assembly is deterministic', async () => {
    const build = async () => {
      const c = new Context({ budgetTokens: 50, model: 'gpt-4o' });
      c.add(new Block('alpha', { priority: 5, role: 'user' }));
      c.add(new Block('beta', { priority: 5, role: 'assistant' }));
      c.add(new Block('gamma', { priority: 9, role: 'system' }));
      return c.assemble();
    };
    expect(await build()).toEqual(await build());
  });

  it('emits the report on the bus', async () => {
    bus._reset();
    const seen: AssemblyReport[] = [];
    bus.subscribe((e) => seen.push(e as AssemblyReport));
    const ctx = new Context({ budgetTokens: 100, model: 'gpt-4o' });
    ctx.add(new Block('hi', { role: 'user' }));
    await ctx.assemble();
    expect(seen.length).toBe(1);
    expect(seen[0]!.model).toBe('gpt-4o');
  });

  it('attention order edge-loads priority', async () => {
    const ctx = new Context({ budgetTokens: 1000, model: 'gpt-4o', order: 'attention' });
    ctx.add(new Block('SYS', { priority: 100, pin: true, role: 'system' }));
    ctx.add(new Block('p9', { priority: 9, role: 'assistant' }));
    ctx.add(new Block('p1', { priority: 1, role: 'assistant' }));
    ctx.add(new Block('p5', { priority: 5, role: 'assistant' }));
    ctx.add(new Block('p7', { priority: 7, role: 'assistant' }));
    ctx.add(new Block('USER', { priority: 10, pin: true, role: 'user' }));
    const msgs = await ctx.assemble();
    expect(msgs[0]!.content).toBe('SYS'); // system anchored first
    expect(msgs[msgs.length - 1]!.content).toBe('USER'); // user turn anchored last
    const middle = msgs.slice(1, -1).map((m) => m.content);
    // desc by priority = [p9,p7,p5,p1] -> edge-loaded -> [p9,p5,p1,p7]: strongest on the edges
    expect(middle[0]).toBe('p9');
    expect(middle[middle.length - 1]).toBe('p7');
    expect(middle[Math.floor(middle.length / 2)]).toBe('p1'); // weakest in the center
    expect(ctx.report().order).toBe('attention');
  });

  it('cache order puts the pinned prefix first', async () => {
    const ctx = new Context({ budgetTokens: 1000, model: 'gpt-4o', order: 'cache' });
    ctx.add(new Block('volatile', { priority: 8, pin: false, role: 'user' }));
    ctx.add(new Block('stable-hi', { priority: 10, pin: true, role: 'system' }));
    ctx.add(new Block('stable-lo', { priority: 2, pin: true, role: 'assistant' }));
    const msgs = await ctx.assemble();
    expect(msgs.map((m) => m.content)).toEqual(['stable-hi', 'stable-lo', 'volatile']);
  });

  it('rejects an invalid order', () => {
    expect(() => new Context({ budgetTokens: 10, model: 'gpt-4o', order: 'bogus' })).toThrow(
      ValueError,
    );
  });

  it('default order is role-grouped', async () => {
    const ctx = new Context({ budgetTokens: 1000, model: 'gpt-4o' }); // default
    ctx.add(new Block('u', { priority: 9, role: 'user' }));
    ctx.add(new Block('s', { priority: 1, role: 'system' }));
    const msgs = await ctx.assemble();
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
    expect(ctx.report().order).toBe('default');
  });

  it('for_anthropic splits system', async () => {
    const ctx = new Context({ budgetTokens: 1000, model: 'claude-opus-4-8' });
    ctx.add(new Block('you are helpful', { priority: 10, pin: true, role: 'system' }));
    ctx.add(new Block('hello', { priority: 9, pin: true, role: 'user' }));
    const [system, messages] = await ctx.forAnthropic();
    expect(system).toBe('you are helpful');
    expect(messages.every((m) => m.role !== 'system')).toBe(true);
  });

  it('charges multimodal image token cost', async () => {
    const ctx = new Context({ budgetTokens: 1000, model: 'gpt-4o', imageTokens: 85 });
    const block = new Block(
      [
        { type: 'text', text: 'look' },
        { type: 'image', image_url: '...' },
      ],
      { priority: 9, pin: true, role: 'user' },
    );
    ctx.add(block);
    await ctx.assemble();
    const d = ctx.report().decisions[0]!;
    // text("look") ~1 tok + 1 image * 85 = ~86
    expect(d.tokensBefore).toBeGreaterThanOrEqual(85);
    // multimodal content is preserved as a list in the rendered message
    const msgs = await ctx.assemble();
    expect(Array.isArray(msgs[0]!.content)).toBe(true);
  });

  it('drops a multimodal block when too large', async () => {
    const ctx = new Context({ budgetTokens: 20, model: 'gpt-4o', imageTokens: 1000 });
    ctx.add(new Block('keep', { priority: 10, role: 'system' }));
    ctx.add(new Block([{ type: 'image' }], { priority: 1, role: 'user', evict: 'drop_oldest' }));
    await ctx.assemble();
    const dropped = ctx.report().decisions.filter((d) => d.action === 'dropped');
    expect(dropped.length).toBe(1);
    expect(dropped[0]!.note).toBe('multimodal: too large');
  });

  it('awaits an async summarizer via assemble', async () => {
    const calls = { n: 0 };
    const summarizer = async () => {
      calls.n += 1;
      return 'async summary';
    };
    const ctx = new Context({ budgetTokens: 40, model: 'gpt-4o' });
    ctx.add(new Block('s', { priority: 10, role: 'system' }));
    ctx.add(
      new Block('z'.repeat(400), { priority: 1, role: 'user', evict: 'summarize', summarizer }),
    );
    const msgs = await ctx.assemble();
    expect(calls.n).toBe(1); // the async summarizer ran
    expect(msgs.map((m) => m.content)).toContain('async summary');
    expect(ctx.report().decisions.some((d) => d.action === 'summarized')).toBe(true);
  });

  // NOTE: Python's `test_sync_assemble_falls_back_for_async_summarizer` has no analog. This port
  // collapses sync+async into a single async `assemble()` that always awaits summarizers, so the
  // "async summarizer needs aassemble(); truncated" fallback path never occurs. See §14 of the
  // port-spec. We instead assert the "no summarizer" fallback below.

  it('falls back to truncate when summarize has no summarizer', async () => {
    const ctx = new Context({ budgetTokens: 40, model: 'gpt-4o' });
    ctx.add(new Block('z'.repeat(400), { priority: 1, role: 'user', evict: 'summarize' }));
    await ctx.assemble();
    const d = ctx.report().decisions[0]!;
    expect(d.action).toBe('truncated');
    expect(d.note).toContain('no summarizer');
  });

  it('for_gemini adapter maps roles and parts', async () => {
    const ctx = new Context({ budgetTokens: 1000, model: 'gpt-4o' });
    ctx.add(new Block('be helpful', { priority: 10, pin: true, role: 'system' }));
    ctx.add(new Block('prior reply', { priority: 5, role: 'assistant' }));
    ctx.add(new Block('question', { priority: 9, pin: true, role: 'user' }));
    const [system, contents] = await ctx.forGemini();
    expect(system).toBe('be helpful');
    const roles = contents.map((c) => c.role);
    expect(roles).toContain('model'); // assistant -> model
    expect(roles).toContain('user');
    expect(roles).not.toContain('system');
    const first = contents[0]!.parts;
    const isSystemParts = JSON.stringify(first) === JSON.stringify([{ text: 'be helpful' }]);
    expect(isSystemParts || Boolean((first[0] as { text?: unknown }).text)).toBe(true);
  });

  it('use_compressor sets the global default', async () => {
    const fake = () => ['CX', null] as [string, null]; // a Compressor-shaped callable
    const previous = useCompressor(fake);
    try {
      const ctx = new Context({ budgetTokens: 50, model: 'gpt-4o' });
      ctx.add(new Block('s', { priority: 10, role: 'system' }));
      ctx.add(new Block('z'.repeat(400), { priority: 1, role: 'user', evict: 'compress' }));
      const messages = await ctx.assemble();
      const d = ctx.report().decisions.find((dd) => dd.role === 'user')!;
      expect(d.action).toBe('compressed');
      expect(messages.map((m) => m.content)).toContain('CX'); // the pluggable backend ran
    } finally {
      useCompressor(previous);
    }
  });

  it('per-Context compressor overrides the default', async () => {
    useCompressor(() => ['GLOBAL', null] as [string, null]);
    try {
      const ctx = new Context({
        budgetTokens: 50,
        model: 'gpt-4o',
        compressor: () => ['LOCAL', null] as [string, null],
      });
      ctx.add(new Block('z'.repeat(400), { priority: 1, role: 'user', evict: 'compress' }));
      const messages = await ctx.assemble();
      expect(messages.map((m) => m.content)).toContain('LOCAL'); // per-Context wins
    } finally {
      useCompressor(null);
    }
  });

  it('compress eviction exposes a working handle (squeeze, skipped if absent)', async (testCtx) => {
    // Reversibility is squeeze's USP — the receipt must surface the Handle so a caller can expand().
    // Guarded like pytest.importorskip: if @cendor/squeeze is unavailable/unbuilt, skip.
    let squeezeAvailable = false;
    try {
      const specifier = '@cendor/squeeze' as string;
      const mod = (await import(specifier)) as Record<string, unknown>;
      squeezeAvailable = typeof mod.compress === 'function';
    } catch {
      squeezeAvailable = false;
    }
    if (!squeezeAvailable) {
      testCtx.skip(); // squeeze dist absent — nothing to exercise
      return;
    }
    useCompressor(null); // use the auto-discovered squeeze.compress default path
    const original =
      'The quarterly report covers revenue, churn, retention, and the 2026 roadmap. '.repeat(20);
    const ctx = new Context({ budgetTokens: 60, model: 'gpt-4o' });
    ctx.add(new Block('be helpful', { priority: 10, role: 'system' }));
    ctx.add(new Block(original, { priority: 1, role: 'user', evict: 'compress' }));
    await ctx.assemble();
    const d = ctx.report().decisions.find((dd) => dd.role === 'user')!;
    expect(d.action).toBe('compressed');
    expect(d.handle).not.toBeNull();
    expect(d.handle!.expand()).toBe(original); // reverses to the exact original
  });

  it('default compress path forwards the Context model', async () => {
    const seen: { model?: string } = {};
    const spy = (_text: string, opts: { model?: string }) => {
      seen.model = opts.model;
      return ['SMALL', null] as [string, null];
    };
    const previous = useCompressor(spy);
    try {
      const ctx = new Context({ budgetTokens: 50, model: 'claude-opus-4-8' });
      ctx.add(new Block('z'.repeat(400), { priority: 1, role: 'user', evict: 'compress' }));
      await ctx.assemble();
      expect(seen.model).toBe('claude-opus-4-8');
    } finally {
      useCompressor(previous);
    }
  });

  it('a legacy compressor without model still works', async () => {
    const previous = useCompressor(() => ['SMALL', null] as [string, null]);
    try {
      const ctx = new Context({ budgetTokens: 50, model: 'claude-opus-4-8' });
      ctx.add(new Block('z'.repeat(400), { priority: 1, role: 'user', evict: 'compress' }));
      const messages = await ctx.assemble();
      expect(messages.map((m) => m.content)).toContain('SMALL');
    } finally {
      useCompressor(previous);
    }
  });

  it('for_anthropic coerces nonstandard roles', async () => {
    const ctx = new Context({ budgetTokens: 1000, model: 'gpt-4o' });
    ctx.add(new Block('be helpful', { priority: 10, pin: true, role: 'system' }));
    ctx.add(new Block('assistant turn', { priority: 9, pin: true, role: 'assistant' }));
    ctx.add(new Block('tool output here', { priority: 8, pin: true, role: 'tool' }));
    const [system, messages] = await ctx.forAnthropic();
    expect(system).toBeTruthy(); // system split out of messages
    expect(messages.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true);
    expect(messages.some((m) => m.role === 'system')).toBe(false);
    // the tool block landed as a user message (its content preserved)
    expect(
      messages.some((m) => m.role === 'user' && String(m.content).includes('tool output here')),
    ).toBe(true);
  });

  it('for_bedrock adapter', async () => {
    const ctx = new Context({ budgetTokens: 1000, model: 'gpt-4o' });
    ctx.add(new Block('be helpful', { priority: 10, pin: true, role: 'system' }));
    ctx.add(new Block('question', { priority: 9, pin: true, role: 'user' }));
    const [system, messages] = await ctx.forBedrock();
    expect(system).toEqual([{ text: 'be helpful' }]);
    expect(messages).toEqual([{ role: 'user', content: [{ text: 'question' }] }]);
    expect(messages.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true);
  });

  // ------------------------------------------------------------------- budget accuracy

  it('used matches the message-level recount', async () => {
    const ctx = new Context({ budgetTokens: 200, model: 'gpt-4o' });
    for (let i = 0; i < 5; i++) {
      ctx.add(new Block(`block number ${i} with some text`, { priority: 5, role: 'user' }));
    }
    const msgs = await ctx.assemble();
    expect(tokens.count(msgs, 'gpt-4o')).toBe(ctx.report().used);
  });

  it('assembly stays within budget when remeasured', async () => {
    const ctx = new Context({ budgetTokens: 40, model: 'gpt-4o', reserveOutput: 0 });
    for (let i = 0; i < 6; i++) {
      ctx.add(new Block(`chunk ${i} of context`, { priority: 5, role: 'user', evict: 'truncate' }));
    }
    const msgs = await ctx.assemble();
    expect(tokens.count(msgs, 'gpt-4o')).toBeLessThanOrEqual(40);
  });

  // ------------------------------------------------------------------- message-list blocks

  it('history block peels the oldest turns', async () => {
    const turns = [
      { role: 'user', content: 'oldest '.repeat(10) },
      { role: 'assistant', content: 'middle '.repeat(10) },
      { role: 'user', content: 'newest '.repeat(10) },
    ];
    const ctx = new Context({ budgetTokens: 40, model: 'gpt-4o' });
    ctx.add(new Block({ messages: turns, priority: 5, evict: 'drop_oldest' }));
    const msgs = await ctx.assemble();
    const contents = msgs.map((m) => m.content).join(' ');
    expect(contents).toContain('newest'); // most recent kept
    expect(contents).not.toContain('oldest'); // oldest peeled
    const d = ctx.report().decisions[0]!;
    expect(d.action).toBe('truncated');
    expect(d.note).toContain('kept');
    expect(d.note).toContain('of 3 turns');
  });

  it('history block kept whole when it fits', async () => {
    const turns = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const ctx = new Context({ budgetTokens: 1000, model: 'gpt-4o' });
    ctx.add(new Block({ messages: turns, priority: 5 }));
    const msgs = await ctx.assemble();
    expect(msgs.map((m) => m.content)).toEqual(['hi', 'hello']); // chronological
    expect(ctx.report().decisions[0]!.action).toBe('kept');
  });

  it('empty history block reports kept, not "dropped all 0 turns" (L5)', async () => {
    const ctx = new Context({ budgetTokens: 1000, model: 'gpt-4o' });
    ctx.add(new Block({ messages: [], priority: 5 }));
    await ctx.assemble();
    const hist = ctx.report().decisions.filter((d) => d.role === 'history');
    for (const d of hist) {
      expect(d.action).toBe('kept');
      expect(d.note).not.toContain('dropped all 0');
    }
  });

  it('history block orders in the middle', async () => {
    const ctx = new Context({ budgetTokens: 1000, model: 'gpt-4o' });
    ctx.add(new Block('the question', { priority: 9, pin: true, role: 'user' }));
    ctx.add(new Block('you are helpful', { priority: 10, pin: true, role: 'system' }));
    ctx.add(new Block({ messages: [{ role: 'user', content: 'earlier turn' }], priority: 5 }));
    const roles = (await ctx.assemble()).map((m) => m.role);
    expect(roles[0]).toBe('system');
    expect(roles[roles.length - 1]).toBe('user');
  });

  it('history truncate trims the newest turn when alone too big', async () => {
    const turns = [{ role: 'user', content: 'z'.repeat(800) }];
    const ctx = new Context({ budgetTokens: 40, model: 'gpt-4o' });
    ctx.add(new Block({ messages: turns, priority: 5, evict: 'truncate' }));
    await ctx.assemble();
    expect(ctx.report().used).toBeLessThanOrEqual(40);
    const d = ctx.report().decisions[0]!;
    expect(d.tokensAfter).toBeLessThan(d.tokensBefore);
  });

  it('raises on pinned history overflow', async () => {
    const turns = [{ role: 'user', content: 'w'.repeat(800) }];
    const ctx = new Context({ budgetTokens: 20, model: 'gpt-4o' });
    ctx.add(new Block({ messages: turns, priority: 10, pin: true }));
    await expect(ctx.assemble()).rejects.toBeInstanceOf(BudgetError);
  });

  it('Block requires exactly one of content or messages', () => {
    expect(() => new Block()).toThrow(ValueError); // neither
    expect(() => new Block('text', { messages: [{ role: 'user', content: 'x' }] })).toThrow(
      ValueError,
    ); // both
    expect(() => new Block({ messages: [{ oops: 'no role/content' }] })).toThrow(ValueError); // malformed
  });

  // ------------------------------------------------------------------- truncate options

  it('truncate keep=tail keeps the end', async () => {
    const ctx = new Context({ budgetTokens: 60, model: 'gpt-4o' });
    const text = `HEAD ${'x '.repeat(200)}TAIL`;
    ctx.add(new Block(text, { priority: 1, role: 'user', evict: 'truncate', keep: 'tail' }));
    const kept = (await ctx.assemble())[0]!.content as string;
    expect(kept).toContain('TAIL');
    expect(kept).not.toContain('HEAD');
  });

  it('truncate keep=head keeps the start', async () => {
    const ctx = new Context({ budgetTokens: 60, model: 'gpt-4o' });
    ctx.add(
      new Block(`HEAD ${'x '.repeat(200)}TAIL`, { priority: 1, role: 'user', evict: 'truncate' }),
    );
    const kept = (await ctx.assemble())[0]!.content as string;
    expect(kept).toContain('HEAD');
    expect(kept).not.toContain('TAIL');
  });

  it('truncate leaves a marker', async () => {
    const ctx = new Context({ budgetTokens: 80, model: 'gpt-4o' });
    ctx.add(new Block('y'.repeat(800), { priority: 1, role: 'user', evict: 'truncate' }));
    const kept = (await ctx.assemble())[0]!.content as string;
    expect(kept).toContain('[truncated]');
  });

  // ------------------------------------------------------------------- pluggable eviction strategy

  it('custom eviction strategy object', async () => {
    class KeepFirstWord implements EvictionStrategy {
      evict(content: string): [string | null, string] {
        return [content.split(/\s+/)[0] ?? '', 'evicted'];
      }
    }
    const ctx = new Context({ budgetTokens: 40, model: 'gpt-4o' });
    ctx.add(
      new Block('supercalifragilistic '.repeat(50), {
        priority: 1,
        role: 'user',
        evict: new KeepFirstWord(),
      }),
    );
    const msgs = await ctx.assemble();
    expect(msgs[0]!.content).toBe('supercalifragilistic');
    expect(ctx.report().decisions[0]!.action).toBe('evicted');
  });

  it('swallows a custom strategy exception (drops, never breaks)', async () => {
    class Boom implements EvictionStrategy {
      evict(): [string | null, string] {
        throw new Error('kaboom');
      }
    }
    const ctx = new Context({ budgetTokens: 40, model: 'gpt-4o' });
    ctx.add(new Block('z'.repeat(400), { priority: 1, role: 'user', evict: new Boom() }));
    await ctx.assemble();
    const d = ctx.report().decisions[0]!;
    expect(d.action).toBe('dropped');
    expect(d.note).toContain('custom strategy raised');
  });

  // ------------------------------------------------------------------- multimodal adapters

  it('for_gemini multimodal parts are well-formed', async () => {
    const ctx = new Context({ budgetTokens: 1000, model: 'gemini-1.5-pro', imageTokens: 85 });
    ctx.add(
      new Block(
        [
          { type: 'text', text: 'look' },
          { type: 'image', image_url: 'x' },
        ],
        { priority: 9, pin: true, role: 'user' },
      ),
    );
    const [, contents] = await ctx.forGemini();
    const parts = contents[0]!.parts;
    const has = (target: unknown) =>
      parts.some((p) => JSON.stringify(p) === JSON.stringify(target));
    expect(has({ text: 'look' })).toBe(true); // text part -> {text: ...}
    expect(has({ type: 'image', image_url: 'x' })).toBe(true); // image part passes through
  });

  it('for_anthropic system multimodal does not crash', async () => {
    const ctx = new Context({ budgetTokens: 1000, model: 'claude-opus-4-8' });
    ctx.add(
      new Block([{ type: 'text', text: 'sys' }], { priority: 10, pin: true, role: 'system' }),
    );
    const [system] = await ctx.forAnthropic();
    expect(system).toBe('sys');
  });

  it('image_tokens callable', async () => {
    const ctx = new Context({ budgetTokens: 1000, model: 'gpt-4o', imageTokens: () => 130 });
    ctx.add(
      new Block([{ type: 'image', image_url: 'x' }], { priority: 9, pin: true, role: 'user' }),
    );
    await ctx.assemble();
    expect(ctx.report().decisions[0]!.tokensBefore).toBe(130);
  });

  // ------------------------------------------------------------------- report() surface

  it('report() throws before assemble()', () => {
    const ctx = new Context({ budgetTokens: 10, model: 'gpt-4o' });
    expect(() => ctx.report()).toThrow('call assemble() before report()');
  });

  it('AssemblyReport toString is a human-readable receipt', async () => {
    const ctx = new Context({ budgetTokens: 1000, model: 'gpt-4o' });
    ctx.add(new Block('hi', { role: 'user' }));
    await ctx.assemble();
    const s = ctx.report().toString();
    expect(s).toContain('AssemblyReport(model=gpt-4o, order=default)');
    expect(s).toContain('[kept');
  });

  it('constructs BlockDecision with defaults', () => {
    const d = new BlockDecision('user', 'kept', 3, 3);
    expect(d.note).toBe('');
    expect(d.handle).toBeNull();
  });
});
