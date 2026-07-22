/**
 * GLR-5 (Bug A) red→green: a streamed call whose stream is drained **after** the `budget`/`track`
 * scope has exited must still accrue spend, enforce the budget, and attribute by tag. Before the fix
 * tokenguard read `currentFrames()`/`currentTags()` at delivery time — empty for an out-of-scope
 * drain — so spend was silently lost (and cumulative caps under `block` could be overrun). The fix
 * captures the frames (by reference) + tags at call initiation via the core ambient seam.
 *
 * The cross-call cumulative-`block` bypass (§3b-2) needs a real detached stream consumer between two
 * in-scope pre-flights (the SDK's stream runner), so it is verified live in cendor-testsuits, not
 * here — a tokenguard-only test cannot exit the module-private ALS between two pre-flights.
 */
import { instrument } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as tokenguard from '../src/index.js';
import { BudgetExceeded, report, track, withBudget } from '../src/index.js';

/** A fake OpenAI-shaped client whose streamed call finalizes with a $0.0075 usage chunk. */
function streamingClient() {
  const chunks = [
    { choices: [{ delta: { content: 'hi' } }], usage: null },
    { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500 } }, // ~$0.0075 on gpt-4o
  ];
  return instrument({
    chat: { completions: { create: async () => chunks } },
  }) as unknown as {
    chat: { completions: { create: (p: unknown) => Promise<AsyncIterable<unknown>> } };
  };
}

describe('GLR-5 — streamed spend drained out of the budget scope', () => {
  beforeEach(() => tokenguard.reset());
  afterEach(() => tokenguard.reset());

  it('accrues + attributes when the stream is drained after the scope exits', async () => {
    const client = streamingClient();
    let stream: AsyncIterable<unknown> | undefined;
    let handle: tokenguard.BudgetHandle | undefined;
    await withBudget({ usd: 1.0 }, async (b) => {
      handle = b;
      await track({ user: 'u1' }, async () => {
        stream = await client.chat.completions.create({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        });
      });
      // NOT drained inside the scope — the SDK stream runner would drain it on a detached task.
    });
    // Scope has exited: budgetsStore + tagsStore are empty now.
    for await (const _chunk of stream as AsyncIterable<unknown>) {
      // drain
    }
    // Accrued to the frame the handle wraps (RED before the fix: $0):
    expect(Number(handle?.spent.amount.toString())).toBeGreaterThan(0);
    // Attributed to the tag active at initiation (RED before the fix: user=null):
    const rows = report(['user']);
    const u1 = rows.rows.find((r) => r.tags.user === 'u1');
    expect(u1).toBeDefined();
    expect(Number(u1?.usd.amount.toString())).toBeGreaterThan(0);
  });

  it('enforces (raise) on the out-of-scope drain instead of silently overrunning', async () => {
    const client = streamingClient();
    let stream: AsyncIterable<unknown> | undefined;
    await withBudget({ usd: 0.001, onExceed: 'raise' }, async () => {
      stream = await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      // not drained here
    });
    let caught: unknown;
    try {
      for await (const _chunk of stream as AsyncIterable<unknown>) {
        // drain out of scope
      }
    } catch (err) {
      caught = err;
    }
    // RED before the fix: caught === undefined (frames empty at drain → no enforcement).
    expect(caught).toBeInstanceOf(BudgetExceeded);
  });
});
