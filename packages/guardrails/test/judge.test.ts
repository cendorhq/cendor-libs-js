/**
 * LLM-judge helpers: verdict prompt template, strict-JSON parsing, and the judge() composer. No
 * network — `respond` is a fake that returns a canned string. Mirrors the guardrails Python
 * `tests/test_judge.py`.
 */
import { bus } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GuardrailTripped, Verdict } from '../src/decision.js';
import { applyAsync, judge, rules } from '../src/index.js';

beforeEach(() => bus._reset());
afterEach(() => bus._reset());

describe('judge helpers', () => {
  it('verdictPrompt embeds the policy and the JSON contract', () => {
    const p = judge.verdictPrompt('Trip on secrets.');
    expect(p).toContain('Trip on secrets.');
    expect(p).toContain('"trip"');
    expect(p).toContain('"reason"'); // pins the model to the strict verdict shape
  });

  it('parseVerdict trips on a true verdict', () => {
    const v = judge.parseVerdict('{"trip": true, "reason": "leaked a key"}');
    expect(v).toBeInstanceOf(Verdict);
    expect(v?.action).toBe('block');
    expect(v?.reason).toBe('leaked a key');
  });

  it('parseVerdict passes on a false verdict', () => {
    expect(judge.parseVerdict('{"trip": false, "reason": "clean"}')).toBeNull();
  });

  it('parseVerdict tolerates a ```json fence', () => {
    const v = judge.parseVerdict('```json\n{"trip": true, "reason": "x"}\n```');
    expect(v).not.toBeNull();
    expect(v?.action).toBe('block');
  });

  it('parseVerdict honours a custom action', () => {
    const v = judge.parseVerdict('{"trip": true, "reason": "iffy"}', { action: 'flag' });
    expect(v?.action).toBe('flag');
  });

  it('parseVerdict throws on malformed output', () => {
    expect(() => judge.parseVerdict('I think this is fine, no JSON here')).toThrow();
    expect(() => judge.parseVerdict('{"reason": "missing trip"}')).toThrow();
  });

  it('judge composes and trips (sync respond)', async () => {
    const respond = (_system: string, _user: string) =>
      '{"trip": true, "reason": "blocked by judge"}';
    const check = judge.judge(respond, 'Trip on anything.');
    const g = rules.llmJudge(check);
    let err: unknown;
    try {
      await applyAsync([g], 'output', 'some model text');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GuardrailTripped);
    expect((err as GuardrailTripped).decisions.at(-1)?.reason).toBe('blocked by judge');
  });

  it('judge passes on a false reply', async () => {
    const check = judge.judge(() => '{"trip": false, "reason": "ok"}', 'policy');
    expect(await applyAsync([rules.llmJudge(check)], 'output', 'text')).toEqual([]);
  });

  it('judge works with an async respond', async () => {
    const respond = async (_s: string, _u: string) => '{"trip": true, "reason": "async trip"}';
    const check = judge.judge(respond, 'policy');
    await expect(applyAsync([rules.llmJudge(check)], 'output', 'text')).rejects.toBeInstanceOf(
      GuardrailTripped,
    );
  });

  it('a malformed judge reply fails closed (throw → on_error block)', async () => {
    // the check throws ValueError-like inside → on_error fail_closed (block action) → GuardrailTripped
    const check = judge.judge(() => 'not json', 'policy');
    await expect(applyAsync([rules.llmJudge(check)], 'output', 'text')).rejects.toBeInstanceOf(
      GuardrailTripped,
    );
  });
});
