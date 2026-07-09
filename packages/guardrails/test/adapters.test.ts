/**
 * Opt-in detection-tier adapters (Wave 2): classifier / language / openaiModeration. No network, no
 * ML deps — a fake classify/detect fn and a fake moderation client. Mirrors the guardrails Python
 * `tests/test_adapters.py` (minus `prompt_guard`, which is Python-only — it needs `transformers`; a
 * TS user wires an ONNX/transformers.js model through `rules.classifier`). docs/guardrails.md
 * "Threat model".
 */
import { bus } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GuardrailTripped } from '../src/decision.js';
import { adapters, apply, applyAsync, rules } from '../src/index.js';

beforeEach(() => bus._reset());
afterEach(() => bus._reset());

// --------------------------------------------------------------------------- classifier

describe('classifier', () => {
  it('a float score trips over the threshold', () => {
    const g = rules.classifier(() => 0.8, { threshold: 0.5, action: 'block' });
    let err: unknown;
    try {
      apply([g], 'input', 'text');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GuardrailTripped);
    expect((err as GuardrailTripped).decisions.at(-1)?.reason).toContain('0.80 >= 0.5');
  });

  it('below the threshold passes', () => {
    expect(apply([rules.classifier(() => 0.3, { threshold: 0.5 })], 'input', 'text')).toEqual([]);
  });

  it('a bool trips as flag; a mapping trips on the selected label', () => {
    const out = apply([rules.classifier(() => true, { action: 'flag' })], 'input', 'x');
    expect(out.at(-1)?.action).toBe('flag');
    const g = rules.classifier(() => ({ injection: 0.9, benign: 0.1 }), {
      label: 'injection',
      threshold: 0.5,
    });
    expect(() => apply([g], 'input', 'x')).toThrow(GuardrailTripped);
  });

  it('a mapping without a label uses the max score', () => {
    const g = rules.classifier(() => ({ a: 0.2, b: 0.7 }), { threshold: 0.5, action: 'flag' });
    expect(apply([g], 'input', 'x').at(-1)?.action).toBe('flag');
    expect(
      apply([rules.classifier(() => ({ a: 0.2, b: 0.3 }), { threshold: 0.5 })], 'input', 'x'),
    ).toEqual([]);
  });

  it('is re-exported on both surfaces (same reference)', () => {
    expect(adapters.classifier).toBe(rules.classifier);
    expect(rules.language).toBe(adapters.language);
    expect(adapters.openaiModeration).toBe(rules.openaiModeration);
  });
});

// --------------------------------------------------------------------------- language

describe('language', () => {
  it('trips on a disallowed language (BYO detect)', () => {
    const g = rules.language(['en'], { detect: () => 'fr', action: 'block' });
    let err: unknown;
    try {
      apply([g], 'input', 'bonjour le monde');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GuardrailTripped);
    expect((err as GuardrailTripped).decisions.at(-1)?.reason).toContain("'fr'");
  });

  it('allows an expected language', () => {
    expect(apply([rules.language(['en', 'fr'], { detect: () => 'en' })], 'input', 'hello')).toEqual(
      [],
    );
  });

  it('an empty/whitespace payload passes', () => {
    expect(apply([rules.language(['en'], { detect: () => 'zz' })], 'input', '   ')).toEqual([]);
  });

  it('a missing detector fails closed (blocks) by default', () => {
    expect(() => apply([rules.language(['en'])], 'input', 'some text')).toThrow(GuardrailTripped);
  });

  it('a missing detector with fail_open flags instead of blocking', () => {
    const out = apply([rules.language(['en'], { onError: 'fail_open' })], 'input', 'some text');
    expect(out.at(-1)?.action).toBe('flag');
    expect(out.at(-1)?.reason).toContain('detector');
  });
});

// --------------------------------------------------------------------------- openaiModeration

function modClient(flagged: boolean, categories: Record<string, boolean>): unknown {
  return {
    moderations: {
      create: (_args: unknown) => ({ results: [{ flagged, categories }] }),
    },
  };
}

describe('openaiModeration', () => {
  it('blocks when the endpoint flags the payload', async () => {
    const client = modClient(true, { violence: true, hate: false });
    let err: unknown;
    try {
      await applyAsync([rules.openaiModeration(client, { action: 'block' })], 'input', 'bad');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GuardrailTripped);
    expect((err as GuardrailTripped).decisions.at(-1)?.reason).toContain('violence');
  });

  it('passes when clean', async () => {
    const client = modClient(false, { violence: false });
    expect(await applyAsync([rules.openaiModeration(client)], 'input', 'hello')).toEqual([]);
  });

  it('a category filter trips only on requested categories', async () => {
    // flagged overall, but not in the categories we care about → pass
    const client = modClient(true, { 'self-harm': true, violence: false });
    const g = rules.openaiModeration(client, { categories: ['violence'], action: 'block' });
    expect(await applyAsync([g], 'input', 'text')).toEqual([]);
    // now the requested category is the one flagged → trip
    const client2 = modClient(true, { violence: true });
    await expect(
      applyAsync([rules.openaiModeration(client2, { categories: ['violence'] })], 'input', 'text'),
    ).rejects.toBeInstanceOf(GuardrailTripped);
  });
});
