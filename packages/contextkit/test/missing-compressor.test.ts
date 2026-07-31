/**
 * `onMissingCompressor` — how loud a silently-truncated `compress` block is (Q5).
 *
 * A block declaring `evict: 'compress'` with no compressor available is **truncated** instead. That
 * is a different operation: truncation discards content and is not reversible, while a squeeze
 * compression hands back a `Handle` you can `.expand()`. The substitution has always been recorded as
 * a note on the block's `BlockDecision` — but a note lives inside the `AssemblyReport` and nothing
 * obliges a caller to read one, so a forgotten `@cendor/squeeze` quietly degraded every compress
 * block in production while the assembly still reported success.
 *
 * The knob is additive and **the default is unchanged** (`'note'`), which the first test pins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Block, Context, MissingCompressorError, useCompressor } from '../src/index.js';

const LONG = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet '.repeat(40);

let previous: unknown;
beforeEach(() => {
  // @cendor/squeeze IS resolvable in this workspace, so the auto-discovery would find it and none of
  // these paths would be reachable. A compressor that is explicitly `false`-y is not enough — the
  // discovery has to be defeated, so each Context below passes an explicit compressor when it wants
  // one and the discovery is stubbed out per test where it must be absent.
  previous = useCompressor(null);
});
afterEach(() => {
  useCompressor(previous);
  vi.restoreAllMocks();
});

/** A Context whose compressor lookup is forced to find nothing. */
function noCompressorCtx(onMissingCompressor?: 'note' | 'warn' | 'error'): Context {
  const ctx = new Context({
    budgetTokens: 120,
    model: 'gpt-4o',
    ...(onMissingCompressor ? { onMissingCompressor } : {}),
  });
  // Defeat the runtime `import('@cendor/squeeze')` discovery.
  (ctx as unknown as { getCompressor(): Promise<unknown> }).getCompressor = async () => null;
  ctx.add(new Block({ content: 'keep me', priority: 10, pin: true, role: 'system' }));
  ctx.add(new Block({ content: LONG, priority: 1, evict: 'compress', role: 'user' }));
  return ctx;
}

function userDecision(ctx: Context) {
  return ctx.report().decisions.filter((d) => d.role === 'user')[0];
}

describe('onMissingCompressor', () => {
  it('defaults to note: truncates, records the note, does not warn or throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = noCompressorCtx();
    const messages = await ctx.assemble();
    expect(messages.length).toBeGreaterThan(0);
    const d = userDecision(ctx);
    expect(d.action).toBe('truncated');
    expect(d.note).toContain('squeeze not installed');
    expect(d.handle).toBeNull(); // truncation is not reversible
    expect(warn).not.toHaveBeenCalled();
  });

  it('warn mode logs and still assembles', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = noCompressorCtx('warn');
    const messages = await ctx.assemble();
    expect(messages.length).toBeGreaterThan(0); // warn is not a refusal
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('TRUNCATED');
    expect(userDecision(ctx).action).toBe('truncated');
  });

  it('error mode refuses instead of truncating', async () => {
    const ctx = noCompressorCtx('error');
    await expect(ctx.assemble()).rejects.toThrow(MissingCompressorError);
  });

  it('the error names every way out', async () => {
    const ctx = noCompressorCtx('error');
    const err = await ctx.assemble().catch((e: Error) => e);
    const text = String((err as Error).message);
    for (const remedy of [
      '@cendor/squeeze',
      'compressor',
      'useCompressor',
      'onMissingCompressor',
    ]) {
      expect(text).toContain(remedy);
    }
  });

  it('rejects an invalid mode at construction', () => {
    expect(
      () =>
        new Context({
          budgetTokens: 100,
          model: 'gpt-4o',
          onMissingCompressor: 'shout' as 'note',
        }),
    ).toThrow(/onMissingCompressor/);
  });
});

describe('negative controls', () => {
  it('says nothing in any mode when a compressor IS present', async () => {
    // The knob must only ever speak when the compressor is genuinely missing — not even in `error`.
    const compressor = (text: string, opts: { targetTokens?: number }) => [
      text.slice(0, Math.max(1, opts?.targetTokens ?? 1)),
      { expand: () => text },
    ];
    for (const mode of ['note', 'warn', 'error'] as const) {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ctx = new Context({
        budgetTokens: 120,
        model: 'gpt-4o',
        compressor,
        onMissingCompressor: mode,
      });
      ctx.add(new Block({ content: 'keep me', priority: 10, pin: true, role: 'system' }));
      ctx.add(new Block({ content: LONG, priority: 1, evict: 'compress', role: 'user' }));
      await ctx.assemble(); // must not throw
      expect(warn).not.toHaveBeenCalled();
      expect(userDecision(ctx).action).toBe('compressed');
      warn.mockRestore();
    }
  });

  it('leaves a block that ASKED for truncation alone', async () => {
    for (const mode of ['note', 'warn', 'error'] as const) {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ctx = new Context({ budgetTokens: 120, model: 'gpt-4o', onMissingCompressor: mode });
      ctx.add(new Block({ content: 'keep me', priority: 10, pin: true, role: 'system' }));
      ctx.add(new Block({ content: LONG, priority: 1, evict: 'truncate', role: 'user' }));
      await ctx.assemble();
      expect(warn).not.toHaveBeenCalled();
      expect(userDecision(ctx).action).toBe('truncated');
      warn.mockRestore();
    }
  });

  it('never reaches the eviction path when the block fits', async () => {
    const ctx = new Context({ budgetTokens: 4000, model: 'gpt-4o', onMissingCompressor: 'error' });
    ctx.add(new Block({ content: 'short', priority: 1, evict: 'compress', role: 'user' }));
    await ctx.assemble(); // `error` must not refuse an assembly that never needed to evict
    expect(userDecision(ctx).action).toBe('kept');
  });
});
