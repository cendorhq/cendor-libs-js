/**
 * LLM-judge helpers: verdict prompt template, strict-JSON parsing, and the judge() composer. No
 * network — `respond` is a fake that returns a canned string. Mirrors the guardrails Python
 * `tests/test_judge.py`.
 */
import { bus } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Context, GuardrailTripped, Verdict } from '../src/decision.js';
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

// --------------------------------------------------------------------------- A3: taskAdherence

const tcCtx = (
  instruction = 'Book a flight to Paris.',
  tool = 'search_flights',
  toolArgs: unknown = { to: 'Paris' },
): Context => ({ stage: 'tool_call', tool, toolArgs, instruction });

const MISALIGNED = '{"trip": true, "reason": "deletes files, unrelated to booking"}';

describe('taskAdherence (A3)', () => {
  it('flags a misaligned tool call', async () => {
    const check = judge.taskAdherence(() => MISALIGNED); // action defaults to flag
    const g = rules.llmJudge(check, { stage: 'tool_call', action: 'flag' }); // → onError fail_open
    const decs = await applyAsync(
      [g],
      'tool_call',
      { path: '/' },
      tcCtx('Book a flight to Paris.', 'delete_all', { path: '/' }),
    );
    expect(decs).toHaveLength(1);
    expect(decs[0].action).toBe('flag');
    expect(decs[0].reason).toContain('unrelated');
  });

  it('passes an aligned tool call', async () => {
    const check = judge.taskAdherence(() => '{"trip": false, "reason": "aligned"}');
    const g = rules.llmJudge(check, { stage: 'tool_call', action: 'flag' });
    expect(await applyAsync([g], 'tool_call', { to: 'Paris' }, tcCtx())).toEqual([]);
  });

  it('the prompt carries the instruction and the proposed call', async () => {
    let seenSystem = '';
    let seenUser = '';
    const respond = (system: string, user: string) => {
      seenSystem = system;
      seenUser = user;
      return '{"trip": false, "reason": "ok"}';
    };
    const g = rules.llmJudge(judge.taskAdherence(respond), { stage: 'tool_call', action: 'flag' });
    await applyAsync([g], 'tool_call', {}, tcCtx());
    expect(seenSystem).toContain('Book a flight to Paris.');
    expect(seenUser).toContain('search_flights');
    expect(seenUser).toContain('Paris');
  });

  it('defaults to the flag action', async () => {
    const check = judge.taskAdherence(() => '{"trip": true, "reason": "x"}');
    const v = await check({}, tcCtx());
    expect(v).toBeInstanceOf(Verdict);
    expect(v?.action).toBe('flag');
  });

  it('blocks when action is block', async () => {
    const check = judge.taskAdherence(() => MISALIGNED, { action: 'block' });
    const g = rules.llmJudge(check, { stage: 'tool_call', action: 'block' });
    await expect(applyAsync([g], 'tool_call', {}, tcCtx())).rejects.toBeInstanceOf(
      GuardrailTripped,
    );
  });

  it('reads the instruction from a metadata fallback', async () => {
    let seenSystem = '';
    const respond = (system: string) => {
      seenSystem = system;
      return '{"trip": false, "reason": "ok"}';
    };
    const ctx: Context = {
      stage: 'tool_call',
      tool: 't',
      toolArgs: {},
      metadata: { user_input: 'Only search.' },
    };
    await applyAsync(
      [rules.llmJudge(judge.taskAdherence(respond), { stage: 'tool_call', action: 'flag' })],
      'tool_call',
      {},
      ctx,
    );
    expect(seenSystem).toContain('Only search.');
  });

  it('fails open on a garbled judge reply', async () => {
    const check = judge.taskAdherence(() => 'not json at all');
    const g = rules.llmJudge(check, { stage: 'tool_call', action: 'flag' });
    const decs = await applyAsync([g], 'tool_call', {}, tcCtx());
    expect(decs).toHaveLength(1);
    expect(decs[0].action).toBe('flag');
    expect(decs[0].reason).toContain('fail-open');
  });

  it('handles a missing instruction', async () => {
    let seenSystem = '';
    const respond = (system: string) => {
      seenSystem = system;
      return '{"trip": false, "reason": "ok"}';
    };
    const ctx: Context = { stage: 'tool_call', tool: 't', toolArgs: {} };
    await applyAsync(
      [rules.llmJudge(judge.taskAdherence(respond), { stage: 'tool_call', action: 'flag' })],
      'tool_call',
      {},
      ctx,
    );
    expect(seenSystem).toContain('(no instruction provided)');
  });
});
