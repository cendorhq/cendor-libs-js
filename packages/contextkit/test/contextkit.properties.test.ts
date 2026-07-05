/**
 * Property tests (fast-check): assembly never exceeds the budget, the receipt's `used` equals the
 * provider-level message recount, and assembly is deterministic — for any blocks. Mirrors the
 * Python Hypothesis suite `test_contextkit_properties.py`.
 *
 * The invariants hold for any tokenizer, so these do not pin a particular token heuristic — they
 * run against the real js-tiktoken counter that `@cendor/core` bundles.
 */
import { tokens } from '@cendor/core';
import fc from 'fast-check';
import { describe, it } from 'vitest';
import { Block, Context, type EvictStrategy } from '../src/index.js';

interface Spec {
  content: string;
  priority: number;
  evict: EvictStrategy;
}

// Non-pinned blocks with shrink/drop strategies -> assembly never raises and never overflows.
const specArb: fc.Arbitrary<Spec> = fc.record({
  content: fc.string({ maxLength: 300 }),
  priority: fc.integer({ min: 0, max: 10 }),
  evict: fc.constantFrom<EvictStrategy>('drop_oldest', 'truncate'),
});
const specsArb = fc.array(specArb, { maxLength: 8 });

function makeContext(specs: Spec[], budget: number, reserve: number): Context {
  const ctx = new Context({ budgetTokens: budget, model: 'gpt-4o', reserveOutput: reserve });
  for (const s of specs) {
    ctx.add(new Block(s.content, { priority: s.priority, role: 'user', evict: s.evict }));
  }
  return ctx;
}

describe('contextkit properties', () => {
  it('assembled tokens never exceed the budget', async () => {
    await fc.assert(
      fc.asyncProperty(
        specsArb,
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 0, max: 100 }),
        async (specs, budget, reserve) => {
          const ctx = makeContext(specs, budget, reserve);
          await ctx.assemble();
          return ctx.report().used <= Math.max(0, budget - reserve);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('used matches the message-level recount', async () => {
    await fc.assert(
      fc.asyncProperty(
        specsArb,
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 0, max: 100 }),
        async (specs, budget, reserve) => {
          const ctx = makeContext(specs, budget, reserve);
          const msgs = await ctx.assemble();
          // The empty assembly is a degenerate edge (core counts a bare 3-token priming for []).
          if (msgs.length === 0) return true;
          return tokens.count(msgs, 'gpt-4o') === ctx.report().used;
        },
      ),
      { numRuns: 400 },
    );
  });

  it('assembly is deterministic', async () => {
    await fc.assert(
      fc.asyncProperty(specsArb, fc.integer({ min: 1, max: 500 }), async (specs, budget) => {
        const build = async () => {
          const c = new Context({ budgetTokens: budget, model: 'gpt-4o' });
          for (const s of specs) {
            c.add(new Block(s.content, { priority: s.priority, role: 'user', evict: s.evict }));
          }
          return c.assemble();
        };
        const a = await build();
        const b = await build();
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 300 },
    );
  });
});
