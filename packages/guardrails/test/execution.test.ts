/**
 * Execution-model maturity: per-guardrail on_error policy, async timeout, and the scoped() context
 * scope. No network — a "slow" check is a timer, a "failing" check throws. Mirrors the guardrails
 * Python `tests/test_execution.py` (sync-timeout cases omitted: JS has no threads, so `timeout`
 * applies to the async path only — documented on `Guardrail`).
 */
import { bus, instrument } from '@cendor/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GuardrailDecision, GuardrailTripped, Verdict } from '../src/decision.js';
import { applyAsync, defineGuardrail, evaluate, rules, scoped } from '../src/index.js';

beforeEach(() => bus._reset());
afterEach(() => bus._reset());

// Warm up the lazy AsyncLocalStorage install so the concurrency-isolation test is deterministic.
beforeAll(async () => {
  await scoped([], async () => {});
  await new Promise((r) => setTimeout(r, 20));
});

function collectDecisions(): GuardrailDecision[] {
  const out: GuardrailDecision[] = [];
  bus.subscribe((e) => {
    if (e instanceof GuardrailDecision) out.push(e);
  });
  return out;
}

// a check that always throws
function boom(): Verdict | null {
  throw new Error('judge unreachable');
}

// --------------------------------------------------------------------------- on_error

describe('on_error', () => {
  it('fail_closed treats a throwing check as a block (recorded as evidence)', async () => {
    const seen = collectDecisions();
    const g = rules.custom(boom, { onError: 'fail_closed' });
    await expect(applyAsync([g], 'input', 'hi')).rejects.toBeInstanceOf(GuardrailTripped);
    expect(seen.at(-1)?.action).toBe('block');
    expect(seen.at(-1)?.reason).toContain('errored');
  });

  it('fail_open flags and continues', async () => {
    const seen = collectDecisions();
    const g = rules.custom(boom, { onError: 'fail_open' });
    const out = await applyAsync([g], 'input', 'hi'); // does NOT throw
    expect(out.at(-1)?.action).toBe('flag');
    expect(out.at(-1)?.reason).toContain('fail-open');
    expect(seen.at(-1)?.action).toBe('flag');
  });

  it('default on_error derives from the action', () => {
    // a flag-action llmJudge defaults to fail_open; a block-action one to fail_closed
    expect(rules.llmJudge(boom, { action: 'flag' }).onError).toBe('fail_open');
    expect(rules.llmJudge(boom, { action: 'block' }).onError).toBe('fail_closed');
    // custom defaults to fail_closed (safe)
    expect(rules.custom(boom).onError).toBe('fail_closed');
  });

  it('the reason never leaks the payload', async () => {
    const seen = collectDecisions();
    const raiseWithSecret = (): Verdict | null => {
      throw new Error('noise');
    };
    await applyAsync(
      [rules.custom(raiseWithSecret, { onError: 'fail_open' })],
      'input',
      'sk-VERYSECRET',
    );
    expect(seen.at(-1)?.reason).not.toContain('sk-VERYSECRET');
  });

  it('a throwing sync check on the sync path honours on_error too', () => {
    const seen = collectDecisions();
    const { decisions } = evaluate([rules.custom(boom, { onError: 'fail_open' })], 'input', 'x');
    expect(decisions.at(-1)?.action).toBe('flag');
    expect(seen.at(-1)?.action).toBe('flag');
  });
});

// --------------------------------------------------------------------------- timeout (async)

describe('async timeout', () => {
  it('a slow async check trips on_error (fail_closed → block)', async () => {
    const slow = async (): Promise<Verdict | null> => {
      await new Promise((r) => setTimeout(r, 500));
      return null;
    };
    const g = rules.custom(slow, { timeout: 0.05, onError: 'fail_closed' });
    await expect(applyAsync([g], 'input', 'x')).rejects.toBeInstanceOf(GuardrailTripped);
  });

  it('a slow async check with fail_open flags instead of blocking', async () => {
    const slow = async (): Promise<Verdict | null> => {
      await new Promise((r) => setTimeout(r, 500));
      return new Verdict('block');
    };
    const out = await applyAsync(
      [rules.custom(slow, { timeout: 0.05, onError: 'fail_open' })],
      'input',
      'x',
    );
    expect(out.at(-1)?.action).toBe('flag');
  });

  it('no timeout runs to completion', async () => {
    const quick = async (): Promise<Verdict | null> => new Verdict('flag', 'ok');
    const out = await applyAsync([rules.custom(quick)], 'input', 'x');
    expect(out.at(-1)?.action).toBe('flag');
    expect(out.at(-1)?.reason).toBe('ok');
  });
});

// --------------------------------------------------------------------------- Guardrail validation

describe('validation', () => {
  it('defineGuardrail rejects an unknown on_error and a non-positive timeout', () => {
    expect(() => defineGuardrail(() => null, { onError: 'nonsense' as 'fail_open' })).toThrow(
      /unknown onError/,
    );
    expect(() => defineGuardrail(() => null, { timeout: 0 })).toThrow(/timeout must be positive/);
  });
});

// --------------------------------------------------------------------------- scoped()

function makeClient(): {
  client: { chat: { completions: { create: (k: Record<string, unknown>) => Promise<unknown> } } };
  calls: Record<string, unknown>[];
} {
  const calls: Record<string, unknown>[] = [];
  const completions = {
    create(kwargs: Record<string, unknown>) {
      calls.push(kwargs);
      return {
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
    },
  };
  const client = instrument({ chat: { completions } }) as {
    chat: { completions: { create: (k: Record<string, unknown>) => Promise<unknown> } };
  };
  return { client, calls };
}

const msg = (text: string) => [{ role: 'user', content: text }];

describe('scoped', () => {
  it('gates only inside the block ($0 on a pre-spend block)', async () => {
    const { client, calls } = makeClient();
    const gr = rules.keywordDeny(['forbidden'], { action: 'block' });
    await expect(
      scoped([gr], () =>
        client.chat.completions.create({ model: 'gpt-4o', messages: msg('forbidden') }),
      ),
    ).rejects.toBeInstanceOf(GuardrailTripped);
    expect(calls).toEqual([]); // $0 — the model was never called
    // outside the scope: the same call goes through
    await client.chat.completions.create({ model: 'gpt-4o', messages: msg('forbidden') });
    expect(calls).toHaveLength(1);
  });

  it('redacts before send', async () => {
    const { client, calls } = makeClient();
    const gr = rules.regexRule(/\bsk-[A-Za-z0-9]{16,}\b/, { action: 'redact', stage: 'input' });
    await scoped([gr], () =>
      client.chat.completions.create({
        model: 'gpt-4o',
        messages: msg('key sk-ABCD1234EFGH5678IJ'),
      }),
    );
    const sent = (calls.at(-1)?.messages as { content: string }[])[0]!.content;
    expect(sent).toContain('[redacted]');
    expect(sent).not.toContain('sk-ABCD');
  });

  it('nesting restores the outer scope', async () => {
    const { client, calls } = makeClient();
    const inner = rules.keywordDeny(['inner'], { action: 'block' });
    await scoped([rules.keywordDeny(['outer'], { action: 'block' })], async () => {
      // only "inner" trips here; "outer" does not
      await scoped([inner], () =>
        client.chat.completions.create({ model: 'gpt-4o', messages: msg('outer') }),
      );
      // back to the outer scope: "outer" trips again
      await expect(
        client.chat.completions.create({ model: 'gpt-4o', messages: msg('outer') }),
      ).rejects.toBeInstanceOf(GuardrailTripped);
    });
    expect(calls).toHaveLength(1); // the inner-scope call (with "outer" text) went through
  });

  it('isolates concurrent async tasks (AsyncLocalStorage)', async () => {
    const { client } = makeClient();
    const task = async (word: string): Promise<boolean> =>
      scoped([rules.keywordDeny([word], { action: 'block' })], async () => {
        await new Promise((r) => setTimeout(r, 0)); // yield so the tasks interleave
        try {
          await client.chat.completions.create({ model: 'gpt-4o', messages: msg('alpha') });
          return false;
        } catch (e) {
          if (e instanceof GuardrailTripped) return true;
          throw e;
        }
      });
    const [aBlocked, bBlocked] = await Promise.all([task('alpha'), task('beta')]);
    expect(aBlocked).toBe(true); // task A's scope denies "alpha"
    expect(bBlocked).toBe(false); // task B's scope denies "beta" only — "alpha" passes
  });
});
