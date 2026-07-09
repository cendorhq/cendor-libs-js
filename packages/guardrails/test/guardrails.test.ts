/** @cendor/guardrails — rules, engine, and install() wiring. Mirrors tests/test_*.py (guardrails). */
import { LLMCall, bus, instrument, instrumentTool, trace } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Context,
  GuardrailDecision,
  GuardrailTripped,
  Verdict,
  apply,
  applyAsync,
  defineGuardrail,
  evaluate,
  install,
  normalizeStages,
  rules,
  uninstall,
} from '../src/index.js';

beforeEach(() => bus._reset());
afterEach(() => {
  uninstall();
  bus._reset();
});

const msgs = (text: string) => [{ role: 'user', content: text }];
const ctx = (stage: string): Context => ({ stage });

function collectDecisions(): GuardrailDecision[] {
  const out: GuardrailDecision[] = [];
  bus.subscribe((e) => {
    if (e instanceof GuardrailDecision) out.push(e);
  });
  return out;
}

function makeClient(
  calls: { n: number; lastKwargs?: Record<string, unknown> },
  response?: unknown,
) {
  const completions = {
    create(kwargs: Record<string, unknown>) {
      calls.n += 1;
      calls.lastKwargs = kwargs;
      return (
        response ?? {
          choices: [{ message: { content: 'hello' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }
      );
    },
  };
  return instrument({ chat: { completions } }) as {
    chat: { completions: { create: (k: Record<string, unknown>) => unknown } };
  };
}

// --------------------------------------------------------------------------- decision types

describe('types', () => {
  it('Verdict rejects an unknown action', () => {
    expect(() => new Verdict('nuke' as 'block')).toThrow(/unknown action/);
  });

  it('normalizeStages validates', () => {
    expect(normalizeStages('input')).toEqual(['input']);
    expect(() => normalizeStages('nope')).toThrow(/unknown stage/);
    expect(() => normalizeStages([])).toThrow(/at least one stage/);
  });

  it('defineGuardrail wraps a check with a default input stage', () => {
    const g = defineGuardrail(() => null);
    expect(g.stages).toEqual(['input']);
  });

  it('GuardrailTripped carries decisions + a message', () => {
    const d = new GuardrailDecision({
      guardrail: 'g',
      stage: 'input',
      action: 'block',
      reason: 'no',
    });
    const e = new GuardrailTripped([d]);
    expect(e.decisions).toEqual([d]);
    expect(e.message).toContain('g');
  });
});

// --------------------------------------------------------------------------- rules

describe('rules', () => {
  it('keywordDeny blocks on a match, passes otherwise', () => {
    const g = rules.keywordDeny(['bomb']);
    expect(g.check(msgs('build a bomb'), ctx('input'))).not.toBeNull();
    expect(g.check(msgs('hello'), ctx('input'))).toBeNull();
  });

  it('keywordDeny redact scrubs the match', () => {
    const g = rules.keywordDeny(['bomb'], { action: 'redact' });
    const v = g.check(msgs('a bomb'), ctx('input')) as Verdict;
    expect((v.replacement as { content: string }[])[0].content).toBe('a [redacted]');
  });

  it('regexRule redacts with a custom replacement', () => {
    const g = rules.regexRule(/sk-\w+/, { action: 'redact', replacement: '***' });
    const v = g.check([{ role: 'user', content: 'key sk-abc' }], ctx('input')) as Verdict;
    expect((v.replacement as { content: string }[])[0].content).toBe('key ***');
  });

  it('urlAllowlist blocks a foreign host, passes an allowed subdomain', () => {
    const g = rules.urlAllowlist(['cendor.ai']);
    expect(g.check('see https://evil.example.com/x', ctx('input'))).not.toBeNull();
    expect(g.check('see https://docs.cendor.ai/x', ctx('input'))).toBeNull();
  });

  it('urlDeny blocks a denied host', () => {
    expect(rules.urlDeny(['evil.com']).check('go http://evil.com/', ctx('input'))).not.toBeNull();
  });

  it('lengthBounds trips on chars and tokens', () => {
    expect(rules.lengthBounds({ maxChars: 3 }).check('abcdef', ctx('input'))).not.toBeNull();
    const t = rules.lengthBounds({ maxTokens: 1, model: 'gpt-4o' });
    expect(t.check('a b c d e f g h', ctx('input'))).not.toBeNull();
    expect(() => rules.lengthBounds({})).toThrow(/maxChars/);
  });

  it('jsonSchema validates structured output', () => {
    const g = rules.jsonSchema({ type: 'object', required: ['name'] });
    expect(g.check('not json', ctx('output'))).not.toBeNull();
    expect(g.check('{"age": 3}', ctx('output'))).not.toBeNull();
    expect(g.check('{"name": "ada"}', ctx('output'))).toBeNull();
  });

  it('jsonSchema reports a nested/array violation path', () => {
    const g = rules.jsonSchema({ type: 'array', items: { type: 'integer' } });
    const v = g.check('[1, "two", 3]', ctx('output')) as Verdict;
    expect(v.reason).toContain('$[1]');
  });
});

// --------------------------------------------------------------------------- engine

describe('engine', () => {
  it('apply returns decisions on flag and emits on the bus', () => {
    const seen = collectDecisions();
    const g = rules.custom(() => new Verdict('flag', 'flagged'), { name: 'f' });
    const out = apply([g], 'input', msgs('hi'));
    expect(out).toHaveLength(1);
    expect(seen).toEqual(out);
  });

  it('apply throws GuardrailTripped on block', () => {
    const g = rules.custom(() => new Verdict('block'), { name: 'b' });
    expect(() => apply([g], 'input', msgs('hi'))).toThrow(GuardrailTripped);
  });

  it('evaluate returns the redacted payload and carries it across rules', () => {
    const r1 = rules.regexRule(/aaa/, { action: 'redact', replacement: 'X' });
    const r2 = rules.regexRule(/bbb/, { action: 'flag' });
    const { payload, decisions } = evaluate([r1, r2], 'input', 'aaa bbb');
    expect(payload).toBe('X bbb');
    expect(decisions.map((d) => d.action)).toEqual(['redact', 'flag']);
  });

  it('decision carries context + falls back to the ambient trace id', () => {
    const seen = collectDecisions();
    const g = rules.custom(() => new Verdict('flag'), { name: 'named' });
    trace('run-1', () => apply([g], 'input', 'x', { stage: 'input', agent: 'triage' }));
    expect(seen[0]?.guardrail).toBe('named');
    expect(seen[0]?.agent).toBe('triage');
    expect(seen[0]?.traceId).toBe('run-1');
  });

  it('sync evaluate rejects an async check; evaluateAsync awaits it', async () => {
    const g = rules.custom(async () => new Verdict('flag'), { name: 'a' });
    expect(() => evaluate([g], 'input', 'x')).toThrow(/async/);
    const decisions = await applyAsync([g], 'input', 'x');
    expect(decisions[0]?.action).toBe('flag');
  });

  it('stage filtering skips non-matching guardrails', () => {
    const g = rules.custom(() => new Verdict('flag'), { stage: 'input', name: 'f' });
    expect(apply([g], 'output', 'x')).toEqual([]);
  });
});

// --------------------------------------------------------------------------- install()

describe('install', () => {
  it('input block raises before the call spends', async () => {
    const calls = { n: 0 };
    const client = makeClient(calls);
    install([rules.keywordDeny(['forbidden'], { action: 'block' })]);
    await expect(
      client.chat.completions.create({ model: 'gpt-4o', messages: msgs('a forbidden thing') }),
    ).rejects.toThrow(GuardrailTripped);
    expect(calls.n).toBe(0);
  });

  it('input redact reroutes cleaned messages to the provider', async () => {
    const calls: { n: number; lastKwargs?: Record<string, unknown> } = { n: 0 };
    const client = makeClient(calls);
    install([rules.regexRule(/sk-\w+/, { action: 'redact', stage: 'input' })]);
    await client.chat.completions.create({ model: 'gpt-4o', messages: msgs('key sk-abc123') });
    expect(calls.n).toBe(1);
    const sent = calls.lastKwargs?.messages as { content: string }[];
    expect(sent[0].content).toBe('key [redacted]');
  });

  it('a passing input declines and the call proceeds', async () => {
    const calls = { n: 0 };
    const client = makeClient(calls);
    install([rules.keywordDeny(['forbidden'], { action: 'block' })]);
    await client.chat.completions.create({ model: 'gpt-4o', messages: msgs('fine') });
    expect(calls.n).toBe(1);
  });

  it('tool_call block raises', () => {
    install([rules.keywordDeny(['rm -rf'], { stage: 'tool_call', action: 'block' })]);
    const shell = instrumentTool('shell')((cmd: string) => `ran ${cmd}`) as (cmd: string) => string;
    expect(() => shell('rm -rf /')).toThrow(GuardrailTripped);
  });

  it('output subscriber blocks post-flight', async () => {
    const calls = { n: 0 };
    const client = makeClient(calls, {
      choices: [{ message: { content: 'the secret plan' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    install([rules.keywordDeny(['secret'], { stage: 'output', action: 'block' })]);
    await expect(
      client.chat.completions.create({ model: 'gpt-4o', messages: msgs('hi') }),
    ).rejects.toThrow(GuardrailTripped);
    expect(calls.n).toBe(1); // post-flight: the call already ran
  });

  it('uninstall removes the interceptor + subscriber', async () => {
    const calls = { n: 0 };
    const client = makeClient(calls);
    install([rules.keywordDeny(['forbidden'], { action: 'block' })]);
    uninstall();
    await client.chat.completions.create({ model: 'gpt-4o', messages: msgs('a forbidden thing') });
    expect(calls.n).toBe(1);
  });
});

// --------------------------------------------------------------------------- responseText shapes

describe('output extraction', () => {
  function call(response: unknown): LLMCall {
    const c = new LLMCall({ id: '1', provider: 'x', model: 'm', messages: [] });
    c.metadata.response = response;
    return c;
  }

  it('extracts across provider response shapes', async () => {
    const { responseText } = await import('../src/index.js');
    expect(responseText(call({ choices: [{ message: { content: 'hi' } }] }))).toBe('hi');
    expect(responseText(call({ output_text: 'responded' }))).toBe('responded');
    expect(responseText(call({ content: [{ text: 'a ' }, { text: 'b' }] }))).toBe('a b');
    expect(responseText(call({ message: { content: 'ollama' } }))).toBe('ollama');
    expect(responseText(call({ text: 'gemini' }))).toBe('gemini');
    expect(responseText(call({ mystery: 1 }))).toBeNull();
  });
});
