/**
 * The output gate must fire whichever way the caller consumes the response — including through an
 * SDK **helper method** built on `create(...)._thenUnwrap(...)`.
 *
 * This was a documented OPEN defect (`guardrails.md`, N-6, since 2026-07-27): the same client with the
 * same `install()`, in the same process, blocked a direct `await create(...)` and **delivered the
 * banned text** when the same response was consumed through `responses.parse` /
 * `chat.completions.parse` / `runTools` — i.e. through everything a TypeScript
 * `withStructuredOutput()` call uses.
 *
 * MECHANISM (measured — `plan/evidence-gapclose-2026-07-31/s3_probe_output_gate_helper.mjs`; the
 * earlier investigation's reading was wrong and that is why an attempted fix had not closed it):
 * the gate DID run on the helper path and DID decide `block` — a `GuardrailDecision`
 * `keyword_deny:block` was emitted on the bus every time. Its exception rejected core's capture
 * chain, which core deliberately marks handled so that a `withResponse()`-only caller gets no noisy
 * unhandled-rejection warning. But `_thenUnwrap` derives a new promise from the **SDK's own** object,
 * so the promise the caller awaited had never touched that chain. The gate was never the problem.
 *
 * Fixed in `@cendor/core` 3.3.0 by gating the derived promise. These tests live here rather than in
 * core because the defect is only observable with a real guardrail installed.
 */
import { LLMCall, bus, instrument } from '@cendor/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GuardrailTripped, install, rules, uninstall } from '../src/index.js';

const BANNED = {
  id: 'r',
  model: 'gpt-4o',
  choices: [{ index: 0, message: { role: 'assistant', content: 'a forbidden answer' } }],
  usage: { prompt_tokens: 5, completion_tokens: 4 },
};

const CLEAN = {
  id: 'r',
  model: 'gpt-4o',
  choices: [{ index: 0, message: { role: 'assistant', content: 'a fine answer' } }],
  usage: { prompt_tokens: 5, completion_tokens: 4 },
};

/**
 * openai's `APIPromise`, faithfully: a `parseResponse` step, a memoized `parse()`, and a
 * `_thenUnwrap` that returns a **new APIPromise** (not a plain promise — that is what keeps
 * `asResponse()` reachable on a `parse()` result, and a fake that got it wrong would under-test the
 * gating wrapper).
 */
function makeClient(body: unknown) {
  class FakeAPIPromise<T> extends Promise<T> {
    parseResponse: () => unknown;
    private parsed?: Promise<unknown>;

    constructor(
      executor: (resolve: (v: T) => void, reject: (e: unknown) => void) => void,
      parseResponse: () => unknown = () => body,
    ) {
      super(executor);
      this.parseResponse = parseResponse;
    }

    // biome-ignore lint/suspicious/noThenProperty: deliberately modelling openai's APIPromise
    override then<TResult1 = T, TResult2 = never>(
      onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return this.parseOnce().then(onfulfilled as never, onrejected);
    }

    parseOnce(): Promise<unknown> {
      if (!this.parsed) this.parsed = Promise.resolve(this.parseResponse());
      return this.parsed;
    }

    _thenUnwrap<U>(transform: (value: unknown) => U): FakeAPIPromise<U> {
      return new FakeAPIPromise<U>(
        (res) => res(null as unknown as U),
        async () => transform(await this.parseResponse()),
      );
    }

    asResponse(): Promise<{ headers: Map<string, string> }> {
      return Promise.resolve({ headers: new Map([['x-request-id', 'req_1']]) });
    }
  }

  const completions = {
    create: (_k: unknown): FakeAPIPromise<unknown> =>
      new FakeAPIPromise((res) => res(null as unknown)),
    // exactly openai's `resources/chat/completions/completions.js`
    parse: (k: unknown): FakeAPIPromise<unknown> =>
      completions
        .create(k)
        ._thenUnwrap((raw) => ({ ...(raw as Record<string, unknown>), parsed: true })),
  };
  return instrument({ chat: { completions } });
}

const ARGS = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };

function gate(): void {
  install([rules.keywordDeny(['forbidden'], { action: 'block', stage: 'output' })]);
}

let decisions: unknown[];
beforeEach(() => {
  bus._reset();
  decisions = [];
  bus.subscribe((e) => {
    if (e && typeof e === 'object' && 'guardrail' in e) decisions.push(e);
  });
});
afterEach(() => {
  uninstall();
  bus._reset();
});

describe('the output gate and SDK helper methods', () => {
  it('blocks a direct await (the control that always worked)', async () => {
    const c = makeClient(BANNED);
    gate();
    await expect(c.chat.completions.create(ARGS)).rejects.toThrow(GuardrailTripped);
  });

  it('blocks a response consumed through create()._thenUnwrap() — the N-6 defect', async () => {
    const c = makeClient(BANNED);
    gate();
    await expect(c.chat.completions.parse(ARGS)).rejects.toThrow(GuardrailTripped);
  });

  it('emitted its decision on the bus all along (the mechanism, pinned)', async () => {
    // This is what made the old reading wrong: the gate ran and blocked; the caller just awaited a
    // promise that had never touched cendor's chain. If a future refactor "fixes" the caller by
    // stopping the gate from running, this assertion catches it.
    const c = makeClient(BANNED);
    gate();
    await expect(c.chat.completions.parse(ARGS)).rejects.toThrow(GuardrailTripped);
    expect(decisions).toHaveLength(1);
    expect((decisions[0] as { action: string }).action).toBe('block');
  });

  it('chains through a nested _thenUnwrap (parse-on-parse) too', async () => {
    const c = makeClient(BANNED);
    gate();
    const nested = (
      c.chat.completions.parse(ARGS) as unknown as {
        _thenUnwrap(t: (v: unknown) => unknown): Promise<unknown>;
      }
    )._thenUnwrap((v) => v);
    await expect(nested).rejects.toThrow(GuardrailTripped);
  });
});

describe('what must NOT change', () => {
  it('resolves normally when no gate is installed', async () => {
    const c = makeClient(BANNED);
    const out = (await c.chat.completions.parse(ARGS)) as { parsed: boolean };
    expect(out.parsed).toBe(true); // the SDK's own transform still ran
    expect(decisions).toHaveLength(0);
  });

  it('resolves when a gate is installed and the text is clean', async () => {
    const c = makeClient(CLEAN);
    gate();
    const out = (await c.chat.completions.parse(ARGS)) as { parsed: boolean };
    expect(out.parsed).toBe(true);
  });

  it('still captures the call exactly once', async () => {
    const calls: LLMCall[] = [];
    bus.subscribe((e) => {
      if (e instanceof LLMCall) calls.push(e);
    });
    const c = makeClient(CLEAN);
    await c.chat.completions.parse(ARGS);
    expect(calls).toHaveLength(1);
  });

  it('keeps the SDK’s own extras reachable on a parse() result', async () => {
    // The gating wrapper is a proxy, not a plain promise — `asResponse()` (the documented way to read
    // response headers) has to survive it.
    const c = makeClient(CLEAN);
    gate();
    const p = c.chat.completions.parse(ARGS) as unknown as {
      asResponse(): Promise<{ headers: Map<string, string> }>;
    };
    const res = await p.asResponse();
    expect(res.headers.get('x-request-id')).toBe('req_1');
  });

  it('does not leave an unhandled rejection when the caller only reads headers', async () => {
    const c = makeClient(BANNED);
    gate();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const p = c.chat.completions.parse(ARGS) as unknown as {
        asResponse(): Promise<unknown>;
      };
      await p.asResponse();
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});
