/**
 * `instrument()` must not cost the provider SDK's response surface (N-1).
 *
 * openai-node and anthropic-node return an `APIPromise` — a Promise subclass whose `.asResponse()` /
 * `.withResponse()` are the documented way to read response headers (`x-request-id`, rate limits).
 * The wrapper was an `async` arrow, so every return was a *native* Promise and both methods became
 * `undefined`. Worse, `instrument<T>(client: T): T` preserves the client type, so TypeScript still
 * believed they existed: it type-checked and threw at runtime.
 *
 * Measured against the real SDK in `plan/evidence-cendor-libs-ripple-2026-07-26/`:
 * `UNinstrumented: ctor=APIPromise asResponse=function` / `instrumented: ctor=Promise asResponse=undefined`.
 *
 * What must NOT change while fixing it — each pinned below:
 *   * a **post-flight** subscriber throw (guardrails' output stage blocks *after* the call) still
 *     rejects the caller's promise. This is why the returned value cannot simply be the SDK's own
 *     promise with capture on a detached side branch;
 *   * an interceptor throw (tokenguard's pre-flight block) still **rejects**, never throws
 *     synchronously — the wrapper is no longer `async`, so that is not free;
 *   * ordering: the `LLMCall` is emitted before the caller's continuation resumes;
 *   * replay, Reroute and streaming keep working.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  type LLMCall,
  MISS,
  Reroute,
  Usage,
  addInterceptor,
  bus,
  instrument,
  removeInterceptor,
} from '../src/index.js';

let events: unknown[] = [];
beforeEach(() => {
  bus._reset();
  events = [];
  bus.subscribe((e) => events.push(e));
});
afterEach(() => bus._reset());

const BODY = {
  id: 'chatcmpl-1',
  model: 'gpt-4o-mini',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
  usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12 },
};

/** openai/anthropic's shape: a Promise **subclass** carrying the raw-response accessors. */
class FakeAPIPromise<T> extends Promise<T> {
  headers = new Map([['x-request-id', 'req_abc123']]);
  asResponse(): Promise<{ status: number; headers: Map<string, string> }> {
    return Promise.resolve({ status: 200, headers: this.headers });
  }
  withResponse(): Promise<{ data: T; response: { headers: Map<string, string> } }> {
    return this.then((data) => ({ data, response: { headers: this.headers } }));
  }
}

function apiPromise<T>(value: T): FakeAPIPromise<T> {
  return new FakeAPIPromise<T>((resolve) => resolve(value));
}

const ARGS = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] };

function client(create: (args: Record<string, unknown>) => unknown) {
  return instrument({ chat: { completions: { create } } });
}

// --- the surface itself ----------------------------------------------------------------------

it('keeps the SDK promise-subclass accessors reachable', async () => {
  const c = client(() => apiPromise(BODY));
  const returned = c.chat.completions.create(ARGS) as FakeAPIPromise<typeof BODY>;

  expect(typeof returned.asResponse).toBe('function');
  expect(typeof returned.withResponse).toBe('function');

  const body = await returned;
  expect(body.choices[0]?.message.content).toBe('ok');
  expect(events).toHaveLength(1);
  expect((events[0] as LLMCall).usage).toStrictEqual(
    new Usage({ inputTokens: 11, outputTokens: 1 }),
  );
});

it('withResponse() still yields headers after core has read the body', async () => {
  const c = client(() => apiPromise(BODY));
  const { data, response } = await (
    c.chat.completions.create(ARGS) as FakeAPIPromise<typeof BODY>
  ).withResponse();

  expect(data.choices[0]?.message.content).toBe('ok');
  expect(response.headers.get('x-request-id')).toBe('req_abc123');
  expect(events).toHaveLength(1); // captured exactly once, not once per accessor
});

it('leaves a plain-promise SDK exactly as it was', async () => {
  // gemini/ollama/HF return ordinary promises — no proxy, no behaviour change.
  const c = client(async () => BODY);
  const returned = c.chat.completions.create(ARGS);
  expect(returned).toBeInstanceOf(Promise);
  expect((await returned).choices[0]?.message.content).toBe('ok');
  expect(events).toHaveLength(1);
});

// --- what must not regress ------------------------------------------------------------------

it('a post-flight subscriber throw still rejects the caller', async () => {
  // guardrails' output stage inspects the COMPLETED call and raises on a block. That travels through
  // post() -> emit(), so it must still reach whoever awaited the call.
  bus.subscribe(() => {
    throw new Error('output blocked');
  });
  const c = client(() => apiPromise(BODY));
  await expect(c.chat.completions.create(ARGS)).rejects.toThrow('output blocked');
});

it('an interceptor throw rejects rather than throwing synchronously', () => {
  // tokenguard's pre-flight block / acttrace's guard. The wrapper is no longer `async`, so a bare
  // `throw` would surface synchronously and a caller doing `.catch(...)` without `await` would miss it.
  const blocker = () => {
    throw new Error('over budget');
  };
  addInterceptor(blocker);
  try {
    const c = client(() => apiPromise(BODY));
    let returned: unknown;
    expect(() => {
      returned = c.chat.completions.create(ARGS);
    }).not.toThrow();
    return expect(returned).rejects.toThrow('over budget');
  } finally {
    removeInterceptor(blocker);
  }
});

it('a client that throws synchronously still rejects', async () => {
  const c = client(() => {
    throw new Error('bad request');
  });
  await expect(c.chat.completions.create(ARGS)).rejects.toThrow('bad request');
  expect(events).toHaveLength(0);
});

it('a rejecting call rejects to the caller and emits nothing', async () => {
  const c = client(() => {
    const p = apiPromise(BODY);
    return p.then(() => {
      throw new Error('502');
    });
  });
  await expect(c.chat.completions.create(ARGS)).rejects.toThrow('502');
  expect(events).toHaveLength(0);
});

it('withResponse() on a failing call does not leave an unhandled rejection', async () => {
  // The caller may consume ONLY withResponse() and never await the returned promise. Our capture
  // chain must not then become an unobserved rejection and spam the process.
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const c = client(() => {
      const p = apiPromise(BODY);
      return p.then(() => {
        throw new Error('503');
      });
    });
    const returned = c.chat.completions.create(ARGS) as FakeAPIPromise<typeof BODY>;
    await expect(returned.withResponse()).rejects.toThrow('503');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(unhandled).toStrictEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

it('emits before the caller resumes', async () => {
  const seen: string[] = [];
  bus._reset();
  bus.subscribe(() => seen.push('emitted'));
  const c = client(() => apiPromise(BODY));
  await c.chat.completions.create(ARGS);
  seen.push('caller resumed');
  expect(seen).toStrictEqual(['emitted', 'caller resumed']);
});

it('replay still works through the interceptor seam', async () => {
  const replay = () => BODY;
  addInterceptor(replay);
  try {
    const c = client(() => {
      throw new Error('the real client must not be called on replay');
    });
    const out = (await c.chat.completions.create(ARGS)) as typeof BODY;
    expect(out.choices[0]?.message.content).toBe('ok');
    expect((events[0] as LLMCall).metadata.replayed).toBe(true);
  } finally {
    removeInterceptor(replay);
  }
});

it('Reroute still rewrites the request and returns the SDK surface', async () => {
  const seenArgs: Record<string, unknown>[] = [];
  const reroute = () => new Reroute({ model: 'gpt-4o-mini-cheap' });
  addInterceptor(reroute);
  try {
    const c = client((args) => {
      seenArgs.push(args);
      return apiPromise(BODY);
    });
    const returned = c.chat.completions.create(ARGS) as FakeAPIPromise<typeof BODY>;
    expect(typeof returned.withResponse).toBe('function');
    await returned;
    expect(seenArgs[0]?.model).toBe('gpt-4o-mini-cheap');
    expect((events[0] as LLMCall).model).toBe('gpt-4o-mini-cheap');
  } finally {
    removeInterceptor(reroute);
  }
});

it('a streamed call still yields a wrapped stream (its SDK surface is a documented limit)', async () => {
  async function* chunks() {
    yield { choices: [{ delta: { content: 'ok' } }], usage: null };
    yield { choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } };
  }
  const c = client(() => apiPromise(chunks()));
  const stream = await c.chat.completions.create({ ...ARGS, stream: true });
  const got = [];
  for await (const chunk of stream as AsyncIterable<unknown>) got.push(chunk);

  expect(got).toHaveLength(2);
  expect((events[0] as LLMCall).usage).toStrictEqual(
    new Usage({ inputTokens: 7, outputTokens: 2 }),
  );
});

it('responses.parse is NOT a second target — it is a helper built on create()', async () => {
  // Corrected 2026-07-27 by measuring the real SDK. This test used to assert that `parse` was its
  // own instrument() target, "for parity with Python 1.14.1" — but the fake below (a `parse` that
  // returns its own promise) cannot express what openai-node actually does. There, `parse` is
  //   `this._client.responses.create(...)._thenUnwrap(...)`
  // so a second target counts one request twice, and the real failure was worse than a miscount:
  // `TypeError: Body is unusable`. The delegating case — the one that matters — is covered in
  // `sdk-helper-methods.test.ts`; here we only pin that one call is never two.
  const c = instrument({
    responses: {
      create: () => apiPromise({ usage: { input_tokens: 1, output_tokens: 1 } }),
      parse: () => apiPromise({ usage: { input_tokens: 14, output_tokens: 2 } }),
    },
  });
  await c.responses.parse({ model: 'gpt-4o-mini', input: 'say ok' });

  expect(events.length).toBeLessThanOrEqual(1);
  await c.responses.create({ model: 'gpt-4o-mini', input: 'say ok' });
  const call = events.at(-1) as LLMCall;
  expect(call.provider).toBe('openai');
  expect(call.usage).toStrictEqual(new Usage({ inputTokens: 1, outputTokens: 1 }));
});

it('a client without responses.parse is untouched', async () => {
  const c = instrument({
    responses: { create: () => apiPromise({ usage: { input_tokens: 3, output_tokens: 1 } }) },
  });
  await c.responses.create({ model: 'gpt-4o-mini', input: 'hi' });
  expect((events[0] as LLMCall).usage).toStrictEqual(
    new Usage({ inputTokens: 3, outputTokens: 1 }),
  );
});

it('an interceptor still sees the call before the client runs', () => {
  const calls: unknown[] = [];
  const spy = vi.fn((call: unknown) => {
    calls.push(call);
    return MISS;
  });
  addInterceptor(spy);
  try {
    const c = client(() => apiPromise(BODY));
    c.chat.completions.create(ARGS);
    expect(spy).toHaveBeenCalledTimes(1); // synchronously, in the caller's frame
  } finally {
    removeInterceptor(spy);
  }
});
