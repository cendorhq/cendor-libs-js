/**
 * Similarity checks over a bring-your-own embedding fn: groundedness + deniedTopics. A fake `embed`
 * (no model, no network) exercises the cosine math + thresholds. The TS port of test_semantic.py.
 */
import { bus } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GuardrailTripped } from '../src/decision.js';
import { apply, rules } from '../src/index.js';

beforeEach(() => bus._reset());
afterEach(() => bus._reset());

const VECS: Record<string, number[]> = {
  cats: [1, 0, 0],
  'cats are great pets': [0.99, 0.1, 0],
  dogs: [0, 1, 0],
  'quantum chromodynamics': [0, 0, 1],
  'medical diagnosis': [0, 1, 0],
  'how do I treat a fever': [0.05, 0.99, 0],
};
const embed = (t: string): number[] => VECS[t.trim()] ?? [0, 0, 0];

describe('groundedness', () => {
  it('flags an ungrounded answer', () => {
    const g = rules.groundedness(embed, ['cats'], { threshold: 0.75, action: 'flag' });
    const out = apply([g], 'output', 'quantum chromodynamics'); // orthogonal → sim 0
    expect(out.at(-1)?.action).toBe('flag');
    expect(out.at(-1)?.reason).toContain('ungrounded');
  });

  it('passes when grounded', () => {
    const g = rules.groundedness(embed, ['cats'], { threshold: 0.75 });
    expect(apply([g], 'output', 'cats are great pets')).toEqual([]); // sim ~0.99
  });

  it('empty sources never trip', () => {
    expect(apply([rules.groundedness(embed, [])], 'output', 'anything')).toEqual([]);
  });

  it('can block', () => {
    const g = rules.groundedness(embed, ['cats'], { threshold: 0.9, action: 'block' });
    expect(() => apply([g], 'output', 'dogs')).toThrow(GuardrailTripped);
  });

  it('embeds sources lazily (nothing at construction)', () => {
    const calls: string[] = [];
    const counting = (t: string) => {
      calls.push(t);
      return embed(t);
    };
    const g = rules.groundedness(counting, ['cats']);
    expect(calls).toEqual([]);
    apply([g], 'output', 'dogs');
    expect(calls).toContain('cats');
  });
});

describe('deniedTopics', () => {
  it('blocks a close match and names the topic', () => {
    const g = rules.deniedTopics(embed, ['medical diagnosis'], { threshold: 0.8, action: 'block' });
    let err: unknown;
    try {
      apply([g], 'input', 'how do I treat a fever'); // sim ~0.99 to "medical diagnosis"
    } catch (e) {
      err = e;
    }
    expect((err as GuardrailTripped).decisions.at(-1)?.reason).toContain('medical diagnosis');
  });

  it('passes when far', () => {
    const g = rules.deniedTopics(embed, ['medical diagnosis'], { threshold: 0.8 });
    expect(apply([g], 'input', 'cats')).toEqual([]); // orthogonal
  });
});
